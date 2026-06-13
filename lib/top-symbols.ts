// Shared exchange top-symbols resolver.
//
// Extracted from app/api/exchange/[exchange]/top-symbols/route.ts so server-side
// callers (e.g. the settings PATCH route's auto-resolve, quick-start) can resolve
// the top-N symbols DIRECTLY instead of doing a fragile HTTP self-fetch back into
// our own route (which fails on loopback/origin mismatch inside a route handler).
//
// Uses public exchange REST APIs — no auth required. Always returns at least one
// symbol (safe-major fallback) so callers never wipe a connection's symbol source.

export type SortKey = "volume" | "volatility"
export type Ticker = { symbol: string; priceChangePercent: number; volume: number }

// In-memory cache — volatile symbols don't change rapidly, 60s TTL is fine.
// Keyed by `${exchange}:${sort}` so volume- and volatility-sorted requests
// don't clobber each other's cached top-1.
const cache = new Map<string, { symbol: string; priceChangePercent: number; timestamp: number }>()
const CACHE_TTL = 60_000

const FALLBACK: Record<string, string> = {
  binance: "BTCUSDT",
  bybit: "BTCUSDT",
  bingx: "BTCUSDT",
  okx: "BTCUSDT",
  pionex: "BTCUSDT",
  orangex: "BTCUSDT",
}

const SAFE_MAJORS = [
  "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
  "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "MATICUSDT",
]

export function normaliseSort(raw: string | null | undefined): SortKey {
  const v = (raw || "").toLowerCase()
  // The dialog maps both `volume_24h`/`volume_1h` → "volume" and
  // `volatility_*` → "volatility"; `newest`/`manual` fall back to volume.
  if (v.startsWith("volatil")) return "volatility"
  return "volume"
}

export async function fetchTopSymbols(
  exchange: string,
  limit = 1,
  sort: SortKey = "volume",
): Promise<{ symbol: string; priceChangePercent: number; symbols: Ticker[] }> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 1))
  const cacheKey = `${exchange}:${sort}`
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
      const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`)
      const data: any[] = await res.json()
      tickers = data
        .filter(
          (t) =>
            t.symbol.endsWith("USDT") &&
            !t.symbol.includes("DOWN") &&
            !t.symbol.includes("UP") &&
            !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
            Number.parseFloat(t.quoteVolume) > 1_000_000,
        )
        .map((t) => ({
          symbol: t.symbol,
          priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent)),
          volume: Number.parseFloat(t.quoteVolume) || 0,
        }))
    } else if (exchange === "bybit") {
      try {
        const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)" },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          const binanceRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
          })
          if (binanceRes.ok) {
            const binanceData: any[] = await binanceRes.json()
            tickers = binanceData
              .filter(
                (t) =>
                  t.symbol.endsWith("USDT") &&
                  !t.symbol.includes("DOWN") &&
                  !t.symbol.includes("UP") &&
                  !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
                  Number.parseFloat(t.quoteVolume) > 1_000_000,
              )
              .map((t) => ({
                symbol: t.symbol,
                priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent)),
                volume: Number.parseFloat(t.quoteVolume) || 0,
              }))
          }
        } else {
          const data = await res.json()
          tickers = (data?.result?.list || [])
            .filter((t: any) => t.symbol.endsWith("USDT") && Number.parseFloat(t.turnover24h) > 1_000_000)
            .map((t: any) => ({
              symbol: t.symbol,
              priceChangePercent: Math.abs(Number.parseFloat(t.price24hPcnt || "0") * 100),
              volume: Number.parseFloat(t.turnover24h) || 0,
            }))
        }
      } catch (bybitErr) {
        console.warn("[TopSymbols] Bybit API error, using default:", bybitErr instanceof Error ? bybitErr.message : bybitErr)
      }
    } else if (exchange === "bingx") {
      const res = await fetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`BingX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) => t.symbol?.endsWith("-USDT") && Number.parseFloat(t.volume) > 100_000)
        .map((t: any) => ({
          symbol: (t.symbol as string).replace("-", ""),
          priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent || "0")),
          volume: Number.parseFloat(t.quoteVolume || t.volume || "0") || 0,
        }))
    } else if (exchange === "okx") {
      const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`OKX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) => t.instId?.endsWith("USDT-SWAP") && Number.parseFloat(t.volCcy24h) > 1_000_000)
        .map((t: any) => ({
          symbol: (t.instId as string).replace("-SWAP", "").replace("-", ""),
          priceChangePercent: Math.abs(Number.parseFloat(t.sodUtc8 || "0")),
          volume: Number.parseFloat(t.volCcy24h || "0") || 0,
        }))
    }
  } catch {
    // Silently handle — will use fallback below.
  }

  if (tickers.length === 0) {
    // Public ticker API unreachable / empty after filtering (common in sandboxed
    // dev). Honour the requested count instead of collapsing to a single symbol.
    const preferred = FALLBACK[exchange] || "BTCUSDT"
    const ordered = [preferred, ...SAFE_MAJORS.filter((s) => s !== preferred)]
    const fallbackSymbols = ordered.slice(0, safeLimit).map((symbol, i) => ({
      symbol,
      priceChangePercent: i === 0 ? 0 : 0.5,
      volume: Math.max(0, (ordered.length - i) * 1000),
    }))
    return { symbol: preferred, priceChangePercent: 0, symbols: fallbackSymbols }
  }

  // Replace obviously bogus symbols (sandbox junk) with safe majors.
  const looksBogus = (s: string) =>
    s.length > 10 || !/USDT$/.test(s) || /AEON|B2US|HANA|INUS|TAG|HOOLI|MAGASOL|SPORTFUN|TIMI/.test(s)
  if (tickers.some((t) => looksBogus(t.symbol))) {
    const clean = tickers.filter((t) => !looksBogus(t.symbol))
    const needed = Math.max(0, safeLimit - clean.length)
    const extras = SAFE_MAJORS.filter((s) => !clean.some((c) => c.symbol === s))
      .slice(0, needed)
      .map((s) => ({ symbol: s, priceChangePercent: 0.5, volume: 1000 }))
    tickers = [...clean, ...extras].slice(0, Math.max(safeLimit, clean.length))
  }

  tickers.sort((a, b) =>
    sort === "volatility" ? b.priceChangePercent - a.priceChangePercent : b.volume - a.volume,
  )

  const seen = new Set<string>()
  const unique = tickers.filter((t) => {
    if (seen.has(t.symbol)) return false
    seen.add(t.symbol)
    return true
  })

  const topN = unique.slice(0, safeLimit)
  const top = topN[0]
  cache.set(cacheKey, { symbol: top.symbol, priceChangePercent: top.priceChangePercent, timestamp: Date.now() })

  return { symbol: top.symbol, priceChangePercent: top.priceChangePercent, symbols: topN }
}
