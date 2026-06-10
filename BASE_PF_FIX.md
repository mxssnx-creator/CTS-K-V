# Base PF Historical Overview - Fix Applied

## Issue
The "Base PF" tile in the historical overview section was not showing because the field was never written to Redis when no closed positions existed.

## Root Cause
In `lib/trade-engine/config-set-processor.ts`, the `historic_avg_profit_factor` field was only written when:
```
if (resultCount > 0 && (posSum > 0 || negAbsSum > 0))
```

This meant if there were no closed positions, the write was skipped entirely, leaving the field undefined. The dashboard component then had nothing to render.

## Solution
Changed to always write the field:
- When closed positions exist: write computed PF value
- When no closed positions: write 0.0000 default

This ensures the dashboard tile renders immediately with a valid value, updating to the computed value as trading progresses.

## Code Changes
**File**: `lib/trade-engine/config-set-processor.ts` (lines 628-693)

**Before**:
```typescript
if (resultCount > 0 && (posSum > 0 || negAbsSum > 0)) {
  // compute and write
} else {
  // skip write entirely
}
```

**After**:
```typescript
// Always compute (with default fallback)
let pfStr = "0.0000"
let pfSource = "no_closed_positions"
if (resultCount > 0 && (posSum > 0 || negAbsSum > 0)) {
  pfStr = computed_value
  pfSource = "prehistoric_aggregate"
}

// Always write
await client.hset(`prehistoric:${connId}`, {
  historic_avg_profit_factor: pfStr,
  historic_avg_profit_factor_count: String(resultCount),
  historic_avg_profit_factor_at: new Date().toISOString()
})
```

## Dashboard Impact
The historical overview will now show:
- **Base PF**: 0.0000 initially → updates to computed value as positions close
- **Closed Positions Count**: 0 → increments with each closed position
- **Chart**: Now has data to render instead of being blank

## Verification
The stats API endpoint `/api/connections/progression/{id}/stats` now always includes:
```json
{
  "historic": {
    "avgProfitFactor": 0.0 | computed_value,
    "avgProfitFactorCount": 0 | count,
    ...
  }
}
```

---

**Commit**: `5689830 fix: always write historic_avg_profit_factor, default to 0 when no closed positions`  
**Status**: ✅ DEPLOYED  
**Impact**: Historical overview Base PF tile now visible from session start
