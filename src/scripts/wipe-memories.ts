#!/usr/bin/env bun
/**
 * Memory Wipe Script for Lumia
 * 
 * This script wipes all memories, opinions, and conversation history for a specific user.
 * Useful when you want to reset Lumia's relationship with a user.
 * 
 * Usage:
 *   bun run src/scripts/wipe-memories.ts <username_or_userid>
 * 
 * Examples:
 *   bun run src/scripts/wipe-memories.ts Prolix
 *   bun run src/scripts/wipe-memories.ts 123456789012345678
 */

import { Database } from 'bun:sqlite';
import { userMemoryService } from '../services/user-memory';
import { conversationHistoryService } from '../services/conversation-history';
import { boredomService } from '../services/boredom';

// Parse command line args
const args = process.argv.slice(2);
if (args.includes('--force')) {
  process.env.FORCE_WIPE = 'true';
}

interface WipeResult {
  userId: string;
  username: string;
  opinionsDeleted: boolean;
  conversationsCleared: number;
  boredomSettingsDeleted: boolean;
}

/**
 * Find a user by username (case insensitive) or user ID
 */
function findUser(identifier: string): { userId: string; username: string } | null {
  // Try to find by user ID first (Discord IDs are 17-20 digit numbers)
  const isDiscordId = /^\d{17,20}$/.test(identifier);
  
  if (isDiscordId) {
    // Check if this user exists in any of our databases
    const userId = identifier;
    
    // Check user_memories.db
    try {
      const db = new Database('user_memories.db');
      const result = db.query('SELECT username FROM user_opinions WHERE user_id = ? LIMIT 1').get(userId) as { username: string } | undefined;
      db.close();
      
      if (result) {
        return { userId, username: result.username };
      }
    } catch (error) {
      console.error('Error checking user_memories.db:', error);
    }
    
    // Check conversations.db
    try {
      const db = new Database('conversations.db');
      const result = db.query('SELECT username FROM conversation_messages WHERE user_id = ? LIMIT 1').get(userId) as { username: string } | undefined;
      db.close();
      
      if (result) {
        return { userId, username: result.username };
      }
    } catch (error) {
      console.error('Error checking conversations.db:', error);
    }
    
    // Check boredom.db
    try {
      const db = new Database('boredom.db');
      const result = db.query('SELECT 1 as exists FROM boredom_settings WHERE user_id = ? LIMIT 1').get(userId) as { exists: number } | undefined;
      db.close();
      
      if (result) {
        // We found them in boredom db but don't have username, use ID as username
        return { userId, username: userId };
      }
    } catch (error) {
      console.error('Error checking boredom.db:', error);
    }
    
    console.log(`❌ No user found with ID: ${identifier}`);
    return null;
  }
  
  // Search by username (case insensitive)
  const username = identifier;
  
  // Check user_memories.db
  try {
    const db = new Database('user_memories.db');
    const result = db.query('SELECT user_id, username FROM user_opinions WHERE LOWER(username) = LOWER(?) LIMIT 1').get(username) as { user_id: string; username: string } | undefined;
    db.close();
    
    if (result) {
      return { userId: result.user_id, username: result.username };
    }
  } catch (error) {
    console.error('Error checking user_memories.db:', error);
  }
  
  // Check conversations.db
  try {
    const db = new Database('conversations.db');
    const result = db.query('SELECT user_id, username FROM conversation_messages WHERE LOWER(username) = LOWER(?) LIMIT 1').get(username) as { user_id: string; username: string } | undefined;
    db.close();
    
    if (result) {
      return { userId: result.user_id, username: result.username };
    }
  } catch (error) {
    console.error('Error checking conversations.db:', error);
  }
  
  console.log(`❌ No user found with username: ${identifier}`);
  return null;
}

/**
 * Get detailed info about a user before wiping
 */
function getUserInfo(userId: string): {
  hasOpinion: boolean;
  conversationCount: number;
  guilds: string[];
  boredomEnabled: boolean | null;
} {
  let hasOpinion = false;
  let conversationCount = 0;
  const guilds: string[] = [];
  let boredomEnabled: boolean | null = null;
  
  // Check opinions
  try {
    const opinion = userMemoryService.getOpinion(userId);
    hasOpinion = !!opinion;
  } catch (error) {
    // User might not have an opinion
  }
  
  // Check conversations
  try {
    conversationCount = conversationHistoryService.getTotalMessageCount(userId);
    const userConversations = conversationHistoryService.listUserConversations(userId);
    guilds.push(...userConversations.map(c => c.guildId));
  } catch (error) {
    // User might not have conversations
  }
  
  // Check boredom settings (need to check across all guilds they've interacted in)
  try {
    const db = new Database('boredom.db');
    const results = db.query('SELECT enabled FROM boredom_settings WHERE user_id = ?').all(userId) as Array<{ enabled: number }>;
    db.close();
    
    if (results.length > 0) {
      // If any guild has it enabled, consider it enabled
      boredomEnabled = results.some(r => r.enabled === 1);
    }
  } catch (error) {
    // User might not have boredom settings
  }
  
  return { hasOpinion, conversationCount, guilds, boredomEnabled };
}

