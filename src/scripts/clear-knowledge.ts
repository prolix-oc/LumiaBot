/**
 * Clear Knowledge Graph Database
 * 
 * Usage:
 *   bun run src/scripts/clear-knowledge.ts              # Interactive mode
 *   bun run src/scripts/clear-knowledge.ts --all        # Clear everything (no prompt)
 *   bun run src/scripts/clear-knowledge.ts --topic loom # Clear specific topic
 *   bun run src/scripts/clear-knowledge.ts --dry-run    # Show what would be deleted
 */

import { knowledgeGraphService } from '../services/knowledge-graph';

async function main() {
  const args = process.argv.slice(2);
  const clearAll = args.includes('--all');
  const dryRun = args.includes('--dry-run');
  
  // Check for topic flag
  const topicIndex = args.indexOf('--topic');
  const targetTopic = topicIndex !== -1 ? args[topicIndex + 1] : null;
  
  console.log('🗑️  Knowledge Graph Cleanup\n');
  
  // Get current stats
  const stats = knowledgeGraphService.getStats();
  
  if (stats.totalDocuments === 0) {
    console.log('📭 Knowledge base is already empty. Nothing to clear.');
    return;
  }
  
  console.log(`Current knowledge base status:`);
  console.log(`  📚 Total documents: ${stats.totalDocuments}`);
  console.log(`  📁 Topics: ${stats.totalTopics}`);
  
  const topics = knowledgeGraphService.listTopics();
  if (topics.length > 0) {
    console.log(`  Topics: ${topics.join(', ')}`);
  }
  console.log();
  
  // Dry run mode
  if (dryRun) {
    if (targetTopic) {
      const topicDocs = knowledgeGraphService.getDocumentsByTopic(targetTopic);
      console.log(`[DRY RUN] Would delete ${topicDocs.length} documents from topic "${targetTopic}"`);
    } else {
      console.log(`[DRY RUN] Would delete all ${stats.totalDocuments} documents`);
    }
    return;
  }
  
  // Determine what to clear
  let confirmMessage: string;
  let clearFunction: () => { deletedCount: number };
  
  if (targetTopic) {
    const topicDocs = knowledgeGraphService.getDocumentsByTopic(targetTopic);
    if (topicDocs.length === 0) {
      console.log(`❌ Topic "${targetTopic}" not found or has no documents.`);
      return;
    }
    confirmMessage = `Are you sure you want to delete all ${topicDocs.length} documents from topic "${targetTopic}"?`;
    clearFunction = () => knowledgeGraphService.deleteByTopic(targetTopic);
  } else {
    confirmMessage = `⚠️  WARNING: This will delete ALL ${stats.totalDocuments} documents from the knowledge base!\nAre you sure you want to continue?`;
    clearFunction = () => knowledgeGraphService.clearAll();
  }
  
  // Require --all flag for non-interactive mode
  if (!clearAll) {
    console.log(confirmMessage);
    console.log('\nTo confirm, run with --all flag:');
    if (targetTopic) {
      console.log(`  bun run src/scripts/clear-knowledge.ts --topic ${targetTopic} --all`);
    } else {
      console.log('  bun run src/scripts/clear-knowledge.ts --all');
    }
    console.log('\nOr use --dry-run to preview what would be deleted.');
    return;
  }
  
  // Execute the clear
  console.log('Clearing knowledge base...\n');
  const result = clearFunction();
  
  console.log('✅ Knowledge base cleared successfully!');
  console.log(`   Deleted ${result.deletedCount} documents`);
  
  // Show final stats
  const finalStats = knowledgeGraphService.getStats();
  console.log(`\n📊 Remaining: ${finalStats.totalDocuments} documents across ${finalStats.totalTopics} topics`);
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
