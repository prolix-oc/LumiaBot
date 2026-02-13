/**
 * Import Markdown documents to Knowledge Graph Database
 * 
 * Usage:
 *   bun run src/scripts/import-to-db.ts [directory]
 * 
 * Example:
 *   bun run src/scripts/import-to-db.ts ./knowledge_documents
 *   bun run src/scripts/import-to-db.ts  # Uses default ./knowledge_documents
 * 
 * Options:
 *   --dry-run    Parse files but don't save to database
 *   --force      Import even if documents with same titles exist
 */

import { knowledgeGraphService } from '../services/knowledge-graph';
import { importMarkdownDirectory, type ParsedMarkdownDocument } from '../utils/markdown-parser';

async function main() {
  const args = process.argv.slice(2);
  const targetDir = args.find(arg => !arg.startsWith('--')) || './knowledge_documents';
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  
  console.log('📚 Knowledge Graph Markdown Import\n');
  console.log(`Target directory: ${targetDir}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'IMPORT TO DATABASE'}`);
  console.log();
  
  // Parse all Markdown files
  console.log('🔍 Parsing Markdown files...');
  const docs = await importMarkdownDirectory(targetDir);
  
  if (docs.length === 0) {
    console.log('❌ No valid Markdown files found.');
    console.log('\nMake sure your .md files have the proper format:');
    console.log('  - Frontmatter (--- key: value ---) OR');
    console.log('  - Inline headers (**Topic:** value)');
    process.exit(1);
  }
  
  console.log(`✅ Found ${docs.length} documents\n`);
  
  // Preview documents
  console.log('📋 Document Preview:\n');
  docs.forEach((doc, i) => {
    console.log(`${i + 1}. "${doc.title}"`);
    console.log(`   Topic: ${doc.topic} | Type: ${doc.type} | Priority: ${doc.priority}`);
    console.log(`   Keywords: ${doc.keywords.join(', ') || 'none'}`);
    if (doc.url) console.log(`   URL: ${doc.url}`);
    console.log(`   Source: ${doc.sourceFile}`);
    console.log();
  });
  
  if (dryRun) {
    console.log('\n🏃 Dry run complete. No changes made to database.');
    console.log('To import, run without --dry-run flag.');
    return;
  }
  
  // Check for existing documents with same titles
  if (!force) {
    const stats = knowledgeGraphService.getStats();
    if (stats.totalDocuments > 0) {
      console.log(`⚠️  Database already has ${stats.totalDocuments} documents.`);
      console.log('Use --force to import anyway, or delete existing documents first.');
      console.log('To see existing documents, use: /knowledge list\n');
      
      // Still give option to continue
      console.log('Continue with import? (This will skip duplicates)');
    }
  }
  
  // Import to database
  console.log('\n💾 Importing to database...\n');
  
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const doc of docs) {
    try {
      // Check if document with same title already exists (unless force mode)
      if (!force) {
        const existing = knowledgeGraphService.searchByKeywords({
          query: doc.title,
          maxResults: 1,
        });
        
        if (existing.length > 0 && existing[0]!.document.title.toLowerCase() === doc.title.toLowerCase()) {
          console.log(`⏭️  Skipped: "${doc.title}" (already exists)`);
          skipped++;
          continue;
        }
      }
      
      knowledgeGraphService.storeDocument({
        topic: doc.topic,
        title: doc.title,
        content: doc.content,
        keywords: doc.keywords,
        type: doc.type,
        url: doc.url,
        priority: doc.priority,
      });
      
      console.log(`✅ Imported: "${doc.title}" (${doc.topic})`);
      imported++;
      
    } catch (error) {
      console.error(`❌ Error importing "${doc.title}":`, error);
      errors++;
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Import Summary:');
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log('='.repeat(50));
  
  // Show final stats
  const finalStats = knowledgeGraphService.getStats();
  console.log(`\n📚 Database now has ${finalStats.totalDocuments} documents across ${finalStats.totalTopics} topics.`);
  
  const topics = knowledgeGraphService.listTopics();
  if (topics.length > 0) {
    console.log(`\n📁 Topics: ${topics.join(', ')}`);
  }
  
  console.log('\n✨ Import complete!');
  console.log('You can now ask Lumia about these topics.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
