# Real Stage Strategy Caps & Limits

## Quick Reference Table

| Category | Setting | Default | Min | Max | Unit | Operator-Tunable | Code Location |
|----------|---------|---------|-----|-----|------|------------------|---|
| **Set Count** | `maxRealSets` (safety ceiling) | 12,000 | 100 | ∞ | count | ✓ | `strategy-coordinator.ts:2344` |
| **Profit Factor** | `realProfitFactor` | 1.0 | 1.0 | ∞ | ratio | ✓ | `strategy-coordinator.ts:756` |
| **PF Quickstart** | Relaxation trigger | 0.75 | 0.75 | 1.0 | ratio | — | `strategy-coordinator.ts:2075` |
| **Entry Count** | `realEvalPosCount` | 10 | 1 | 1000 | count | ✓ | `strategy-coordinator.ts:2047` |
| **Entry Quickstart** | Min entries on livestart | 1-3 | 1 | 3 | count | — | `strategy-coordinator.ts:2071` |
| **Operator Min Pos** | `stageMinPosCountReal` | 1 | 5 | 50 | count | ✓ (snapped to 5) | `strategy-coordinator.ts:777` |
| **DDT Hours** | `maxDrawdownTimeRealHours` | 4 | 1 | 72 | hours | ✓ | `strategy-coordinator.ts:794` |
| **Size Multiplier** | Real tuning bounds | 1.0 | 0.5 | 1.5 | ratio | — | `strategy-coordinator.ts:2366` |
| **Leverage Max** | From Base position | 2.0 | 1.0 | 2.0 | × | — | `strategy-coordinator.ts:2365` |
| **Leverage %** | `leveragePercentage` | 100 | 1 | 10 | % | ✓ | `redis-migrations.ts:1446` |
| **Position Concurrency** | Realtime per symbol | 8 | 1 | 8 | parallel | — | `realtime-processor.ts` |
| **Samples Ring** | Real averages cap | 600 | 100 | 1000 | samples | — | `strategy-coordinator.ts:2735` |

---

## Detailed Specs

### 1. SET COUNT LIMITS

#### `maxRealSets` - Safety Ceiling
- **Default**: 12,000 sets
- **Purpose**: Prevent OOM SIGKILL (encountered at Infinity → 7.3GB RSS)
- **Behavior**: 
  - Slices `realPostHedge` array to top N by rank
  - Sets already sorted best-first, so tail is pathological outliers
  - When exceeded: warning logged, top N kept
  - Operator can override via Settings → System
- **Application**: `const realSets = realPostHedge.slice(0, realSetsCap)`

---

### 2. PROFIT FACTOR (PF) GATES

#### `realProfitFactor` Minimum
- **Default**: 1.0
- **Storage**: `connection_settings:bingx-x01.realProfitFactor`
- **Override Chain**: Connection hash → Global app_settings → Default 1.0
- **Clamp**: `clamp(value, 1.0)` (no upper limit)
- **Gate**: Sets with `profitFactor < realProfitFactor` → invalid (not evaluated)

#### PF Quickstart Relaxation
- **Trigger**: `is_live_trade === true` on fresh connection
- **Relaxation**: `Math.min(realMinPF, 0.75)`
- **Effect**: Allows lower-PF axis/profile sets to generate orders cycle 1
- **Duration**: Until history accumulates (automatic return to strictness)
- **Code**: `if (liveOn) realMinPF = relaxed;`

---

### 3. POSITION COUNT (ENTRY COUNT) GATES

#### `realEvalPosCount` Minimum
- **Default**: 10 positions
- **Storage**: `connection_settings:bingx-x01.realEvalPosCount`
- **Gate**: Sets with `entryCount < realEvalPosCount` → invalid
- **Behavior**: Invalid sets kept for re-eval in future cycles (gradual accumulation)
- **Logic**: Never rejects on entryCount alone (at least 1 synthetic entry passes)

#### Entry Count Quickstart Relaxation
- **Trigger**: `is_live_trade === true`
- **Relaxation**: `Math.max(1, Math.min(realMinPos, 3))`
- **Effect**: Requirement drops to 1-3 entries minimum
- **Code**: `if (liveOn) realMinPos = Math.max(1, Math.min(realMinPos, 3));`

#### `stageMinPosCountReal` Operator Backstop
- **Default**: 1
- **Storage**: `connection_settings:bingx-x01.stageMinPosCountReal`
- **Clamp**: [5, 50], snapped to nearest 5
- **Logic**: `Math.min(50, Math.max(5, Math.round(n/5)*5))`
- **Purpose**: Global minimum independent of history

---

### 4. DRAWDOWN TIME (DDT) GATES

