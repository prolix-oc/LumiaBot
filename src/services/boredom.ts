import { Database } from 'bun:sqlite';
import { getRandomBoredomMessage as getPromptBoredomMessage } from './prompts';

export interface BoredomSettings {
  userId: string;
  guildId: string;
  enabled: boolean;
  lastInteractionAt: string;
  lastPingedAt: string | null;
  pingCount: number;
}

export interface PendingPing {
  userId: string;
  guildId: string;
  username: string;
  channelId: string;
  scheduledFor: Date;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export class BoredomService {
  private db: Database;
  private pendingPings: Map<string, PendingPing> = new Map();
  private readonly MIN_BOREDOM_MINUTES = 10;
  private readonly MAX_BOREDOM_MINUTES = 60;

  constructor() {
    this.db = new Database('boredom.db');
    this.initDatabase();
    console.log('😴 [BOREDOM] Service initialized (10-60 min boredom timer)');
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS boredom_settings (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        enabled BOOLEAN DEFAULT 1,
        last_interaction_at TEXT NOT NULL,
        last_pinged_at TEXT,
        ping_count INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, guild_id)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_boredom_user_guild ON boredom_settings(user_id, guild_id)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_boredom_guild ON boredom_settings(guild_id)
    `);

    console.log('😴 [BOREDOM] Database initialized');
  }

  /**
   * Generate a random boredom delay between 10-60 minutes
   */
  private getRandomBoredomDelay(): number {
    const minMs = this.MIN_BOREDOM_MINUTES * 60 * 1000;
    const maxMs = this.MAX_BOREDOM_MINUTES * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Get or create boredom settings for a user in a guild
   */
  getSettings(userId: string, guildId: string): BoredomSettings {
    const result = this.db.query(
      'SELECT * FROM boredom_settings WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as BoredomSettings | undefined;

    if (result) {
      return result;
    }

    // Create default settings (DISABLED by default - opt-in model)
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO boredom_settings (user_id, guild_id, enabled, last_interaction_at, ping_count)
       VALUES (?, ?, 0, ?, 0)`,
      [userId, guildId, now]
    );

    return {
      userId,
      guildId,
      enabled: false,
      lastInteractionAt: now,
      lastPingedAt: null,
      pingCount: 0,
    };
  }

  /**
   * Check if user has opted out of boredom pings
   */
  isEnabled(userId: string, guildId: string): boolean {
    const settings = this.getSettings(userId, guildId);
    return settings.enabled;
  }

  /**
   * Enable or disable boredom pings for a user
   */
  setEnabled(userId: string, guildId: string, enabled: boolean): void {
    const settings = this.getSettings(userId, guildId);
    
    this.db.run(
      `UPDATE boredom_settings 
       SET enabled = ?
       WHERE user_id = ? AND guild_id = ?`,
      [enabled ? 1 : 0, userId, guildId]
    );

    if (enabled) {
      console.log(`😴 [BOREDOM] Enabled for user ${userId} in guild ${guildId}`);
    } else {
      console.log(`😴 [BOREDOM] Disabled for user ${userId} in guild ${guildId}`);
      // Cancel any pending ping
      this.cancelPendingPing(userId, guildId);
    }
  }

  /**
   * Opt out a user from boredom pings
   */
  optOut(userId: string, guildId: string): void {
    this.setEnabled(userId, guildId, false);
    console.log(`😴 [BOREDOM] User ${userId} opted out in guild ${guildId}`);
  }

  /**
   * Opt in a user to boredom pings
   */
  optIn(userId: string, guildId: string): void {
    this.setEnabled(userId, guildId, true);
    console.log(`😴 [BOREDOM] User ${userId} opted in in guild ${guildId}`);
  }

