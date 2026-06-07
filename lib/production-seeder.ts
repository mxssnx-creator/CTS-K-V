/**
 * Production Seeder
 * Seeds essential data for production mode: settings, connections, market data
 */

import { saveSettings } from "@/lib/settings-storage"
import { saveConnection } from "@/lib/redis-db"
import { loadMarketDataForEngine } from "@/lib/market-data-loader"
import { getPredefinedAsExchangeConnections } from "@/lib/connection-predefinitions"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { setSettings } from "@/lib/redis-db"

export interface ProductionSeedOptions {
  seedSettings?: boolean
  seedConnections?: boolean
  seedMarketData?: boolean
  seedProgression?: boolean
  symbols?: string[]
}

/**
 * Seed all essential production data
 */
export async function seedProductionData(options: ProductionSeedOptions = {}): Promise<void> {
  console.log("[v0] [ProductionSeeder] Starting production data seeding...")
   
  try {
    await initRedis()
    
    // Seed default settings if none exist
    if (options.seedSettings !== false) {
      await seedDefaultSettings()
    }
    
    // Seed predefined connections if none exist
    if (options.seedConnections !== false) {
      await seedPredefinedConnections()
    }
    
    // Seed market data for trading
    if (options.seedMarketData !== false) {
      await seedMarketData(options.symbols)
    }
    
    // Seed progression state
    if (options.seedProgression !== false) {
      await seedProgressionState()
    }
    
    console.log("[v0] [ProductionSeeder] ✅ Production data seeding completed")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed production data:", error)
    throw error
  }
}

/**
 * Seed default application settings
 */
async function seedDefaultSettings(): Promise<void> {
  try {
    // Check if settings already exist via getAppSettings (canonical source)
    const { getAppSettings } = await import("@/lib/redis-db")
    const existingSettings = await getAppSettings()
    if (Object.keys(existingSettings).length > 0) {
      console.log("[v0] [ProductionSeeder] Settings already exist, skipping...")
      return
    }
    
    // Default production settings
    const defaultSettings = {
      cyclePauseMs: 50,
      mainEngineIntervalMs: 700,
      presetEngineIntervalMs: 120000,
      strategyUpdateIntervalMs: 10000,
      realtimeIntervalMs: 300,
      mainEngineEnabled: true,
      presetEngineEnabled: true,
      minimum_connect_interval: 200,
      theme: "dark",
      language: "en",
      notifications_enabled: true,
      default_leverage: 10,
      default_volume: 100,
      max_open_positions: 10,
      max_drawdown_percent: 20,
      daily_loss_limit: 1000,
      main_symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
      forced_symbols: [],
      database_type: "redis",
      restApiDelayMs: 50,
      publicRequestDelayMs: 20,
      privateRequestDelayMs: 100,
      websocketTimeoutMs: 30000,
      strategyMainMaxPseudoPositionsLong: 1,
      strategyMainMaxPseudoPositionsShort: 1,
      databaseLimitPerSecond: 10000,
      databaseLimitPerMinute: 500000,
      databaseLimitPerDay: 0,
    }
    
    // Save to Redis (canonical location for engine reads)
    await setSettings("app_settings", defaultSettings)
    // Also save to file-based storage for backward compatibility
    saveSettings(defaultSettings)
    console.log("[v0] [ProductionSeeder] ✅ Default settings seeded")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed settings:", error)
    throw error
  }
}

/**
 * Seed predefined exchange connections
 */
async function seedPredefinedConnections(): Promise<void> {
  try {
    const client = getRedisClient()
    const connectionsKey = "all_connections"
    
    // In production always ensure complete state (no early skip)
    const { isProductionEnvironment } = await import("@/lib/redis-db")
    if (!isProductionEnvironment()) {
      const existingConnections = await client.get(connectionsKey)
      if (existingConnections) {
        console.log("[v0] [ProductionSeeder] Connections already exist, skipping...")
        return
      }
    }
    
    // Get predefined connections
    const predefinedConnections = getPredefinedAsExchangeConnections()
    
    // Enable BingX X01 for immediate trading (it has real credentials)
    // Quick-start requires non-predefined connections, so we set is_predefined: false
    // and mark it as enabled/active/live_trade for production use
    const enabledConnections = predefinedConnections.map((conn, idx) => ({
      ...conn,
      // First connection (bingx-x01) gets enabled for immediate trading
      is_enabled: "1",
      is_active: idx === 0 ? "1" : "0",
      is_live_trade: idx === 0 ? "1" : "0",
      is_assigned: idx === 0 ? "1" : "0",
      is_dashboard_inserted: idx === 0 ? "1" : "0",
      is_enabled_dashboard: idx === 0 ? "1" : "0",
      is_inserted: idx === 0 ? "1" : "0",
      // Mark as NOT predefined so quick-start can find it (string "false" for Redis consistency)
      is_predefined: "false",
      active_symbols: idx === 0 ? JSON.stringify([]) : "[]",
      live_volume_factor: idx === 0 ? "0.1" : "1",
    }))
    
    // Save individual connections to Redis (connection:{id} hashes)
    for (const conn of enabledConnections) {
      await saveConnection(conn)
    }
    
    // Store the connection list for quick lookup
    await client.set(connectionsKey, JSON.stringify(enabledConnections))
    
    console.log(`[v0] [ProductionSeeder] ✅ Seeded ${enabledConnections.length} connections, bingx-x01 enabled for trading`)
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed connections:", error)
    throw error
  }
}

