import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Indication {
  id: string
  symbol: string
  indicationType: string
  direction: "UP" | "DOWN" | "NEUTRAL"
  confidence: number
  strength: number
  timestamp: string
  enabled: boolean
  metadata?: {
    macdValue?: number
    rsiValue?: number
    maValue?: number
    bbUpper?: number
    bbLower?: number
    volatility?: number
  }
}

function generateMockIndications(connectionId: string): Indication[] {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AAPL", "EURUSD", "XAUUSD"]
  const types = ["Momentum", "Volatility", "Trend", "Mean Reversion", "Volume"]
  const directions: ("UP" | "DOWN" | "NEUTRAL")[] = ["UP", "DOWN", "NEUTRAL"]

  return Array.from({ length: 200 }, (_, i) => {
    const now = new Date()
    const minutesAgo = Math.floor(Math.random() * 60)
    const timestamp = new Date(now.getTime() - minutesAgo * 60000).toISOString()

    return {
      id: `ind-${connectionId}-${i}`,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      indicationType: types[Math.floor(Math.random() * types.length)],
      direction: directions[Math.floor(Math.random() * directions.length)],
      confidence: 30 + Math.random() * 70,
      strength: Math.random() * 100,
      timestamp,
      enabled: Math.random() > 0.3,
      metadata: {
        rsiValue: 30 + Math.random() * 40,
        macdValue: (Math.random() - 0.5) * 0.01,
        volatility: 15 + Math.random() * 30,
      },
    }
  })
}

/**
 * Read real indications from the canonical engine keyspace.
 *
 * The engine stores indications via IndicationConfigManager:
 *   Config key:   indication:{connId}:config:{configId}       — JSON: { id, type, enabled, ... }
 *   Results key:  indication:{connId}:config:{configId}:results — list of pipe-delimited strings:
 *                 "timestamp|symbol|value|signal" (signal = buy|sell|neutral)
 *
 * We read all config keys (bounded to 500), fetch the most-recent result per
 * config, and surface each as a displayable Indication record.  We use
 * client.keys() here because this is an internal-only route and the key count
 * is bounded by the number of indication configs (~50–200 per connection).
 */
async function getRealIndications(connectionId: string): Promise<Indication[]> {
  try {
    await initRedis()
    const client = getRedisClient()
    if (!client) return []

    // Fetch all config keys for this connection (excludes :results suffix)
    const configPattern = `indication:${connectionId}:config:*`
    const allKeys: string[] = await (client.keys(configPattern) as Promise<string[]>).catch(() => [] as string[])

    // Filter to only bare config keys (not the :results sub-keys)
    const configKeys = allKeys
      .filter((k) => !k.endsWith(":results"))
      .slice(0, 500)

    if (configKeys.length === 0) return []

    // Fetch config JSON and most-recent result entry in parallel
    const [configs, latestResults] = await Promise.all([
      Promise.all(configKeys.map((k) => client.get(k).catch(() => null))),
      Promise.all(
        configKeys.map((k) =>
          (client.lrange(`${k}:results`, 0, 0) as Promise<string[]>)
            .then((arr) => arr?.[0] ?? null)
            .catch(() => null)
        )
      ),
    ])

    const indications: Indication[] = []

    for (let i = 0; i < configKeys.length; i++) {
      // Parse config
      let config: any = null
      try {
        const raw = configs[i]
        config = raw ? JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) : null
      } catch {
        continue
      }
      if (!config) continue

      const configId = config.id || configKeys[i].split(":").pop() || `config-${i}`
      const indType: string = config.type || "Unknown"
      const enabled: boolean = config.enabled !== false

      // Parse most-recent result (pipe-delimited: timestamp|symbol|value|signal)
      const resultRaw = latestResults[i]
      let symbol = "UNKNOWN"
      let signal: string = "neutral"
      let timestamp = new Date().toISOString()

      if (resultRaw && typeof resultRaw === "string") {
        const parts = resultRaw.split("|")
        timestamp = parts[0] || timestamp
        symbol = parts[1] || symbol
        // parts[2] = value (numeric, unused for display)
        signal = parts[3] || "neutral"
      } else {
        // Config exists but no results yet — still show the config so the UI
        // can display enabled/disabled state for each indicator type.
        // Skip configs with no result rows to avoid cluttering the list.
        continue
      }

      const direction: "UP" | "DOWN" | "NEUTRAL" =
        signal === "buy" ? "UP" : signal === "sell" ? "DOWN" : "NEUTRAL"

      // Derive a confidence proxy: use the stored value field scaled to 0–100.
      // For most indicator types the value is an oscillator (RSI 0-100) or a
      // small delta; we normalise to a 0-100 display range.
      const rawValue = parseFloat(resultRaw.split("|")[2] || "0") || 0
      const normalizedConf = Math.min(100, Math.max(0, Math.abs(rawValue) > 1 ? rawValue : rawValue * 100))

      indications.push({
        id: `${connectionId}-${configId}`,
        symbol,
        indicationType: indType.charAt(0).toUpperCase() + indType.slice(1),
        direction,
        confidence: normalizedConf,
        strength: normalizedConf,
        timestamp,
        enabled,
        metadata: {},
      })
    }

    return indications
  } catch (error) {
    console.error(`[v0] Failed to get real indications for ${connectionId}:`, error)
    return []
  }
}

export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId query parameter required" }, { status: 400 })
    }

    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let indications: Indication[] = []

    if (isDemo) {
      indications = generateMockIndications(connectionId)
    } else {
      indications = await getRealIndications(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: indications,
      isDemo,
      connectionId,
      count: indications.length,
    })
  } catch (error) {
    console.error("[v0] Get indications error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
