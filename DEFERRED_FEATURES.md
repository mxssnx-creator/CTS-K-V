# Deferred Features - Implementation Deferral Document

**Date**: June 7, 2026  
**Status**: DEFERRED - For Next Iteration  
**Priority**: MEDIUM (Non-blocking, nice-to-have)

---

## Feature: Prehistoric Progress Tracking (Non-Blocking API)

### Original Goal
Provide stable, real-time prehistoric phase progress reporting without server hangs or timeouts.

### Issues Encountered
1. **Server Startup Hang**: Adding PrehistoricProgressTracker to symbol-data-processor caused dev server to hang during initialization
2. **Root Cause**: Under investigation - likely initialization complexity or Redis operation blocking
3. **Impact**: Unable to complete dev testing with quickstart (5 symbols on BingX)

### Current Workaround Status
- Prehistoric tracking files REMOVED: `lib/prehistoric-progress-tracker.ts`, `app/api/trade-engine/prehistoric-progress/route.ts`
- Symbol processor REVERTED: Tracker integration disabled
- System RESTORED to working state: Build clean, server responds correctly

### Why Deferred
1. Core trading engine is more critical than progress UI
2. Existing progress endpoints (`/api/quickstart/status`, `/api/quickstart/prehistoric-log`) provide basic tracking
3. Implementing atomic counter approach (INCR-based) requires more refinement to avoid blocking
4. Can be implemented in next iteration without affecting core functionality

### Recommended Next Steps for Implementation

#### Option A: Atomic Counter Approach (Recommended)
```typescript
// Use INCR for non-blocking progress
await client.incr(`prehistoric:symbols_processed:${connectionId}`)
await client.incr(`prehistoric:candles_total:${connectionId}`)
// Read current state in <1ms
const count = await client.get(`prehistoric:symbols_processed:${connectionId}`)
```

**Pros**: O(1) operations, no initialization, non-blocking  
**Cons**: Lost on restart (but acceptable for progress UIs)

#### Option B: Timeout-Protected Approach
Wrap all prehistoric operations in Promise.race with tight timeout:
```typescript
await Promise.race([
  symbolProcessor.loadPrehistoric(symbols),
  timeout(3000) // Force failure if hung
])
```

**Pros**: Prevents hangs, fast failure  
**Cons**: May timeout valid operations under load

#### Option C: Remove Prehistoric Progress Feature
If not critical to user workflows, remove entirely.

**Pros**: Simpler codebase  
**Cons**: No real-time progress visibility

### Files Ready for Implementation
- Design: `PREHISTORIC_PROGRESS_FIX.md` (already documented detailed approach)
- Test Plan: `DEV_TEST_REPORT.md` (5 symbols on BingX test case ready)

### Timeline
- **Next Sprint**: Implement Option A (atomic counters)
- **Testing**: 5 BingX symbols, verify <100ms API response time
- **Deployment**: Include in next production release

### Current System Status
- ✅ Core trading engine: WORKING
- ✅ All migrations: COMPLETE (v25)
- ✅ Real stage validation: WORKING
- ✅ ETH/SOL progression: WORKING
- ⏸ Prehistoric progress UI: DEFERRED
- ✅ Build: CLEAN
- ✅ Dev server: RESPONDING

---

**Conclusion**: Feature is well-designed but needs simpler implementation. Core system is production-ready without it.
