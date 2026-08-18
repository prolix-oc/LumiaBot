#!/usr/bin/env bun
/**
 * Reassign a Discord user's stored data to a replacement Discord account.
 *
 * Usage:
 *   bun run reattribute-memories <old_user_id> <new_user_id> [--force]
 *
 * The script first previews the migration. Re-run it with --force to create
 * database backups and apply it. Stop the bot before using this script.
 */

import { Database } from 'bun:sqlite';

const USER_MEMORIES_DB = 'user_memories.db';
const CONVERSATIONS_DB = 'conversations.db';
const BOREDOM_DB = 'boredom.db';
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

interface MigrationPreview {
  sourceOpinions: number;
  destinationOpinions: number;
  sourceMessages: number;
  destinationMessages: number;
  sourceBoredomSettings: number;
  destinationBoredomConflicts: string[];
}

function countRows(db: Database, table: string, userId: string): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as { count: number }).count;
}

function collectPreview(oldUserId: string, newUserId: string): MigrationPreview {
  const memories = new Database(USER_MEMORIES_DB);
  const conversations = new Database(CONVERSATIONS_DB);
  const boredom = new Database(BOREDOM_DB);

  try {
    const sourceBoredomSettings = countRows(boredom, 'boredom_settings', oldUserId);
    const destinationBoredomConflicts = boredom.query(
      `SELECT source.guild_id
       FROM boredom_settings AS source
       INNER JOIN boredom_settings AS destination
         ON destination.guild_id = source.guild_id AND destination.user_id = ?
       WHERE source.user_id = ?
       ORDER BY source.guild_id`
    ).all(newUserId, oldUserId) as Array<{ guild_id: string }>;

    return {
      sourceOpinions: countRows(memories, 'user_opinions', oldUserId),
      destinationOpinions: countRows(memories, 'user_opinions', newUserId),
      sourceMessages: countRows(conversations, 'conversation_messages', oldUserId),
      destinationMessages: countRows(conversations, 'conversation_messages', newUserId),
      sourceBoredomSettings,
      destinationBoredomConflicts: destinationBoredomConflicts.map(row => row.guild_id),
    };
  } finally {
    memories.close();
    conversations.close();
    boredom.close();
  }
}

function describeConflicts(preview: MigrationPreview): string[] {
  const conflicts: string[] = [];

  // user_opinions has no uniqueness constraint, but duplicate profiles make
  // retrieval ambiguous. Require an explicit manual decision instead.
  if (preview.sourceOpinions > 0 && preview.destinationOpinions > 0) {
    conflicts.push('both user IDs have long-term memory records');
  }

  if (preview.destinationBoredomConflicts.length > 0) {
    conflicts.push(`both user IDs have boredom settings in ${preview.destinationBoredomConflicts.length} guild(s)`);
  }

  return conflicts;
}

async function createBackups(): Promise<string[]> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const databases = [USER_MEMORIES_DB, CONVERSATIONS_DB, BOREDOM_DB];
  const backups: string[] = [];

  for (const database of databases) {
    const backup = `${database}.reattribution-${timestamp}.bak`;
    await Bun.write(backup, await Bun.file(database).arrayBuffer());
    backups.push(backup);
  }

  return backups;
}

function applyMigration(oldUserId: string, newUserId: string): void {
  const memories = new Database(USER_MEMORIES_DB);
  const conversations = new Database(CONVERSATIONS_DB);
  const boredom = new Database(BOREDOM_DB);

  try {
    memories.run('UPDATE user_opinions SET user_id = ? WHERE user_id = ?', [newUserId, oldUserId]);
    conversations.run('UPDATE conversation_messages SET user_id = ? WHERE user_id = ?', [newUserId, oldUserId]);
    boredom.run('UPDATE boredom_settings SET user_id = ? WHERE user_id = ?', [newUserId, oldUserId]);
  } finally {
    memories.close();
    conversations.close();
    boredom.close();
  }
}

function printUsage(): void {
  console.log(`
Reattribute stored memories to a replacement Discord account.

Usage:
  bun run reattribute-memories <old_user_id> <new_user_id> [--force]

The first run is a preview. --force creates backups and applies the migration.
Stop the bot before running with --force.
`);
}

async function main(): Promise<void> {
  const argumentsWithoutFlags = process.argv.slice(2).filter(argument => argument !== '--force');
  const force = process.argv.includes('--force');
  const [oldUserId, newUserId] = argumentsWithoutFlags;

  if (argumentsWithoutFlags.length !== 2 || !oldUserId || !newUserId || !DISCORD_ID_PATTERN.test(oldUserId) || !DISCORD_ID_PATTERN.test(newUserId)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (oldUserId === newUserId) {
    console.error('The old and new Discord user IDs must be different.');
    process.exitCode = 1;
    return;
  }

  const preview = collectPreview(oldUserId, newUserId);
  const conflicts = describeConflicts(preview);

  console.log('\nReattribution preview');
  console.log(`  Source ID: ${oldUserId}`);
  console.log(`  Target ID: ${newUserId}`);
  console.log(`  Long-term memory records: ${preview.sourceOpinions}`);
  console.log(`  Conversation messages: ${preview.sourceMessages}`);
  console.log(`  Boredom settings: ${preview.sourceBoredomSettings}`);
  console.log(`  Target conversation messages (unchanged, then shared under target): ${preview.destinationMessages}`);

  if (conflicts.length > 0) {
    console.error('\nMigration was not applied because:', ...conflicts.map(conflict => `\n  - ${conflict}`));
    console.error('\nResolve or choose how to merge the destination records before rerunning. No data was changed.');
    process.exitCode = 1;
    return;
  }

  if (!force) {
    console.log('\nPreview only; no data was changed.');
    console.log(`To apply after stopping the bot:\n  bun run reattribute-memories ${oldUserId} ${newUserId} --force`);
    return;
  }

  console.log('\nCreating database backups...');
  const backups = await createBackups();
  applyMigration(oldUserId, newUserId);

  console.log('\nReattribution complete. Backups created:');
  for (const backup of backups) console.log(`  - ${backup}`);
  console.log('\nThe stored username will update when the replacement account next speaks to the bot.');
}

main().catch(error => {
  console.error('Reattribution failed:', error);
  process.exitCode = 1;
});
