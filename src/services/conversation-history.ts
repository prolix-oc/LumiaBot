import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import type { ChatMessage } from './openai';

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface UserConversation {
  userId: string;
  username: string;
  messages: ConversationEntry[];
  lastActivity: string;
}

export class ConversationHistoryService {
  private db: Database;
  private maxHistoryLength: number;

  constructor() {
    this.db = new Database('conversations.db');
    this.maxHistoryLength = config.conversation.maxHistoryLength;
    this.initDatabase();
    console.log(`💬 [CONVERSATION] History service initialized (${this.maxHistoryLength} messages max, persistent storage)`);
  }

  private initDatabase(): void {
    // Create conversations table with guild_id support
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);

    // Migration: Check if guild_id column exists (for existing databases)
    this.migrateAddColumn('guild_id', 'TEXT', 'legacy');

    // Create index for faster lookups (user + guild)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_user_guild ON conversation_messages(user_id, guild_id)
    `);

    // Create index for timestamp ordering
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_timestamp ON conversation_messages(timestamp)
    `);

    // Create index for guild-specific lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_guild ON conversation_messages(guild_id)
    `);

    console.log('💬 [CONVERSATION] Database initialized');
  }

  private migrateAddColumn(columnName: string, columnType: string, defaultValue: string): void {
    try {
      // Check if column exists
      const result = this.db.query(
        `SELECT COUNT(*) as count FROM pragma_table_info('conversation_messages') WHERE name = ?`
      ).get(columnName) as { count: number };

      if (result.count === 0) {
        // Column doesn't exist, add it
        this.db.run(`ALTER TABLE conversation_messages ADD COLUMN ${columnName} ${columnType} DEFAULT ${defaultValue}`);
        console.log(`💬 [CONVERSATION] Migration: Added column '${columnName}' with default '${defaultValue}'`);
      }
    } catch (error) {
      console.error(`💬 [CONVERSATION] Migration failed for column '${columnName}':`, error);
    }
  }

  /**
   * Add a message to the conversation history (guild-specific)
   */
  addMessage(userId: string, guildId: string, username: string, role: 'user' | 'assistant', content: string): void {
    const now = new Date().toISOString();

    // Insert the new message
    this.db.run(
      `INSERT INTO conversation_messages (user_id, guild_id, username, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, guildId, username, role, content, now]
    );

    // Get current message count for this user in this guild
    const countResult = this.db.query(
      'SELECT COUNT(*) as count FROM conversation_messages WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as { count: number };

    // Trim to max length (rolling window) - delete oldest messages
    if (countResult.count > this.maxHistoryLength) {
      const toDelete = countResult.count - this.maxHistoryLength;
      this.db.run(
        `DELETE FROM conversation_messages 
         WHERE id IN (
           SELECT id FROM conversation_messages 
           WHERE user_id = ? AND guild_id = ?
           ORDER BY timestamp ASC 
           LIMIT ?
         )`,
        [userId, guildId, toDelete]
      );
      console.log(`💬 [CONVERSATION] Trimmed ${toDelete} oldest messages for ${username} in guild ${guildId}`);
    }

    console.log(`💬 [CONVERSATION] Added ${role} message for ${username} in guild ${guildId}`);
  }

  /**
   * Get conversation history as ChatMessage array for OpenAI (guild-specific)
   */
  getHistory(userId: string, guildId: string): ChatMessage[] {
    const results = this.db.query(
      `SELECT role, content, username, timestamp
       FROM conversation_messages
       WHERE user_id = ? AND guild_id = ?
       ORDER BY timestamp ASC`
    ).all(userId, guildId) as Array<{ role: 'user' | 'assistant'; content: string; username: string; timestamp: string }>;

    // Convert to ChatMessage format with username attribution on user messages
    return results.map(msg => ({
      role: msg.role,
      content: msg.role === 'user' && msg.username
        ? `[${msg.username}]: ${msg.content}`
        : msg.content,
    }));
  }

  /**
   * Get the full conversation object (guild-specific)
   */
  getConversation(userId: string, guildId: string): UserConversation | null {
    const results = this.db.query(
      `SELECT user_id, username, role, content, timestamp 
       FROM conversation_messages 
       WHERE user_id = ? AND guild_id = ?
       ORDER BY timestamp ASC`
    ).all(userId, guildId) as Array<{ user_id: string; username: string; role: 'user' | 'assistant'; content: string; timestamp: string }>;

    if (results.length === 0) {
      return null;
    }

    const firstResult = results[0];
    const lastResult = results[results.length - 1];
    
    if (!firstResult || !lastResult) {
      return null;
    }

    const messages: ConversationEntry[] = results.map(r => ({
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
    }));

    return {
      userId: firstResult.user_id,
      username: firstResult.username,
      messages,
      lastActivity: lastResult.timestamp,
    };
  }

  /**
   * Clear conversation history for a user in a guild
   */
  clearHistory(userId: string, guildId: string): void {
    const result = this.db.run(
      'DELETE FROM conversation_messages WHERE user_id = ? AND guild_id = ?',
      [userId, guildId]
    );
    
    if (result.changes > 0) {
      console.log(`💬 [CONVERSATION] Cleared ${result.changes} messages for user ${userId} in guild ${guildId}`);
    }
  }

  /**
   * Clear all conversation history for a user across all guilds
   */
  clearAllHistory(userId: string): void {
    const result = this.db.run(
      'DELETE FROM conversation_messages WHERE user_id = ?',
      [userId]
    );
    
    if (result.changes > 0) {
      console.log(`💬 [CONVERSATION] Cleared ${result.changes} messages for user ${userId} across all guilds`);
    }
  }

  /**
   * Get conversation summary for display (guild-specific)
   */
  getConversationSummary(userId: string, guildId: string): string {
    const result = this.db.query(
      `SELECT username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       WHERE user_id = ? AND guild_id = ?
       GROUP BY user_id, username`
    ).get(userId, guildId) as { username: string; count: number; last_activity: string } | undefined;

    if (!result) {
      return 'No conversation history found.';
    }

    const timeAgo = this.getTimeAgo(new Date(result.last_activity));
    
    return `Conversation with ${result.username}: ${result.count} messages, last active ${timeAgo}`;
  }

  /**
   * List all active conversations for a user across all guilds
   */
  listUserConversations(userId: string): Array<{ guildId: string; username: string; messageCount: number; lastActivity: string }> {
    const results = this.db.query(
      `SELECT guild_id, username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       WHERE user_id = ?
       GROUP BY guild_id, username
       ORDER BY last_activity DESC`
    ).all(userId) as Array<{ guild_id: string; username: string; count: number; last_activity: string }>;

    return results.map(r => ({
      guildId: r.guild_id,
      username: r.username,
      messageCount: r.count,
      lastActivity: r.last_activity,
    }));
  }

  /**
   * List all active conversations in a guild
   */
  listGuildConversations(guildId: string): Array<{ userId: string; username: string; messageCount: number; lastActivity: string }> {
    const results = this.db.query(
      `SELECT user_id, username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       WHERE guild_id = ?
       GROUP BY user_id, username
       ORDER BY last_activity DESC`
    ).all(guildId) as Array<{ user_id: string; username: string; count: number; last_activity: string }>;

    return results.map(r => ({
      userId: r.user_id,
      username: r.username,
      messageCount: r.count,
      lastActivity: r.last_activity,
    }));
  }

  /**
   * List all active conversations (admin view)
   */
  listActiveConversations(): Array<{ userId: string; guildId: string; username: string; messageCount: number; lastActivity: string }> {
    const results = this.db.query(
      `SELECT user_id, guild_id, username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       GROUP BY user_id, guild_id, username
       ORDER BY last_activity DESC`
    ).all() as Array<{ user_id: string; guild_id: string; username: string; count: number; last_activity: string }>;

    return results.map(r => ({
      userId: r.user_id,
      guildId: r.guild_id,
      username: r.username,
      messageCount: r.count,
      lastActivity: r.last_activity,
    }));
  }

  /**
   * Format history for system prompt context (guild-specific)
   */
  formatHistoryForPrompt(userId: string, guildId: string): string {
    const results = this.db.query(
      `SELECT role, content 
       FROM conversation_messages 
       WHERE user_id = ? AND guild_id = ?
       ORDER BY timestamp ASC`
    ).all(userId, guildId) as Array<{ role: 'user' | 'assistant'; content: string }>;

    if (results.length === 0) {
      return '';
    }

    // Format last few messages for context (keep it concise)
    const recentMessages = results.slice(-6); // Last 3 exchanges (user + assistant pairs)
    
    const formatted = recentMessages.map(msg => {
      const prefix = msg.role === 'user' ? 'User:' : 'You:';
      // Truncate long messages
      const content = msg.content.length > 150 
        ? msg.content.substring(0, 150) + '...'
        : msg.content;
      return `${prefix} ${content}`;
    }).join('\n');

    return `
## Recent Conversation Context (This Server)

${formatted}

Continue the conversation naturally, referencing previous topics when relevant.
`;
  }

  /**
   * Get message count for a user in a guild
   */
  getMessageCount(userId: string, guildId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM conversation_messages WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as { count: number };
    
    return result.count;
  }

  /**
   * Get total message count for a user across all guilds
   */
  getTotalMessageCount(userId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM conversation_messages WHERE user_id = ?'
    ).get(userId) as { count: number };
    
    return result.count;
  }

  /**
   * Get human-readable time ago string
   */
  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
}

// Singleton instance
export const conversationHistoryService = new ConversationHistoryService();
