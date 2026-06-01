/**
 * Import Lumiverse documentation into the knowledge graph.
 *
 * Reads all Markdown files from both user-docs and developer-docs in the
 * Lumiverse-Backend repo, converts them to frontmatter-tagged knowledge
 * documents, and bulk-imports them after clearing the existing DB.
 *
 * Usage:
 *   bun run src/scripts/import-lumiverse-docs.ts
 */

import { readFile, readdir } from 'fs/promises';
import { join, relative, dirname, basename, extname } from 'path';
import { existsSync } from 'node:fs';
import { knowledgeGraphService } from '../services/knowledge-graph';

const LUMIVERSE_ROOT = join(process.env.HOME || '~', 'Projects', 'Lumiverse-Backend');

const SOURCES = [
  {
    docsDir: join(LUMIVERSE_ROOT, 'user-docs', 'docs'),
    baseUrl: 'https://lumiverse.chat/guides',
    docSet: 'user-guides',
    defaultPriority: 6,
  },
  {
    docsDir: join(LUMIVERSE_ROOT, 'developer-docs', 'docs'),
    baseUrl: 'https://docs.lumiverse.chat',
    docSet: 'developer-docs',
    defaultPriority: 5,
  },
] as const;

const SKIP_FILES = new Set(['extra.css']);
const SKIP_DIRS = new Set(['stylesheets']);

interface DocEntry {
  topic: string;
  title: string;
  content: string;
  keywords: string[];
  type: 'document' | 'link' | 'snippet';
  url: string;
  priority: number;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map(word => {
      if (word === 'api') return 'API';
      if (word === 'llm') return 'LLM';
      if (word === 'rpc') return 'RPC';
      if (word === 'ui') return 'UI';
      if (word === 'dom') return 'DOM';
      if (word === 'cors') return 'CORS';
      if (word === 'oauth') return 'OAuth';
      if (word === 'ooc') return 'OOC';
      if (word === 'tts') return 'TTS';
      if (word === 'stt') return 'STT';
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function buildUrl(baseUrl: string, relPath: string): string {
  let urlPath = relPath.replace(/\.md$/, '/');
  if (urlPath.endsWith('/index/')) {
    urlPath = urlPath.replace(/index\/$/, '');
  }
  return `${baseUrl}/${urlPath}`.replace(/\/+$/, '/');
}

function extractTitle(content: string, fileName: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].trim();
  return titleCase(fileName.replace(/\.md$/, ''));
}

function extractKeywords(content: string, title: string, topic: string): string[] {
  const kw = new Set<string>();

  kw.add('lumiverse');

  // Title words (>2 chars)
  title.toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => kw.add(w));

  // Topic (strip parenthesized qualifier like "(User Guide)")
  topic.replace(/\s*\(.*\)/, '').toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => kw.add(w));

  // Headings (H2-H4)
  const headings = content.matchAll(/^#{2,4}\s+(.+)$/gm);
  for (const m of headings) {
    if (m[1]) {
      m[1].toLowerCase().split(/\s+/).filter(w => w.length > 2 && !/^[#*`\-]+$/.test(w)).forEach(w => kw.add(w));
    }
  }

  // Bold terms
  const bolds = content.matchAll(/\*\*([^*]+)\*\*/g);
  for (const m of bolds) {
    if (m[1] && m[1].length < 40) {
      m[1].toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => kw.add(w));
    }
  }

  // Inline code terms
  const codes = content.matchAll(/`([^`]+)`/g);
  for (const m of codes) {
    if (m[1] && m[1].length < 30 && !m[1].includes(' ')) {
      kw.add(m[1].toLowerCase());
    }
  }

  // Remove noise
  const noise = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'was', 'one', 'our', 'out', 'use', 'her', 'him', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'with', 'this', 'that', 'from', 'they', 'have', 'will', 'each', 'make', 'like', 'just', 'over', 'such', 'take', 'than', 'them', 'very', 'when', 'what', 'your', 'been', 'more', 'some', 'then', 'these', 'about', 'which', 'would', 'their', 'other', 'there', 'after', 'could', 'those', 'where', 'should']);
  noise.forEach(w => kw.delete(w));

  return [...kw].slice(0, 25);
}

function determinePriority(relPath: string, docSet: string, defaultPriority: number): number {
  const name = basename(relPath, '.md');
  if (name === 'index' && dirname(relPath) === '.') return defaultPriority + 2; // Root index
  if (name === 'index') return defaultPriority + 1; // Section overviews
  if (relPath.startsWith('getting-started/')) return defaultPriority + 1;
  if (docSet === 'developer-docs' && relPath.startsWith('examples/')) return defaultPriority;
  return defaultPriority;
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(full));
    } else if (entry.isFile() && extname(entry.name) === '.md' && !SKIP_FILES.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function collectDocs(): Promise<DocEntry[]> {
  const docs: DocEntry[] = [];

  for (const source of SOURCES) {
    if (!existsSync(source.docsDir)) {
      console.error(`❌ Directory not found: ${source.docsDir}`);
      continue;
    }

    const files = await walkDir(source.docsDir);
    console.log(`📂 Found ${files.length} markdown files in ${source.docSet}`);

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8');
      const relPath = relative(source.docsDir, filePath);
      const parentDir = dirname(relPath);
      const fileName = basename(relPath);

      const topic = parentDir === '.'
        ? (source.docSet === 'user-guides' ? 'Lumiverse User Guides' : 'Lumiverse Developer Docs')
        : `${titleCase(parentDir)} (${source.docSet === 'user-guides' ? 'User Guide' : 'Developer Docs'})`;

      const title = extractTitle(content, fileName);
      const url = buildUrl(source.baseUrl, relPath);
      const keywords = extractKeywords(content, title, topic);
      const priority = determinePriority(relPath, source.docSet, source.defaultPriority);

      docs.push({
        topic,
        title,
        content,
        keywords,
        type: 'document',
        url,
        priority,
      });
    }
  }

  return docs;
}

async function main() {
  console.log('📚 Lumiverse Documentation Importer');
  console.log('====================================\n');

  const docs = await collectDocs();

  if (docs.length === 0) {
    console.error('❌ No documents found to import.');
    process.exit(1);
  }

  console.log(`\n📊 Summary: ${docs.length} documents ready to import`);
  console.log(`   User guides:    ${docs.filter(d => d.topic.includes('User Guide') || d.topic === 'Lumiverse User Guides').length}`);
  console.log(`   Developer docs: ${docs.filter(d => d.topic.includes('Developer Docs') || d.topic === 'Lumiverse Developer Docs').length}`);

  // Clear existing knowledge base
  const cleared = knowledgeGraphService.clearAll();
  console.log(`\n🗑️  Cleared ${cleared.deletedCount} existing documents`);

  // Bulk import
  knowledgeGraphService.bulkImport(docs);
  console.log(`✅ Successfully imported ${docs.length} documents into knowledge graph`);

  // Show stats
  const stats = knowledgeGraphService.getStats();
  console.log(`\n📈 Knowledge base now has ${stats.totalDocuments} documents across ${stats.totalTopics} topics`);

  const topicStats = knowledgeGraphService.getTopicStats();
  console.log('\nDocuments by topic:');
  for (const t of topicStats) {
    console.log(`   ${t.topic}: ${t.count} docs (avg priority: ${t.avgPriority})`);
  }
}

main().catch(err => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});