/**
 * Wipe all memories for a user
 */
function wipeUserMemories(userId: string, username: string): WipeResult {
  let opinionsDeleted = false;
  let conversationsCleared = 0;
  let boredomSettingsDeleted = false;
  
  console.log(`\n🧹 Wiping memories for ${username} (${userId})...\n`);
  
  // 1. Delete user opinion
  try {
    if (userMemoryService.hasOpinion(userId)) {
      userMemoryService.deleteOpinion(userId);
      opinionsDeleted = true;
      console.log('  ✓ Deleted user opinion/memories');
    } else {
      console.log('  ℹ No user opinion to delete');
    }
  } catch (error) {
    console.error('  ✗ Error deleting opinion:', error);
  }
  
  // 2. Clear conversation history across all guilds
  try {
    const beforeCount = conversationHistoryService.getTotalMessageCount(userId);
    if (beforeCount > 0) {
      conversationHistoryService.clearAllHistory(userId);
      conversationsCleared = beforeCount;
      console.log(`  ✓ Cleared ${beforeCount} conversation messages`);
    } else {
      console.log('  ℹ No conversation history to clear');
    }
  } catch (error) {
    console.error('  ✗ Error clearing conversations:', error);
  }
  
  // 3. Delete boredom settings
  try {
    const db = new Database('boredom.db');
    const result = db.run('DELETE FROM boredom_settings WHERE user_id = ?', [userId]);
    db.close();
    
    if (result.changes > 0) {
      boredomSettingsDeleted = true;
      console.log(`  ✓ Deleted boredom settings (${result.changes} guild(s))`);
    } else {
      console.log('  ℹ No boredom settings to delete');
    }
  } catch (error) {
    console.error('  ✗ Error deleting boredom settings:', error);
  }
  
  return { userId, username, opinionsDeleted, conversationsCleared, boredomSettingsDeleted };
}

/**
 * Main function
 */
async function main() {
  // Filter out --force from args for processing
  const cleanArgs = args.filter(arg => arg !== '--force');
  
  if (cleanArgs.length === 0) {
    console.log(`
🧹 Lumia Memory Wipe Tool

Usage: bun run src/scripts/wipe-memories.ts <username_or_userid>

Examples:
  bun run src/scripts/wipe-memories.ts Prolix
  bun run src/scripts/wipe-memories.ts 123456789012345678

This will delete:
  - User opinions and memories
  - Conversation history (all guilds)
  - Boredom settings
  - Pronouns and third-party context

⚠️  This action cannot be undone!
    `);
    process.exit(1);
  }
  
  const identifier = cleanArgs[0]!;
  
  console.log(`\n🔍 Searching for user: ${identifier}...`);
  
  const user = findUser(identifier);
  
  if (!user) {
    console.log('\n❌ User not found in any database');
    console.log('\nTip: Try using the exact Discord username or User ID');
    process.exit(1);
  }
  
  console.log(`\n✓ Found user: ${user.username} (${user.userId})`);
  
  // Get current info before wiping
  const info = getUserInfo(user.userId);
  
  console.log('\n📊 Current Memory State:');
  console.log(`  Has opinion: ${info.hasOpinion ? 'Yes' : 'No'}`);
  console.log(`  Conversation messages: ${info.conversationCount}`);
  console.log(`  Guilds with history: ${info.guilds.length > 0 ? info.guilds.join(', ') : 'None'}`);
  console.log(`  Boredom enabled: ${info.boredomEnabled === null ? 'N/A' : info.boredomEnabled ? 'Yes' : 'No'}`);
  
  // Confirm before wiping
  console.log('\n⚠️  WARNING: This will permanently delete all memories for this user!');
  console.log('   This action cannot be undone.\n');
  
  // Check if running in CI/non-interactive mode
  if (process.env.CI || process.env.FORCE_WIPE) {
    console.log('Running in non-interactive mode (CI/FORCE_WIPE set), proceeding with wipe...\n');
  } else {
    console.log('To confirm, type the username: ');
    
    // Simple confirmation for now - in production you might want to use readline
    // For now, require --force flag or CI environment
    console.log('\nAdd --force flag to skip confirmation:');
    console.log(`  bun run src/scripts/wipe-memories.ts ${identifier} --force\n`);
    process.exit(0);
  }
  
  // Perform the wipe
  const result = wipeUserMemories(user.userId, user.username);
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('WIPE COMPLETE');
  console.log('='.repeat(50));
  console.log(`User: ${result.username} (${result.userId})`);
  console.log(`Opinions deleted: ${result.opinionsDeleted ? 'Yes' : 'No'}`);
  console.log(`Messages cleared: ${result.conversationsCleared}`);
  console.log(`Boredom settings deleted: ${result.boredomSettingsDeleted ? 'Yes' : 'No'}`);
  console.log('='.repeat(50));
  console.log('\n✨ All memories have been wiped. Lumia will treat this user as a new acquaintance.\n');
}

main().catch(console.error);
