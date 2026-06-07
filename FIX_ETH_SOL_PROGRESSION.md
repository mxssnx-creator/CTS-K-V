# ETH/SOL Live Position Progression Relay Fix

**Issue**: ETH and SOL positions at the live stage were not properly relaying their creation context back to the original progress tracking system. Live positions would be created successfully but the progression logs wouldn't include which real set, axis window, or strategy configuration generated them.

**Root Cause**: When `executeLivePosition` was called from Phase 4 (`executeReadyStrategiesAsLiveOrders` in `shared-ind-strat-pipeline.ts`), the connection between the **real position's strategic metadata** and the **live position's execution record** was never logged. This created two separate event streams:

1. Real Sets tracked their decisions (profitFactor, setVariant, axisWindows)
2. Live Positions tracked their execution (order placed, filled, closed)

But these streams were never linked in the progression logs, breaking the ability to trace "which strategy decision led to this live position?"

## Files Fixed

### 1. `lib/trade-engine/shared-ind-strat-pipeline.ts` (Phase 4 Live Execution)

**Added detailed progression logging when live positions are created**:

```typescript
// After a live position is successfully created:
const { logProgressionEvent } = await import("@/lib/engine-progression-logs")
await logProgressionEvent(
  connectionId,
  "live_trading",
  "info",
  `Live position dispatched from real set ${symbol}/${realSet.direction}`,
  {
    livePositionId: livePos.id,
    realSetKey: realSet.setKey,           // ← Links to parent strategy set
    parentSetKey: realSet.parentSetKey,   // ← Links to parent config
    setVariant: realSet.variant,          // ← Strategy variation (default/trailing/block/dca)
    axisWindows: realSet.axisWindows,     // ← Axis window state (prev/last/cont/pause)
    entryProfitFactor: bestEntry.profitFactor,
    entryConfidence: bestEntry.confidence,
    leverage: realPosition.leverage,
    quantity: realPosition.quantity,
    status: livePos.status,
  }
)
```

**Impact**: Progression logs now show exactly which real set's configuration led to each live position creation.

---

### 2. `lib/trade-engine/stages/live-stage.ts` (Live Position Creation Logging)

**Enhanced the "position created" event with full real position context**:

```typescript
// Line 2709 - Updated to include lineage:
await logProgressionEvent(connectionId, "live_trading", "info", `Live position created ${realPosition.symbol}`, {
  livePositionId: livePosition.id,
  realPositionId: realPosition.id,          // ← Trace back to real position
  status: livePosition.status,
  orderId: livePosition.orderId,
  executedQuantity: livePosition.executedQuantity,
  volumeUsd: livePosition.volumeUsd,
  // ── Real position context (critical for debugging) ──
  realSetKey: realPosition.setKey,
  realParentSetKey: realPosition.parentSetKey,
  realSetVariant: realPosition.setVariant,
  realAxisWindows: realPosition.axisWindows,
  leverage: realPosition.leverage,
  quantity: realPosition.quantity,
  direction: realPosition.direction,
})
```

**Enhanced the "position closed" event with full lifecycle context**:

```typescript
// Line 3160 - Updated to include complete lifecycle:
await logProgressionEvent(connectionId, "live_trading", "info", `Closed live position ${position.symbol}`, {
  livePositionId: position.id,
  realPositionId: position.realPositionId,
  realSetKey: position.setKey,
  realParentSetKey: position.parentSetKey,
  realSetVariant: position.setVariant,
  realAxisWindows: position.axisWindows,
  pnl,
  roi,
  closePrice,
  closeReason,
  // ... rest of metrics
})
```

**Impact**: Dashboards and logs can now trace the complete lifecycle: real set strategy → live position creation → order fill → SL/TP/manual close → final P&L

---

## What This Fixes

### Before Fix:
```
REAL SET PHASE:
  └ Create set for ETH: profitFactor=1.45, variant="trailing", axisPrev=5, axisLast=2
    └ PROGRESSION LOG: "Strategy set created ETHUSDT/long"

LIVE PHASE:
  └ Create live position for ETH
    └ PROGRESSION LOG: "Live position created ETHUSDT"  ← Missing all context!
  
Result: User sees position was created but has NO IDEA which strategy config led to it
```

### After Fix:
```
REAL SET PHASE:
  └ Create set for ETH: profitFactor=1.45, variant="trailing", axisPrev=5, axisLast=2
    └ PROGRESSION LOG: "Strategy set created ETHUSDT/long"

LIVE PHASE:
  └ Dispatch phase 4 with real set
    └ PROGRESSION LOG: "Live position dispatched from real set ETHUSDT/long"
       Details: realSetKey=..., variant="trailing", profitFactor=1.45, axisWindows={prev:5, last:2}
  
  └ Create live position
    └ PROGRESSION LOG: "Live position created ETHUSDT"
       Details: realSetKey=..., realSetVariant="trailing", realAxisWindows={...}

Result: User can now trace: which strategy variant + axis window → live creation → outcome
```

---

## Affected Symbols

This fix applies to **all multi-set symbols** where multiple Real Sets can be generated:

- **ETH/ETHUSDT** - Typically produces 2-4 Real Sets (long+short × variants)
- **SOL/SOLUSDT** - Typically produces 2-4 Real Sets (long+short × variants)
- **BTC/BTCUSDT** - All DRIFT_* symbols that generate multiple sets
- Any symbol with `block`, `trailing`, `dca`, or `pause` variants enabled

The issue was **most visible** on these symbols because they generate multiple Real Sets, and the operator would see position created/closed but couldn't identify which strategy configuration was responsible.

---

## Testing

### Verify the Fix in Progression Logs:

```bash
# Get the latest live trading events for ETH
curl http://localhost:3000/api/connections/progression/bingx-x01/logs \
  | grep -i "live.*ETH\|dispatch.*ETH"

# Look for:
# 1. "Live position dispatched from real set" with realSetKey, variant, profitFactor
# 2. "Live position created" with realSetKey, realSetVariant, realAxisWindows
# 3. "Closed live position" with the same context for P&L attribution
```

### Expected Output Pattern:

```json
{
  "phase": "live_trading",
  "message": "Live position dispatched from real set ETHUSDT/long",
  "details": {
    "realSetKey": "set:...",
    "setVariant": "trailing",
    "axisWindows": { "prev": 5, "last": 2, "cont": 1, "pause": 0 },
    "entryProfitFactor": 1.45,
    "leverage": 5
  }
}
```

---

## Performance Impact

- **Zero impact on live trading latency**: Logging is already async and buffered
- **Minimal memory impact**: Adding ~500 bytes to each progression log entry
- **Database impact**: None (Redis list, TTL-trimmed at 500 entries max)

---

## Related Issues Previously Fixed

This fix addresses the root cause of:
- "Why was this live position created?" (now traceable to real set)
- "Which strategy variant led to this position?" (now logged as `realSetVariant`)
- "How did the axis windows affect the decision?" (now logged as `realAxisWindows`)
- "Multi-symbol positions orphaned from context" (now fully linked)

---

## Files Modified

1. ✅ `lib/trade-engine/shared-ind-strat-pipeline.ts` - Phase 4 dispatch logging
2. ✅ `lib/trade-engine/stages/live-stage.ts` - Creation & close logging
3. ✅ Build: Clean production build verified

---

**Status**: Production Ready ✅

This fix enables full lifecycle tracing for all live positions, especially critical for ETH/SOL and other multi-set symbols where strategy context determines trading decisions.
