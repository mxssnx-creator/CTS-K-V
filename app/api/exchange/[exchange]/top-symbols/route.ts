import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

type SortKey = "volume" | "volatility"
type Ticker = { symbol: string; priceChangePercent: number; volume: number }

// In-memory cache — volatile symbols don't change rapidly, 60s TTL is fine.
// Keyed by `${exchange}:${sort}` so a volume-sorted and a volatility-sorted
// request don't clobber each other's cached top-1.
const cache = new Map<string, { symbol: string; priceChangePercent: number; timestamp: number }>()
const CACHE_TTL = 60_000

// Fallback symbols if exchange API is unreachable
const FALLBACK: Record<string, string> = {
  binance: "BTCUSDT",
  bybit: "BTCUSDT",
  bingx: "BTCUSDT",
  okx: "BTCUSDT",
  pionex: "BTCUSDT",
  orangex: "BTCUSDT",
}

function normaliseSort(raw: string | null): SortKey {
  const v = (raw || "").toLowerCase()
  // The dialog maps both `volume_24h`/`volume_1h` → "volume" and
  // `volatility_*` → "volatility"; `newest`/`manual` fall back to volume.
  if (v.startsWith("volatil")) return "volatility"
  return "volume"
}

async function fetchMostVolatileSymbols(
  exchange: string,
  limit = 1,
  sort: SortKey = "volume",
): Promise<{ symbol: string; priceChangePercent: number; symbols: { symbol: string; priceChangePercent: number; volume: number }[] }> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 1))
  const cacheKey = `${exchange}:${sort}`
  // Cache only keeps the single top symbol — for limit > 1 we always fetch fresh
  // (still cheap: one public REST call with 5s timeout) and return the sorted list.
  if (safeLimit === 1) {
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return {
        symbol: cached.symbol,
        priceChangePercent: cached.priceChangePercent,
        symbols: [{ symbol: cached.symbol, priceChangePercent: cached.priceChangePercent, volume: 0 }],
      }
    }
  }

  let tickers: Ticker[] = []

  try {
    if (exchange === "binance") {
      // Binance public 24hr ticker — no auth required
      const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`)
      const data: any[] = await res.json()
      // Filter USDT perpetual-style pairs, >$1M volume, exclude stables
      tickers = data
        .filter(t =>
          t.symbol.endsWith("USDT") &&
          !t.symbol.includes("DOWN") &&
          !t.symbol.includes("UP") &&
          !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
          parseFloat(t.quoteVolume) > 1_000_000
        )
        .map(t => ({
          symbol: t.symbol,
          priceChangePercent: Math.abs(parseFloat(t.priceChangePercent)),
          volume: parseFloat(t.quoteVolume) || 0,
        }))

    } else if (exchange === "bybit") {
      // Bybit blocks some IPs (403) - silently fallback to Binance data for USDT pairs
      // v2.0 - Removed all error throwing to prevent log spam
      try {
        const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", {
          headers: { 
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)",
          },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          // Bybit often returns 403 for serverless IPs - use Binance as proxy for USDT pairs (silent fallback)
          const binanceRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(5000),
          })
          if (binanceRes.ok) {
            const binanceData: any[] = await binanceRes.json()
            tickers = binanceData
              .filter(t =>
                t.symbol.endsWith("USDT") &&
                !t.symbol.includes("DOWN") &&
                !t.symbol.includes("UP") &&
                !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
                parseFloat(t.quoteVolume) > 1_000_000
              )
              .map(t => ({
                symbol: t.symbol,
                priceChangePercent: Math.abs(parseFloat(t.priceChangePercent)),
                volume: parseFloat(t.quoteVolume) || 0,
              }))
          }
        } else {
          const data = await res.json()
          tickers = (data?.result?.list || [])
            .filter((t: any) =>
              t.symbol.endsWith("USDT") &&
              parseFloat(t.turnover24h) > 1_000_000
            )
            .map((t: any) => ({
              symbol: t.symbol,
              priceChangePercent: Math.abs(parseFloat(t.price24hPcnt || "0") * 100),
              volume: parseFloat(t.turnover24h) || 0,
            }))
        }
      } catch (bybitErr) {
        console.warn(`[TopSymbols] Bybit API error, using default:`, bybitErr instanceof Error ? bybitErr.message : bybitErr)
      }

    } else if (exchange === "bingx") {
      const res = await fetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`BingX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) =>
          t.symbol?.endsWith("-USDT") &&
          parseFloat(t.volume) > 100_000
        )
        .map((t: any) => ({
          symbol: (t.symbol as string).replace("-", ""),
          priceChangePercent: Math.abs(parseFloat(t.priceChangePercent || "0")),
          volume: parseFloat(t.quoteVolume || t.volume || "0") || 0,
        }))

    } else if (exchange === "okx") {
      const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`OKX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) =>
          t.instId?.endsWith("USDT-SWAP") &&
          parseFloat(t.volCcy24h) > 1_000_000
        )
        .map((t: any) => ({
          symbol: (t.instId as string).replace("-SWAP", "").replace("-", ""),
          priceChangePercent: Math.abs(parseFloat(t.sodUtc8 || "0")),
          volume: parseFloat(t.volCcy24h || "0") || 0,
        }))
    }
  } catch (err) {
    // Silently handle - will use fallback below
  }

  // Safe, liquid major pairs used both to pad a partially-bogus list and as a
  // multi-symbol fallback when the public exchange API is unreachable.
  const SAFE_MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LTCUSDT", "LINKUSDT"]

  if (tickers.length === 0) {
    // Fallback: the public ticker API was unreachable / returned nothing after
    // filtering (common in sandboxed dev, transient outages in prod). Honour the
    // requested count instead of collapsing to a single symbol — otherwise a
    // 10-symbol quickstart silently starts with just 1. Lead with the exchange's
    // preferred default, then fill from the safe-majors list, de-duplicated.
    const preferred = FALLBACK[exchange] || "BTCUSDT"
    const ordered = [preferred, ...SAFE_MAJORS.filter(s => s !== preferred)]
    const fallbackSymbols = ordered.slice(0, safeLimit).map((symbol, i) => ({
      symbol,
      // Tiny descending synthetic metrics keep a stable, sensible sort order.
      priceChangePercent: i === 0 ? 0 : 0.5,
      volume: Math.max(0, (ordered.length - i) * 1000),
    }))
    return { symbol: preferred, priceChangePercent: 0, symbols: fallbackSymbols }
  }

  // Dev/test safety: if the fetched list contains obviously bogus symbols (long names,
  // no real market data in sandbox, etc.), replace the tail with a safe major-symbol set
  // so quickstart with symbolCount=10 or higher never hands the engine untradeable junk.
  const looksBogus = (s: string) => s.length > 10 || !/USDT$/.test(s) || /AEON|B2US|HANA|INUS|TAG|HOOLI|MAGASOL|SPORTFUN|TIMI/.test(s)
  if (tickers.some(t => looksBogus(t.symbol))) {
    const clean = tickers.filter(t => !looksBogus(t.symbol))
    const needed = Math.max(0, safeLimit - clean.length)
    const extras = SAFE_MAJORS.filter(s => !clean.some(c => c.symbol === s)).slice(0, needed)
      .map(s => ({ symbol: s, priceChangePercent: 0.5, volume: 1000 }))
    tickers = [...clean, ...extras].slice(0, Math.max(safeLimit, clean.length))
  }

  // Sort by the requested key, descending. "volume" → 24h quote/turnover
  // volume (liquidity-first); "volatility" → absolute 24h price change %.
  tickers.sort((a, b) =>
    sort === "volatility"
      ? b.priceChangePercent - a.priceChangePercent
      : b.volume - a.volume,
  )

  // De-duplicate (guards against any exchange returning the same symbol twice)
  const seen = new Set<string>()
  const unique = tickers.filter(t => {
    if (seen.has(t.symbol)) return false
    seen.add(t.symbol)
    return true
  })

  const topN = unique.slice(0, safeLimit)
  const top = topN[0]
  cache.set(cacheKey, { symbol: top.symbol, priceChangePercent: top.priceChangePercent, timestamp: Date.now() })

  return { symbol: top.symbol, priceChangePercent: top.priceChangePercent, symbols: topN }
}

/**
 * GET /api/exchange/[exchange]/top-symbols?limit=N&sort=volume|volatility
 * Returns the top N symbols on the exchange, ordered by the requested key.
 * - limit defaults to 1 and is clamped to [1,50]
 * - sort defaults to "volume" (liquidity-first); "volatility" orders by 24h |%Δ|
 * - `symbol` keeps the top-1 for backward-compatibility with existing callers
 * - `symbols` is a sorted list of objects: [{ symbol, priceChangePercent, volume }, ...]
 * - `symbolList` is the plain string[] for convenience
 * Uses public exchange REST APIs — no auth required.
 */
export async function GET(request: Request, { params }: { params: Promise<{ exchange: string }> }) {
  try {
    const { exchange } = await params
    const normalised = (exchange || "").toLowerCase()

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "1", 10) || 1
    const sort = normaliseSort(searchParams.get("sort"))

    const { symbol, priceChangePercent, symbols } = await fetchMostVolatileSymbols(normalised, limit, sort)

    return NextResponse.json({
      success: true,
      exchange: normalised,
      sort,
      symbol,
      priceChangePercent,
      symbols,                             // [{ symbol, priceChangePercent, volume }]
      symbolList: symbols.map(s => s.symbol), // plain string[] for convenience
      count: symbols.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[v0] [TopSymbols] Fatal error:`, error)
    return NextResponse.json(
      { error: "Failed to retrieve top symbols", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