  /**
   * Record an interaction with a user and schedule a boredom ping
   */
  recordInteraction(
    userId: string,
    guildId: string,
    username: string,
    channelId: string,
    onPing: (userId: string, guildId: string, username: string, channelId: string) => void
  ): void {
    const now = new Date().toISOString();
    const settings = this.getSettings(userId, guildId);

    // Update last interaction time
    this.db.run(
      `UPDATE boredom_settings 
       SET last_interaction_at = ?
       WHERE user_id = ? AND guild_id = ?`,
      [now, userId, guildId]
    );

    // Cancel any existing pending ping
    this.cancelPendingPing(userId, guildId);

    // Only schedule if enabled
    if (!settings.enabled) {
      console.log(`😴 [BOREDOM] User ${username} is opted out, no ping scheduled`);
      return;
    }

    // Schedule new boredom ping
    const delay = this.getRandomBoredomDelay();
    const scheduledFor = new Date(Date.now() + delay);

    const timeoutId = setTimeout(() => {
      this.executePing(userId, guildId, username, channelId, onPing);
    }, delay);

    const pingKey = `${userId}:${guildId}`;
    this.pendingPings.set(pingKey, {
      userId,
      guildId,
      username,
      channelId,
      scheduledFor,
      timeoutId,
    });

    console.log(`😴 [BOREDOM] Scheduled ping for ${username} in ${Math.round(delay / 60000)} minutes (${scheduledFor.toLocaleTimeString()})`);
  }

  /**
   * Cancel a pending ping for a user
   */
  private cancelPendingPing(userId: string, guildId: string): void {
    const pingKey = `${userId}:${guildId}`;
    const pending = this.pendingPings.get(pingKey);
    
    if (pending?.timeoutId) {
      clearTimeout(pending.timeoutId);
      this.pendingPings.delete(pingKey);
      console.log(`😴 [BOREDOM] Cancelled pending ping for ${pending.username}`);
    }
  }

  /**
   * Execute a boredom ping
   */
  private executePing(
    userId: string,
    guildId: string,
    username: string,
    channelId: string,
    onPing: (userId: string, guildId: string, username: string, channelId: string) => void
  ): void {
    const pingKey = `${userId}:${guildId}`;
    this.pendingPings.delete(pingKey);

    // Check if still enabled
    if (!this.isEnabled(userId, guildId)) {
      console.log(`😴 [BOREDOM] Ping cancelled - user ${username} is opted out`);
      return;
    }

    // Update ping stats
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE boredom_settings 
       SET last_pinged_at = ?, ping_count = ping_count + 1
       WHERE user_id = ? AND guild_id = ?`,
      [now, userId, guildId]
    );

    console.log(`😴 [BOREDOM] Executing ping for ${username}`);
    onPing(userId, guildId, username, channelId);
  }

  /**
   * Get boredom stats for a user
   */
  getStats(userId: string, guildId: string): {
    enabled: boolean;
    lastInteraction: string;
    lastPinged: string | null;
    pingCount: number;
    hasPendingPing: boolean;
    nextPingAt: string | null;
  } {
    const settings = this.getSettings(userId, guildId);
    const pingKey = `${userId}:${guildId}`;
    const pending = this.pendingPings.get(pingKey);

    return {
      enabled: settings.enabled,
      lastInteraction: settings.lastInteractionAt,
      lastPinged: settings.lastPingedAt,
      pingCount: settings.pingCount,
      hasPendingPing: !!pending,
      nextPingAt: pending?.scheduledFor.toISOString() || null,
    };
  }

  /**
   * List all users with boredom settings in a guild
   */
  listGuildUsers(guildId: string): Array<{
    userId: string;
    enabled: boolean;
    lastInteraction: string;
    pingCount: number;
  }> {
    const results = this.db.query(
      `SELECT user_id, enabled, last_interaction_at, ping_count
       FROM boredom_settings
       WHERE guild_id = ?
       ORDER BY last_interaction_at DESC`
    ).all(guildId) as Array<{
      user_id: string;
      enabled: number;
      last_interaction_at: string;
      ping_count: number;
    }>;

    return results.map(r => ({
      userId: r.user_id,
      enabled: r.enabled === 1,
      lastInteraction: r.last_interaction_at,
      pingCount: r.ping_count,
    }));
  }

  /**
   * Clean up on shutdown
   */
  cleanup(): void {
    console.log('😴 [BOREDOM] Cleaning up pending pings...');
    for (const [key, pending] of this.pendingPings) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
    }
    this.pendingPings.clear();
    console.log('😴 [BOREDOM] All pending pings cancelled');
  }
}

// Singleton instance
export const boredomService = new BoredomService();

// Boredom messages are now loaded dynamically from prompt_storage/persona/boredom_pings.json
// Use getRandomBoredomMessage from './prompts' instead

export function getRandomBoredomMessage(userId: string): string {
  return getPromptBoredomMessage(userId);
}
