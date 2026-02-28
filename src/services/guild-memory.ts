import { Database } from 'bun:sqlite';

export interface InsideJoke {
  id?: number;
  guildId: string;
  joke: string;
  context?: string;
  createdBy: string;
  createdAt: string;
  usageCount: number;
  lastUsed?: string;
}

export interface GuildPreference {
  guildId: string;
  preference: string;
  value: string;
  updatedAt: string;
}

export class GuildMemoryService {
  private db: Database;

  constructor() {
    this.db = new Database('guild_memories.db');
    this.initDatabase();
    console.log('🏰 [GUILD MEMORY] Service initialized with persistent storage');
  }

  private initDatabase(): void {
    // Create inside jokes table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS guild_inside_jokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        joke TEXT NOT NULL,
        context TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        usage_count INTEGER DEFAULT 0,
        last_used TEXT
      )
    `);

    // Create index for guild-specific lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_jokes_guild_id ON guild_inside_jokes(guild_id)
    `);

    // Create index for usage ordering
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_jokes_usage ON guild_inside_jokes(guild_id, usage_count DESC)
    `);

    // Create guild preferences table (for future expansion)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS guild_preferences (
        guild_id TEXT NOT NULL,
        preference TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, preference)
      )
    `);

    console.log('🏰 [GUILD MEMORY] Database initialized');
  }

  /**
   * Store a new inside joke for a guild
   */
  addInsideJoke(guildId: string, joke: string, createdBy: string, context?: string): void {
    const now = new Date().toISOString();
    
    this.db.run(
      `INSERT INTO guild_inside_jokes (guild_id, joke, context, created_by, created_at, usage_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [guildId, joke, context || null, createdBy, now]
    );

    console.log(`🏰 [GUILD MEMORY] Added inside joke for guild ${guildId}`);
  }

  /**
   * Get all inside jokes for a guild
   */
  getInsideJokes(guildId: string): InsideJoke[] {
    const results = this.db.query(
      `SELECT id, guild_id, joke, context, created_by, created_at, usage_count, last_used
       FROM guild_inside_jokes 
       WHERE guild_id = ? 
       ORDER BY usage_count DESC, created_at DESC`
    ).all(guildId) as Array<{
      id: number;
      guild_id: string;
      joke: string;
      context: string | null;
      created_by: string;
      created_at: string;
      usage_count: number;
      last_used: string | null;
    }>;

    return results.map(r => ({
      id: r.id,
      guildId: r.guild_id,
      joke: r.joke,
      context: r.context || undefined,
      createdBy: r.created_by,
      createdAt: r.created_at,
      usageCount: r.usage_count,
      lastUsed: r.last_used || undefined,
    }));
  }

  /**
   * Get a random inside joke for a guild
   */
  getRandomInsideJoke(guildId: string): InsideJoke | null {
    const results = this.db.query(
      `SELECT id, guild_id, joke, context, created_by, created_at, usage_count, last_used
       FROM guild_inside_jokes 
       WHERE guild_id = ? 
       ORDER BY RANDOM() 
       LIMIT 1`
    ).all(guildId) as Array<{
      id: number;
      guild_id: string;
      joke: string;
      context: string | null;
      created_by: string;
      created_at: string;
      usage_count: number;
      last_used: string | null;
    }>;

    if (results.length === 0) {
      return null;
    }

    const r = results[0]!;
    return {
      id: r.id,
      guildId: r.guild_id,
      joke: r.joke,
      context: r.context || undefined,
      createdBy: r.created_by,
      createdAt: r.created_at,
      usageCount: r.usage_count,
      lastUsed: r.last_used || undefined,
    };
  }

  /**
   * Increment usage count for a joke
   */
  incrementJokeUsage(jokeId: number): void {
    const now = new Date().toISOString();
    
    this.db.run(
      `UPDATE guild_inside_jokes 
       SET usage_count = usage_count + 1, last_used = ?
       WHERE id = ?`,
      [now, jokeId]
    );

    console.log(`🏰 [GUILD MEMORY] Incremented usage for joke ${jokeId}`);
  }

  /**
   * Delete an inside joke
   */
  deleteInsideJoke(jokeId: number): void {
    this.db.run('DELETE FROM guild_inside_jokes WHERE id = ?', [jokeId]);
    console.log(`🏰 [GUILD MEMORY] Deleted inside joke ${jokeId}`);
  }

  /**
   * Get formatted inside jokes context for system prompt
   */
  getInsideJokesContext(guildId: string): string {
    const jokes = this.getInsideJokes(guildId);

    if (jokes.length === 0) {
      return '';
    }

    const formattedJokes = jokes
      .slice(0, 5) // Limit to 5 most used jokes
      .map((joke, index) => {
        let text = `${index + 1}. "${joke.joke}"`;
        if (joke.context) {
          text += ` (Context: ${joke.context})`;
        }
        return text;
      })
      .join('\n');

    return `
<guild-context type="inside-jokes">
Server-specific inside jokes. Reference naturally when they fit — don't force them.

${formattedJokes}
</guild-context>
`;
  }

  /**
   * Check if a guild has any inside jokes
   */
  hasInsideJokes(guildId: string): boolean {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM guild_inside_jokes WHERE guild_id = ?'
    ).get(guildId) as { count: number };
    
    return result.count > 0;
  }

  /**
   * Get inside joke count for a guild
   */
  getJokeCount(guildId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM guild_inside_jokes WHERE guild_id = ?'
    ).get(guildId) as { count: number };
    
    return result.count;
  }

  /**
   * List all guilds with inside jokes
   */
  listGuildsWithJokes(): Array<{ guildId: string; jokeCount: number }> {
    const results = this.db.query(
      `SELECT guild_id, COUNT(*) as count 
       FROM guild_inside_jokes 
       GROUP BY guild_id`
    ).all() as Array<{ guild_id: string; count: number }>;

    return results.map(r => ({
      guildId: r.guild_id,
      jokeCount: r.count,
    }));
  }
}

// Singleton instance
export const guildMemoryService = new GuildMemoryService();