/**
 * Seed initial market data
 */
async function seedMarketData(symbols: string[] = []): Promise<void> {
  try {
    console.log("[v0] [ProductionSeeder] Seeding initial market data...")
    
    const targetSymbols = symbols.length > 0 ? symbols : [
      "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
      "DOGEUSDT", "LINKUSDT", "LTCUSDT", "THETAUSDT", "AVAXUSDT",
      "MATICUSDT", "SOLUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT"
    ]
    
    // Load market data for engine
    const loaded = await loadMarketDataForEngine(targetSymbols)
    
    if (loaded > 0) {
      console.log(`[v0] [ProductionSeeder] ✅ Market data seeded for ${loaded} symbols`)
    } else {
      console.warn("[v0] [ProductionSeeder] ⚠ No market data loaded")
    }
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed market data:", error)
    throw error
  }
}

/**
 * Seed initial progression state
 */
async function seedProgressionState(): Promise<void> {
  try {
    console.log("[v0] [ProductionSeeder] Seeding progression state...")
    
    const client = getRedisClient()
    
    // In production we never skip — we always run the full coverage repair
    // so that progression counters are guaranteed correct after redeploy.
    const { isProductionEnvironment } = await import("@/lib/redis-db")
    if (!isProductionEnvironment()) {
      const progressionKeys = await client.keys("progression:*")
      if (progressionKeys.length > 0) {
        console.log("[v0] [ProductionSeeder] Progression state already exists, skipping...")
        return
      }
    }
    
    // Get all connections to create progression states for
    const connections = await client.get("all_connections")
    if (!connections) {
      console.log("[v0] [ProductionSeeder] No connections found, skipping progression seeding")
      return
    }
    
    const connectionsArray = JSON.parse(connections)
    
    // Create initial progression state for each connection
    // is_enabled and is_active are stored as "1"/"0" strings in Redis
    for (const conn of connectionsArray) {
      if (conn.is_enabled === "1" && conn.is_active === "1") {
        await ProgressionStateManager.archiveAndStartNewProgression(
          conn.id,
          Date.now()
        )
      }
    }
    
    console.log("[v0] [ProductionSeeder] ✅ Progression state seeded")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Failed to seed progression state:", error)
    throw error
  }
}

/**
 * Force reseed all production data (use with caution)
 */
export async function forceReseedProductionData(): Promise<void> {
  console.log("[v0] [ProductionSeeder] Force reseeding all production data...")
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Clear existing data
    const keysToClear = [
      "app_settings",
      "all_connections",
      ...(await client.keys("market_data:*")),
      ...(await client.keys("progression:*")),
      ...(await client.keys("trade_engine_state:*")),
      ...(await client.keys("settings:*")),
      ...(await client.keys("connection:*")),
    ]
    
    if (keysToClear.length > 0) {
      await client.del(...keysToClear)
      console.log(`[v0] [ProductionSeeder] Cleared ${keysToClear.length} keys`)
    }
    
    // Reseed everything
    await seedProductionData({
      seedSettings: true,
      seedConnections: true,
      seedMarketData: true,
      seedProgression: true
    })
    
    console.log("[v0] [ProductionSeeder] ✅ Force reseeding completed")
  } catch (error) {
    console.error("[v0] [ProductionSeeder] ❌ Force reseeding failed:", error)
    throw error
  }
}

/**
 * Auto-seed on module load if in production mode
 */
if (process.env.NODE_ENV === "production") {
  seedProductionData().catch(console.error)
}

export default {
  seedProductionData,
  seedDefaultSettings,
  seedPredefinedConnections,
  seedMarketData,
  seedProgressionState,
  forceReseedProductionData
}