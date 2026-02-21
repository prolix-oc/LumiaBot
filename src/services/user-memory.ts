import { Database } from 'bun:sqlite';
import { config } from '../utils/config';

export interface UserOpinion {
  id?: number;
  userId: string;
  username: string;
  opinion: string;
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  pronouns?: string | null;
  thirdPartyContext?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedMention {
  userId: string;
  username: string;
  context: string;
  mentionedBy: string;
  timestamp: string;
}

export class UserMemoryService {
  private static readonly MAX_OPINION_ENTRIES = 10;
  private static readonly MAX_THIRD_PARTY_ENTRIES = 15;
  private db: Database;

  constructor() {
    // Use SQLite for user memory storage
    this.db = new Database('user_memories.db');
    this.initDatabase();
  }

  private initDatabase(): void {
    // Create table if it doesn't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        opinion TEXT NOT NULL,
        sentiment TEXT NOT NULL,
        pronouns TEXT,
        third_party_context TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create index for faster lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_id ON user_opinions(user_id)
    `);

    // Migration: Add missing columns if table exists but columns don't
    this.migrateAddColumn('pronouns', 'TEXT');
    this.migrateAddColumn('third_party_context', 'TEXT');

    console.log('💾 [USER MEMORY] Database initialized');
  }

  private migrateAddColumn(columnName: string, columnType: string): void {
    try {
      // Check if column exists
      const result = this.db.query(
        `SELECT COUNT(*) as count FROM pragma_table_info('user_opinions') WHERE name = ?`
      ).get(columnName) as { count: number };

      if (result.count === 0) {
        // Column doesn't exist, add it
        this.db.run(`ALTER TABLE user_opinions ADD COLUMN ${columnName} ${columnType}`);
        console.log(`💾 [USER MEMORY] Migration: Added column '${columnName}'`);
      }
    } catch (error) {
      console.error(`💾 [USER MEMORY] Migration failed for column '${columnName}':`, error);
    }
  }

  /**
   * Store a new opinion about a user
   */
  storeOpinion(userId: string, username: string, opinion: string, sentiment: UserOpinion['sentiment']): void {
    const now = new Date().toISOString();
    
    // Check if we already have an opinion for this user
    const existing = this.getOpinion(userId);
    
    if (existing) {
      // Update existing opinion - append new thoughts with rolling window
      const entries = existing.opinion.split(/\n\n(?=\[)/);
      entries.push(`[${now}] ${opinion}`);

      // Keep only the most recent entries to prevent unbounded growth
      const trimmed = entries.slice(-UserMemoryService.MAX_OPINION_ENTRIES);
      const combinedOpinion = trimmed.join('\n\n');

      this.db.run(
        `UPDATE user_opinions
         SET opinion = ?, sentiment = ?, updated_at = ?
         WHERE user_id = ?`,
        [combinedOpinion, sentiment, now, userId]
      );

      console.log(`💾 [USER MEMORY] Updated opinion for ${username} (${sentiment}, ${trimmed.length} entries)`);
    } else {
      // Insert new opinion
      this.db.run(
        `INSERT INTO user_opinions (user_id, username, opinion, sentiment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, username, opinion, sentiment, now, now]
      );
      
