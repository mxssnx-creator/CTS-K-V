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
 * The engine stores indications as JSON arrays in:
 *   indication_set:{connId}:{symbol}:{type}:{...config}
 *
 * Each entry has: { id, timestamp, type, direction, profitFactor, confidence, config, metadata }
 *
 * We scan up to 500 keys (bounded), read each array, and surface the most
 * recent entry per key as a displayable Indication record.
 */
async function getRealIndications(connectionId: string): Promise<Indication[]> {
  try {
    await initRedis()
    const client = getRedisClient()
    if (!client) return []

    // Bounded scan of indication_set keys for this connection
    const prefix = `indication_set:${connectionId}:`
    const allKeys: string[] = await client.keys(`${prefix}*`).catch(() => [] as string[])
    if (!allKeys || allKeys.length === 0) return []

    // Limit to 500 keys to keep reads bounded
    const keys = allKeys.slice(0, 500)

    const indications: Indication[] = []

    // Read each key's JSON array and extract the most recent (last) entry
    const values = await Promise.all(keys.map((k) => client.get(k).catch(() => null)))

    for (let i = 0; i < keys.length; i++) {
      const raw = values[i]
      if (!raw) continue
      let entries: any[]
      try {
        entries = JSON.parse(raw as string)
      } catch {
        continue
      }
      if (!Array.isArray(entries) || entries.length === 0) continue

      // Parse key to extract symbol and type
      // Key format: indication_set:{connId}:{symbol}:{type}:{...rest}
      const keyWithoutPrefix = keys[i].slice(prefix.length) // e.g. "BTCUSDT:direction:r10:..."
      const parts = keyWithoutPrefix.split(":")
      const symbol = parts[0] ?? "UNKNOWN"
      const indType = parts[1] ?? "unknown"

      // Most recent entry is last (entries are push()'d newest-at-last)
      const entry = entries[entries.length - 1]

      const direction =
        entry.direction === "short" ? "DOWN" : entry.direction === "long" ? "UP" : "NEUTRAL"

      indications.push({
        id: entry.id || `${symbol}-${indType}-${i}`,
        symbol,
        indicationType: indType.charAt(0).toUpperCase() + indType.slice(1),
        direction: direction as "UP" | "DOWN" | "NEUTRAL",
        confidence: Math.min(100, Math.max(0, Number(entry.confidence) || 50)),
        strength: Math.min(100, Math.max(0, Number(entry.profitFactor ?? entry.confidence) * 10 || 50)),
        timestamp: entry.timestamp || new Date().toISOString(),
        enabled: true,
        metadata: {
          rsiValue: entry.metadata?.rsi ? Number(entry.metadata.rsi) : undefined,
          macdValue: entry.metadata?.macd ? Number(entry.metadata.macd) : undefined,
          volatility: entry.metadata?.volatility ? Number(entry.metadata.volatility) : undefined,
        },
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