#### `maxDrawdownTimeRealHours` Ceiling
- **Default**: 4 hours (240 minutes)
- **Storage**: `connection_settings:bingx-x01.maxDrawdownTimeRealHours`
- **Clamp**: [1, 72] hours
- **Conversion**: Hours → Minutes (×60)
- **Gate**: Sets with `avgDrawdownTime > ceiling` → invalid
- **Semantics**: Per-position hold ~2h, so 4h = 2× headroom

---

### 5. LEVERAGE & SIZING

#### `leveragePercentage` Multiplier
- **Default**: 100% (1:1)
- **Range**: [1, 10]
- **Application**: Volume-calculator overlay on position sizing
- **Storage**: `connection_settings:bingx-x01.leveragePercentage`

#### Size Multiplier Bounds (Real tuning)
- **Lower**: 0.5 (50% of Base sizing)
- **Upper**: 1.5 (150% of Base sizing)
- **Purpose**: Tuning per-Base Set performance without extreme distortion
- **Safeguard**: Noisy bucket can never explode exposure

#### Max Leverage from Base
- **Limit**: 2× of Base position
- **Enforcement**: Hardcoded in Real-stage tuner
- **Purpose**: Prevent unchecked leverage cascade

---

### 6. CONCURRENCY & MEMORY

#### Position Concurrency
- **Cap**: 8 per symbol per cycle
- **Enforcement**: Bounded `Promise.all` in realtime-processor
- **Purpose**: Event-loop safety
- **Previous**: Unbounded (caused timeouts on 100+ positions)

#### Real Samples Ring
- **Cap**: 600 samples
- **TTL**: 3600 seconds (1 hour)
- **Write**: Per-cycle via `lpush + ltrim + expire`
- **Memory**: Bounded O(1), no leak risk

---

### 7. STAGE FLOW

```
Main Sets (N)
    ↓
[PF gate: realProfitFactor ≥ 1.0]
    ↓
[Entry gate: entryCount ≥ realEvalPosCount (default 10)]
    ↓
[DDT gate: avgDrawdownTime ≤ maxDrawdownTimeRealHours (default 240 min)]
    ↓
[Quickstart relaxation: PF → 0.75, entry → 1-3]
    ↓
Real Sets (M ≤ N)
    ↓
[Hedge netting: long-short bucketing]
    ↓
[Set count cap: maxRealSets (default 12,000)]
    ↓
Real-tuned Sets (K ≤ M)
    ↓
Live Stage [Phase 4]
```

---

### 8. GATE REJECTION SEMANTICS

- **Invalid Set**: Failed one or more gates (PF/entry/DDT)
  - NOT promoted to Live
  - Kept in map for future re-evaluation
  - No error log (normal behavior)
  - Will re-evaluate as history/entries accumulate

- **Skipped Symbol**: Zero candles (data missing)
  - Processing skipped entirely
  - Still counts toward prehistoric progress
  - No halt to pipeline

---

### 9. OPERATOR TUNING

All Real-stage limits are tunable via **Settings → Strategy → Real tab**:
- Real Profit Factor (default 1.0)
- Max Drawdown-Time (default 4 hours)
- Real Min Entry Count (default 10)
- Stage Min Pos Count (default 1, clamped [5,50])
- Max Real Sets (default 12,000)

Changes apply on next cycle (no engine restart required).

---

### 10. SAFETY DESIGN PRINCIPLES

1. **Memory Safety**: Hard 12k Set cap (prevents 7GB+ process death)
2. **Event Loop**: Concurrency per-symbol (prevents timeouts)
3. **Gradual Qualification**: Invalid sets kept for future cycles (no rejection noise)
4. **Quickstart**: Auto-relax gates when live trading enabled (cycle-1 orders)
5. **Operator Control**: All major gates tunable via UI (no hardcodes)
6. **Hedge Netting**: Long-short bucketing prevents directional imbalance
7. **Leverage Bounds**: 0.5-1.5 multiplier + 2× max (prevents exposure explosion)
8. **Historic Lock-in**: Once Base history exists, maintains consistency
9. **Sorted Tailing**: Real Sets already best-first, so drop is pathological
10. **Error Resilience**: Errored symbols don't halt pipeline (continue on)

---

## Configuration Files

- **Engine coordinator**: `lib/strategy-coordinator.ts`
  - Load at line 704
  - Evaluate at line 2023
  - Cap at line 2344
  - Quickstart at line 2050

- **Detailed tracking**: `lib/detailed-tracking.ts`
  - Resolution at line 338

- **Migrations**: `lib/redis-migrations.ts`
  - Defaults at line 1100
  - Seeds at line 1438

---

**Last Updated**: June 8, 2026  
**Status**: Production (verified)