      console.log(`💾 [USER MEMORY] Stored new opinion for ${username} (${sentiment})`);
    }
  }

  /**
   * Store or update user's pronouns
   */
  storePronouns(userId: string, username: string, pronouns: string): void {
    const now = new Date().toISOString();
    
    // Check if user exists
    const existing = this.getOpinion(userId);
    
    if (existing) {
      // Update pronouns
      this.db.run(
        `UPDATE user_opinions 
         SET pronouns = ?, updated_at = ?
         WHERE user_id = ?`,
        [pronouns, now, userId]
      );
      
      console.log(`💾 [USER MEMORY] Updated pronouns for ${username}: ${pronouns}`);
    } else {
      // Insert new record with minimal opinion
      this.db.run(
        `INSERT INTO user_opinions (user_id, username, opinion, sentiment, pronouns, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, username, `[${now}] First interaction`, 'neutral', pronouns, now, now]
      );
      
      console.log(`💾 [USER MEMORY] Stored new user ${username} with pronouns: ${pronouns}`);
    }
  }

  /**
   * Store third-party context about a user (what others say about them)
   */
  storeThirdPartyContext(mention: ExtractedMention): void {
    const now = new Date().toISOString();
    
    // Check if user exists
    const existing = this.getOpinion(mention.userId);
    
    const contextEntry = `[${now}] ${mention.mentionedBy} mentioned: "${mention.context}"`;
    
    if (existing) {
      // Append to existing third party context with rolling window
      const existingEntries = existing.thirdPartyContext
        ? existing.thirdPartyContext.split(/\n(?=\[)/)
        : [];
      existingEntries.push(contextEntry);

      // Keep only the most recent entries to prevent unbounded growth
      const trimmed = existingEntries.slice(-UserMemoryService.MAX_THIRD_PARTY_ENTRIES);
      const combinedContext = trimmed.join('\n');

      this.db.run(
        `UPDATE user_opinions
         SET third_party_context = ?, updated_at = ?
         WHERE user_id = ?`,
        [combinedContext, now, mention.userId]
      );

      console.log(`💾 [USER MEMORY] Added third-party context for ${mention.username} (${trimmed.length} entries)`);
    } else {
      // Insert new record
      this.db.run(
        `INSERT INTO user_opinions (user_id, username, opinion, sentiment, third_party_context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [mention.userId, mention.username, `[${now}] Mentioned by ${mention.mentionedBy}`, 'neutral', contextEntry, now, now]
      );
      
      console.log(`💾 [USER MEMORY] Stored new user ${mention.username} with third-party context`);
    }
  }

  /**
   * Sync the stored username with the current Discord username.
   * Prevents stale/incorrect usernames from being injected into the system prompt.
   */
  syncUsername(userId: string, currentUsername: string): void {
    const existing = this.db.query(
      'SELECT username FROM user_opinions WHERE user_id = ? LIMIT 1'
    ).get(userId) as { username: string } | undefined;

    if (existing && existing.username !== currentUsername) {
      this.db.run(
        'UPDATE user_opinions SET username = ? WHERE user_id = ?',
        [currentUsername, userId]
      );
      console.log(`💾 [USER MEMORY] Synced username for ${userId}: "${existing.username}" → "${currentUsername}"`);
    }
  }

  /**
   * Get opinion for a specific user
   */
  getOpinion(userId: string): UserOpinion | null {
    const result = this.db.query(
      'SELECT * FROM user_opinions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(userId) as UserOpinion | undefined;

    if (result) {
      console.log(`💾 [USER MEMORY] Retrieved opinion for user ${result.username}`);
    }

    return result || null;
  }

  /**
   * Get opinion by username (case insensitive)
   */
  getOpinionByUsername(username: string): UserOpinion | null {
    const result = this.db.query(
      'SELECT * FROM user_opinions WHERE LOWER(username) = LOWER(?) ORDER BY updated_at DESC LIMIT 1'
    ).get(username) as UserOpinion | undefined;

    if (result) {
      console.log(`💾 [USER MEMORY] Retrieved opinion by username: ${result.username}`);
    }

    return result || null;
  }

  /**
   * List all users Lumia has opinions about
   */
  listUsers(): Array<{ userId: string; username: string; sentiment: string; updatedAt: string }> {
    const results = this.db.query(
      `SELECT user_id, username, sentiment, updated_at 
       FROM user_opinions 
       ORDER BY updated_at DESC`
    ).all() as Array<{ user_id: string; username: string; sentiment: string; updated_at: string }>;

    console.log(`💾 [USER MEMORY] Listed ${results.length} users with opinions`);

    return results.map(r => ({
      userId: r.user_id,
      username: r.username,
      sentiment: r.sentiment,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Delete a user's opinion
   */
  deleteOpinion(userId: string): void {
    this.db.run('DELETE FROM user_opinions WHERE user_id = ?', [userId]);
    console.log(`💾 [USER MEMORY] Deleted opinion for user ${userId}`);
  }

  /**
   * Get opinion context string for system prompt
   */
  getOpinionContext(userId: string): string {
    const opinion = this.getOpinion(userId);
    
    if (!opinion) {
      return '';
    }

    let context = `
## Your Memories About This User

Username: ${opinion.username}
Sentiment: ${opinion.sentiment}
Your thoughts: ${opinion.opinion}
`;

    // Pronouns are displayed in the CURRENT USER CONTEXT section of the system prompt
    // so they are intentionally not duplicated here

    // Add third-party context if exists
    if (opinion.thirdPartyContext) {
      context += `\nWhat others have said:\n${opinion.thirdPartyContext}\n`;
    }

    context += `
Use these memories naturally in your response without explicitly mentioning that you're "recalling" anything.`;

    return context;
  }

  /**
   * Get user identity context (username + pronouns) for system prompt
   * This is separate from opinion context and always available
   */
  getUserIdentityContext(userId: string): string {
    const opinion = this.getOpinion(userId);
    
    if (!opinion) {
      return '';
    }

    let context = `**Username:** ${opinion.username}`;
    
    if (opinion.pronouns) {
      context += `\n**Pronouns:** ${opinion.pronouns}`;
    }
    
    return context;
  }

  /**
   * Check if user exists in memory
   */
  hasOpinion(userId: string): boolean {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM user_opinions WHERE user_id = ?'
    ).get(userId) as { count: number };
    
    return result.count > 0;
  }

  /**
   * Get pronouns for a user, or return null if not set
   */
  getPronouns(userId: string): string | null {
    const result = this.db.query(
      'SELECT pronouns FROM user_opinions WHERE user_id = ?'
    ).get(userId) as { pronouns: string | null } | undefined;
    
    return result?.pronouns || null;
  }
}

export const userMemoryService = new UserMemoryService();
