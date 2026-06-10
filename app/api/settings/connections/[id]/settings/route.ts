import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { updateConnection, initRedis, getConnection, getRedisClient, setSettings, getSettings } from "@/lib/redis-db"
import { RedisTrades, RedisPositions } from "@/lib/redis-operations"
import { recoordinateAfterSettingsChange } from "@/lib/connection-recoordinator"
import { getTradeEngine } from "@/lib/trade-engine"
import { fetchTopSymbols } from "@/lib/top-symbols"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await initRedis()
    const client = getRedisClient()

    const [connection, trades, positions, connSettingsHash] = await Promise.all([
      getConnection(id),
      RedisTrades.getTradesByConnection(id).catch(() => []),
      RedisPositions.getPositionsByConnection(id).catch(() => []),
      // The PATCH route mirrors flat fields (symbol_order, symbol_count,
      // leveragePercentage, useMaximalLeverage, etc.) into the separate
      // `connection_settings:{id}` Redis hash so the engine can read them
      // cheaply. The connection.connection_settings JSON blob only carries
      // the nested coordination/strategy structure saved before this hash
      // mirror existed. We must merge both sources so the dialog can hydrate
      // all saved values on open.
      client.hgetall(`connection_settings:${id}`).catch(() => null),
    ])

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Base: parse the nested JSON blob stored on the connection object.
    const jsonSettings = typeof connection.connection_settings === "string"
      ? (() => { try { return JSON.parse(connection.connection_settings) } catch { return {} } })()
      : connection.connection_settings || {}

    // Overlay the flat hash fields on top of the JSON blob. The hash is the
    // authoritative source for any field the PATCH has mirrored there
    // (prevPosMinCount, leveragePercentage, symbol_order, etc.) because the
    // PATCH always writes both stores. Fields that were only ever saved in the
    // JSON blob (coordination_settings, strategies, profitFactorMin) are
    // carried by the JSON blob and not overwritten by the hash overlay.
    const hashSettings: Record<string, unknown> = {}
    if (connSettingsHash && typeof connSettingsHash === "object") {
      for (const [k, v] of Object.entries(connSettingsHash as Record<string, string>)) {
        // Parse numeric strings back to numbers for fields the dialog expects.
        if ([
          "symbol_count", "symbolCount", "leveragePercentage",
          "prevPosMinCount", "prevPosWindow", "mainEvalPosCount",
          "realEvalPosCount", "minStep",
          // Axis max-window values
          "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
          // Block strategy tuning
          "blockVolumeRatio", "blockMaxStack",
          // PF / DDT / stage thresholds
          "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
          "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
          "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
        ].includes(k)) {
          const n = Number(v)
          hashSettings[k] = Number.isFinite(n) ? n : v
        } else if ([
          "useMaximalLeverage",
          "useSystemCloseOnly", "use_system_close_only",
          // Coordination variant toggles
          "variantTrailingEnabled", "variantBlockEnabled",
          "variantDcaEnabled", "variantPauseEnabled",
          // Axis enable flags
          "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
        ].includes(k)) {
          // Store as boolean so dialog toggle/checkbox checks work correctly.
          hashSettings[k] = v === "true"
        } else if (k === "symbols" || k === "active_symbols") {
          // Symbols are stored as JSON strings in the hash.
          try { hashSettings[k] = JSON.parse(v) } catch { hashSettings[k] = v }
        } else {
          hashSettings[k] = v
        }
      }
    }

    // Merge: hash fields override JSON blob fields (hash is more recent).
    const settings = { ...jsonSettings, ...hashSettings }

    return NextResponse.json({
      connection,
      settings,
      statistics: {
        active_trades: trades?.length || 0,
        active_positions: positions?.length || 0,
        created_at: connection.created_at,
        updated_at: connection.updated_at,
      },
    })
  } catch (error) {
    console.error("[v0] [Settings] GET error:", error)
    await SystemLogger.logError(error, "api", "GET /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to fetch settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const updated = {
      ...connection,
      name: body.name || connection.name,
      api_type: body.api_type || connection.api_type,
      connection_method: body.connection_method || connection.connection_method,
      connection_library: body.connection_library || connection.connection_library,
      margin_type: body.margin_type || connection.margin_type,
      position_mode: body.position_mode || connection.position_mode,
      is_testnet: body.is_testnet !== undefined ? body.is_testnet : connection.is_testnet,
      is_enabled: body.is_enabled !== undefined ? body.is_enabled : connection.is_enabled,
      is_active: body.is_active !== undefined ? body.is_active : connection.is_active,
      volume_factor: body.volume_factor || connection.volume_factor,
      connection_settings: body.settings || connection.connection_settings,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updated)

    // Full propagation: notify + fast-path apply + recoordinate
    // (start/stop/hot-reload as the new state dictates). See
    // lib/connection-recoordinator.ts for the design rationale.
    await recoordinateAfterSettingsChange(id, connection, updated, {
      logTag: "PUT /settings",
    })

    await SystemLogger.logConnection(`Updated settings`, id, "info")

    return NextResponse.json({ success: true, connection: updated })
  } catch (error) {
    console.error("[v0] [Settings] PUT error:", error)
    await SystemLogger.logError(error, "api", "PUT /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const settings = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const current = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    const merged = { ...current, ...settings }

    const updated = {
      ...connection,
      connection_settings: merged,
      // Position mode & margin are first-class connection fields that the
      // engine applies to the exchange connector at startup. Mirror them
      // onto the connection object when the dialog sends them so the next
      // (re)start uses the operator's choice.
      ...(typeof settings.position_mode === "string" ? { position_mode: settings.position_mode } : {}),
      ...(typeof settings.margin_mode === "string" ? { margin_type: settings.margin_mode } : {}),
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updated)

    // ── Flat eval-knob hash mirror (CRITICAL) ───────────────────────────
    // The strategy coordinator and detailed-tracking read the per-eval
    // knobs straight off the `connection_settings:{id}` Redis HASH via
    // hgetall — NOT from the connection object's nested JSON. updateConnection
    // only persists the connection hash (`connection:{id}`), so without this
    // mirror the engine never sees operator changes and silently runs the
    // built-in defaults (prevPosMinCount=5, prevPosWindow=25, etc.). Mirror
    // every flat scalar the merged payload carries so the coordinator's
    // 30s-cached hgetall picks them up on the next refresh window. Values
    // are stringified because the emulator hash stores strings.
    try {
      const flatKnobs: Record<string, string> = {}
      // ── Strategy coordination knobs ─────────────────────────────────────
      const knobKeys = [
        "prevPosMinCount",
        "prevPosWindow",
        "mainEvalPosCount",
        "realEvalPosCount",
        "minStep",
      ] as const
      for (const k of knobKeys) {
        const v = (merged as Record<string, unknown>)[k]
        if (typeof v === "number" && Number.isFinite(v)) flatKnobs[k] = String(v)
      }

      // ── Symbol selection fields ─────────────────────────────────────────
      // Mirror symbol_order, symbol_count, and the resolved symbols list so
      // the GET route can always read them from the hash regardless of whether
      // they were also written to the connection JSON blob.
      {
        const order = (merged as Record<string, unknown>).symbol_order
        if (typeof order === "string" && order.length > 0) flatKnobs.symbol_order = order

        const count = Number((merged as Record<string, unknown>).symbol_count)
        if (Number.isFinite(count) && count > 0) flatKnobs.symbol_count = String(Math.floor(count))

        const syms = (merged as Record<string, unknown>).symbols
        if (Array.isArray(syms) && syms.length > 0) {
          flatKnobs.symbols = JSON.stringify(syms)
        }
      }

      // ── Position / margin mode ──────────────────────────────────────────
      {
        const pm = (merged as Record<string, unknown>).position_mode
        if (typeof pm === "string") flatKnobs.position_mode = pm

        const mm = (merged as Record<string, unknown>).margin_mode
        if (typeof mm === "string") flatKnobs.margin_mode = mm

        const vt = (merged as Record<string, unknown>).volume_type
        if (typeof vt === "string") flatKnobs.volume_type = vt
      }

      // ── System close flag ───────────────────────────────────────────────
      {
        const sco =
          (merged as Record<string, unknown>).useSystemCloseOnly ??
          (merged as Record<string, unknown>).use_system_close_only
        if (typeof sco === "boolean") {
          flatKnobs.useSystemCloseOnly  = sco ? "true" : "false"
          flatKnobs.use_system_close_only = sco ? "true" : "false"
        }
      }

      // ── Strategy coordination variant / axis / block flattening ─────────
      // The dialog sends the full CoordinationSettings object nested under
      // `coordination_settings`. The strategy coordinator's
      // `loadCoordinationSettings()` reads FLAT scalar keys from the
      // `connection_settings:{id}` hash (axisPrevEnabled,
      // variantBlockEnabled, blockVolumeRatio, etc.). Without flattening
      // here the engine ALWAYS uses its coded defaults (all variants on,
      // all axes off, blockVolumeRatio=1.0) regardless of what the
      // operator sets in the Connection Settings dialog.
      {
        const coord = (merged as Record<string, unknown>).coordination_settings as
          | Record<string, unknown>
          | undefined
        if (coord && typeof coord === "object") {
          // Variant toggles:  variants.{trailing,block,dca,pause}
          //   → flat key variantTrailingEnabled, variantBlockEnabled, …
          const variantsObj = coord.variants as Record<string, unknown> | undefined
          if (variantsObj && typeof variantsObj === "object") {
            for (const [vk, vv] of Object.entries(variantsObj)) {
              if (typeof vv === "boolean") {
                const cap = vk.charAt(0).toUpperCase() + vk.slice(1)
                flatKnobs[`variant${cap}Enabled`] = vv ? "true" : "false"
              }
            }
          }

          // Axis toggles:  axes.{prev,last,cont,pause}.{enabled,maxWindow}
          //   → flat keys axis{Prev,Last,Cont,Pause}Enabled and …MaxWindow
          const axesObj = coord.axes as Record<string, Record<string, unknown>> | undefined
          if (axesObj && typeof axesObj === "object") {
            for (const [axisKey, axisVal] of Object.entries(axesObj)) {
              if (axisVal && typeof axisVal === "object") {
                const cap = axisKey.charAt(0).toUpperCase() + axisKey.slice(1)
                if (typeof axisVal.enabled === "boolean") {
                  flatKnobs[`axis${cap}Enabled`] = axisVal.enabled ? "true" : "false"
                }
                const mw = Number(axisVal.maxWindow)
                if (Number.isFinite(mw) && mw >= 0) {
                  flatKnobs[`axis${cap}MaxWindow`] = String(mw)
                }
              }
            }
          }

          // Block-strategy tuning knobs (blockVolumeRatio 0.25-3.0, blockMaxStack 2-8).
          // Previously never written to the hash — engine always used 1.0/3.
          const bvr = Number(coord.blockVolumeRatio)
          if (Number.isFinite(bvr) && bvr > 0) {
            flatKnobs.blockVolumeRatio = String(Math.max(0.25, Math.min(3.0, bvr)))
          }
          const bms = Number(coord.blockMaxStack)
          if (Number.isFinite(bms) && bms >= 2) {
            flatKnobs.blockMaxStack = String(Math.min(8, Math.max(2, Math.floor(bms))))
          }
        }
      }

      // ── Per-connection leverage mirror ──────────────────────────────────
      // VolumeCalculator overlays the `connection_settings:{id}` hash on top
      // of global app_settings, reading `leveragePercentage` (1–100) and
      // `useMaximalLeverage` ("true"/"false"). Mirror them so per-connection
      // leverage sizing actually takes effect.
      {
        const lev = Number((merged as Record<string, unknown>).leveragePercentage)
        if (Number.isFinite(lev) && lev > 0) {
          flatKnobs.leveragePercentage = String(Math.max(1, Math.min(100, lev)))
        }
        const useMax = (merged as Record<string, unknown>).useMaximalLeverage
        if (typeof useMax === "boolean") flatKnobs.useMaximalLeverage = useMax ? "true" : "false"
      }

      // ── Per-channel PF / DDT / max-positions flattening (CRITICAL) ──────
      // The dialog stores per-channel strategy tuning nested under
      // `strategies.main.{base,main,real}` as:
      //   min_profit_factor  (× multiplier)
      //   max_drawdown_time  (MINUTES, slider 1–1440)
      //   max_positions      (count)
      // But the coordinator's `loadAppPFThresholds()` reads FLAT, differently
      // named fields and expects DDT in HOURS:
      //   baseProfitFactor / mainProfitFactor / realProfitFactor / liveProfitFactor
      //   maxDrawdownTimeMainHours / ...RealHours / ...LiveHours
      //   stageMinPosCountBase / ...Main / ...Real
      // Until now nothing bridged the two, so per-channel edits silently never
      // reached the engine (it used global app_settings / defaults forever).
      // Flatten + unit-convert here so the coordinator's per-connection
      // resolution (connection hash → global → default) picks them up.
      const strat = (merged as Record<string, unknown>).strategies as
        | Record<string, Record<string, { min_profit_factor?: number; max_drawdown_time?: number; max_positions?: number }>>
        | undefined
      const chan = strat?.main // the live/realtime profile drives the engine
      if (chan) {
        const pf = (raw: unknown): string | null => {
          const n = Number(raw)
          return Number.isFinite(n) && n > 0 ? String(Math.max(0, Math.min(5, n))) : null
        }
        const ddtMinToHr = (raw: unknown): string | null => {
          const n = Number(raw)
          if (!Number.isFinite(n) || n <= 0) return null
          // minutes → hours, clamp to the coordinator's [1,72]h gate window
          return String(Math.max(1, Math.min(72, n / 60)))
        }
        const posCount = (raw: unknown): string | null => {
          const n = Number(raw)
          return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null
        }
        const pairs: Array<[string, string | null]> = [
          ["baseProfitFactor", pf(chan.base?.min_profit_factor)],
          ["mainProfitFactor", pf(chan.main?.min_profit_factor)],
          ["realProfitFactor", pf(chan.real?.min_profit_factor)],
          ["maxDrawdownTimeMainHours", ddtMinToHr(chan.main?.max_drawdown_time)],
          ["maxDrawdownTimeRealHours", ddtMinToHr(chan.real?.max_drawdown_time)],
          ["stageMinPosCountBase", posCount(chan.base?.max_positions)],
          ["stageMinPosCountMain", posCount(chan.main?.max_positions)],
          ["stageMinPosCountReal", posCount(chan.real?.max_positions)],
        ]
        for (const [k, v] of pairs) if (v !== null) flatKnobs[k] = v
      }

      if (Object.keys(flatKnobs).length > 0) {
        await getRedisClient().hset(`connection_settings:${id}`, flatKnobs)
      }
    } catch (mirrorErr) {
      console.error("[v0] [Settings] eval-knob hash mirror failed:", mirrorErr)
    }

    // ── Symbols → engine symbol source (auto-resolve top-N on save) ─────
    // The dialog saves `symbols` (manual list), `symbol_order` (volume /
    // volatility / newest / manual) and `symbol_count` into
    // `connection_settings`. But the engine's `getSymbols()` reads the
    // ACTIVE list from the connection object's `active_symbols` (and the
    // `trade_engine_state:{id}` hash) — it never looks at
    // `connection_settings.symbols`. So without this bridge a saved symbol
    // selection silently never reached the engine.
    //
    // Behaviour:
    //   • symbol_order === "manual" (or a non-empty `symbols` array with that
    //     order): use the operator's explicit list, truncated to symbol_count.
    //   • otherwise: AUTO-RESOLVE the top-N by the chosen order from the public
    //     exchange ticker API (volume / volatility), N = symbol_count.
    // The resolved list is written to BOTH `active_symbols` on the connection
    // and the `trade_engine_state:{id}` hash, then the live engine's symbol
    // cache is invalidated so the next tick (≤ TTL) picks it up without a
    // restart.
    const touchedSymbols =
      Array.isArray((settings as Record<string, unknown>).symbols) ||
      typeof (settings as Record<string, unknown>).symbol_order === "string" ||
      (settings as Record<string, unknown>).symbol_count !== undefined
    if (touchedSymbols) {
      try {
        const order = String((merged as Record<string, unknown>).symbol_order || "volume_24h")
        const rawCount = Number((merged as Record<string, unknown>).symbol_count)
        const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.max(1, Math.min(50, Math.floor(rawCount))) : 3
        const manualList = Array.isArray((merged as Record<string, unknown>).symbols)
          ? ((merged as Record<string, unknown>).symbols as unknown[]).filter(
              (s): s is string => typeof s === "string" && s.length > 0,
            )
          : []

        let resolved: string[] = []
        if (order === "manual" && manualList.length > 0) {
          // Operator-curated list wins verbatim (still capped at count).
          resolved = manualList.slice(0, count)
        } else {
          // Auto-resolve top-N by the chosen order. Call the shared resolver
          // DIRECTLY (no HTTP self-fetch — that fails on loopback/origin inside
          // a route handler, which is why the first cut resolved 0 symbols).
          const exchange = String((connection as Record<string, unknown>).exchange || "bingx").toLowerCase()
          const sort = order.startsWith("volatil") ? "volatility" : "volume"
          try {
            const { symbols: topSymbols } = await fetchTopSymbols(exchange, count, sort)
            resolved = topSymbols
              .map((s) => s.symbol)
              .filter((s): s is string => typeof s === "string" && s.length > 0)
              .slice(0, count)
          } catch (fetchErr) {
            console.warn(
              "[v0] [Settings] top-symbols auto-resolve failed:",
              fetchErr instanceof Error ? fetchErr.message : fetchErr,
            )
          }
          // If auto-resolve produced nothing, fall back to any manual list the
          // operator had, so we never wipe the engine's symbols.
          if (resolved.length === 0 && manualList.length > 0) resolved = manualList.slice(0, count)
        }

        if (resolved.length > 0) {
          // 1. Persist as the connection's ACTIVE symbol source (what the engine reads).
          await updateConnection(id, { active_symbols: JSON.stringify(resolved) })
          // 2. Mirror into trade_engine_state (the engine's primary lookup) +
          //    seed the prehistoric symbol total so the progress bar denominator
          //    matches the new selection immediately.
          const stateKey = `trade_engine_state:${id}`
          const prevState = (await getSettings(stateKey)) || {}
          await setSettings(stateKey, {
            ...prevState,
            connection_id: id,
            symbols: JSON.stringify(resolved),
            active_symbols: JSON.stringify(resolved),
            config_set_symbols_total: resolved.length,
            updated_at: new Date().toISOString(),
          })
          // 3. Invalidate the running engine's in-memory symbol cache so the
          //    change takes effect on the next tick without a restart.
          try {
            getTradeEngine()?.getEngineManager(id)?.invalidateSymbolsCache()
          } catch { /* engine may not be running yet — state above is enough */ }
          console.log(`[v0] [Settings] Resolved ${resolved.length} symbol(s) for ${id} (order=${order}): ${resolved.join(", ")}`)
        }
      } catch (symErr) {
        console.error("[v0] [Settings] symbol auto-resolve failed:", symErr)
      }
    }

    // ── Progression clean-up on significant settings changes ─────────────────
    // When the operator changes symbols, live-trade mode, testnet flag, or other
    // fields that alter what the progression computes, we must clean the previous
    // progress BEFORE the engine hot-reloads — otherwise the dashboard shows a
    // blended timeline spanning two different configurations (old symbols + old PF
    // output mixed with new-config output). `recoordinateForActualOne` compares the
    // stored snapshot against the current live state and archives + resets the
    // progression hash when a mismatch is detected, producing a fresh, solid
    // progression aligned to the new configuration.
    //
    // Fields that trigger this: anything that changes what symbols the engine runs,
    // or that changes the code-path (live/testnet/preset mode, connection method,
    // margin type, position mode). Pure cosmetic changes (name, UI labels) skip it.
    const significantKeys = [
      "symbols", "symbol_order", "symbol_count", "active_symbols",
      "is_live_trade", "is_testnet", "is_preset_trade",
      "connection_method", "margin_mode", "margin_type", "position_mode",
    ]
    const touchedSignificant = significantKeys.some((k) =>
      Object.prototype.hasOwnProperty.call(settings, k)
    )
    if (touchedSignificant) {
      try {
        // Allow the symbol resolver above to finish writing to Redis BEFORE
        // we compare snapshots — use setImmediate to yield to any in-flight
        // microtask queue flush, then call recoordinate synchronously.
        await ProgressionStateManager.recoordinateForActualOne(id)
      } catch (recoordErr) {
        // Non-fatal: the engine will still hot-reload with the new settings;
        // we just won't have wiped the old progression hash.
        console.warn(
          `[v0] [Settings PATCH] recoordinateForActualOne failed for ${id} (non-fatal):`,
          recoordErr instanceof Error ? recoordErr.message : String(recoordErr),
        )
      }
    }

    // Full propagation. PATCH only ships a partial settings payload, so
    // `detectChangedFields` (which compares top-level connection fields)
    // would report zero changes — pass an explicit override listing the
    // settings keys the caller touched, so the recoordinator knows
    // something inside `connection_settings` actually changed.
    await recoordinateAfterSettingsChange(
      id,
      { ...connection, connection_settings: current },
      { ...connection, connection_settings: merged, updated_at: updated.updated_at },
      {
        logTag: "PATCH /settings",
        changedFieldsOverride: Object.keys(settings).length > 0 ? ["connection_settings"] : [],
      },
    )

    await SystemLogger.logConnection(`Patched settings`, id, "info")

    return NextResponse.json({ success: true, settings: merged })
  } catch (error) {
    console.error("[v0] [Settings] PATCH error:", error)
    await SystemLogger.logError(error, "api", "PATCH /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
