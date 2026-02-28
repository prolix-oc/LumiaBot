import { Database } from 'bun:sqlite';

export interface KnowledgeDocument {
  id?: number;
  topic: string;
  title: string;
  content: string;
  keywords: string[];
  type: 'document' | 'link' | 'snippet';
  url?: string;
  priority: number; // 1-10, higher = more important
  usageCount: number;
  lastAccessed?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeQuery {
  query: string;
  topics?: string[];
  maxResults?: number;
  minPriority?: number;
}

export interface KnowledgeSearchResult {
  document: KnowledgeDocument;
  relevanceScore: number;
  matchedKeywords: string[];
}

export class KnowledgeGraphService {
  private db: Database;

  constructor() {
    this.db = new Database('knowledge_graph.db');
    this.initDatabase();
    console.log('📚 [KNOWLEDGE GRAPH] Service initialized with persistent storage');
  }

  private initDatabase(): void {
    // Create documents table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        keywords TEXT NOT NULL, -- JSON array of keywords
        type TEXT NOT NULL CHECK (type IN ('document', 'link', 'snippet')),
        url TEXT,
        priority INTEGER DEFAULT 5,
        usage_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create indexes for efficient querying
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge_documents(topic)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_documents(type)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_priority ON knowledge_documents(priority DESC)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_usage ON knowledge_documents(usage_count DESC)
    `);

    console.log('📚 [KNOWLEDGE GRAPH] Database initialized');
  }

  /**
   * Store a new knowledge document
   */
  storeDocument(doc: Omit<KnowledgeDocument, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>): void {
    const now = new Date().toISOString();
    
    this.db.run(
      `INSERT INTO knowledge_documents 
       (topic, title, content, keywords, type, url, priority, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        doc.topic,
        doc.title,
        doc.content,
        JSON.stringify(doc.keywords.map(k => k.toLowerCase())),
        doc.type,
        doc.url || null,
        doc.priority,
        now,
        now
      ]
    );

    console.log(`📚 [KNOWLEDGE GRAPH] Stored document: "${doc.title}" (${doc.topic})`);
  }

  /**
   * Update an existing document
   */
  updateDocument(id: number, updates: Partial<KnowledgeDocument>): void {
    const now = new Date().toISOString();
    
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.topic !== undefined) {
      fields.push('topic = ?');
      values.push(updates.topic);
    }
    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.keywords !== undefined) {
      fields.push('keywords = ?');
      values.push(JSON.stringify(updates.keywords.map(k => k.toLowerCase())));
    }
    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }
    if (updates.url !== undefined) {
      fields.push('url = ?');
      values.push(updates.url);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    this.db.run(
      `UPDATE knowledge_documents SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    console.log(`📚 [KNOWLEDGE GRAPH] Updated document ${id}`);
  }

  /**
   * Get a document by ID
   */
  getDocument(id: number): KnowledgeDocument | null {
    const result = this.db.query(
      'SELECT * FROM knowledge_documents WHERE id = ?'
    ).get(id) as any;

    if (!result) return null;

    return this.mapRowToDocument(result);
  }

  /**
   * Get all documents for a topic
   */
  getDocumentsByTopic(topic: string, limit: number = 10): KnowledgeDocument[] {
    const results = this.db.query(
      `SELECT * FROM knowledge_documents 
       WHERE topic = ? 
       ORDER BY priority DESC, usage_count DESC 
       LIMIT ?`
    ).all(topic, limit) as any[];

    return results.map(r => this.mapRowToDocument(r));
  }

  /**
   * Search documents by keywords
   * Uses fuzzy matching and relevance scoring
   */
  searchByKeywords(query: KnowledgeQuery): KnowledgeSearchResult[] {
    const { query: searchQuery, topics, maxResults = 5, minPriority = 1 } = query;
    
    // Extract keywords from query
    const queryKeywords = searchQuery.toLowerCase()
      .split(/\s+/)
      .filter(k => k.length > 2); // Only words longer than 2 chars

    if (queryKeywords.length === 0) {
      return [];
    }

    // Build query
    let sql = `SELECT * FROM knowledge_documents WHERE priority >= ?`;
    const params: any[] = [minPriority];

    if (topics && topics.length > 0) {
      sql += ` AND topic IN (${topics.map(() => '?').join(',')})`;
      params.push(...topics);
    }

    sql += ` ORDER BY priority DESC`;

    const results = this.db.query(sql).all(...params) as any[];

    // Score and filter results
    const scored: KnowledgeSearchResult[] = results.map(doc => {
      const keywords: string[] = JSON.parse(doc.keywords);
      
      // Calculate relevance score
      let score = 0;
      const matchedKeywords: string[] = [];

      for (const queryKw of queryKeywords) {
        // Exact match on keyword
        if (keywords.includes(queryKw)) {
          score += 10;
          matchedKeywords.push(queryKw);
          continue;
        }

        // Partial match on keyword
        for (const kw of keywords) {
          if (kw.includes(queryKw) || queryKw.includes(kw)) {
            score += 5;
            matchedKeywords.push(kw);
            break;
          }
        }

        // Match in title
        if (doc.title.toLowerCase().includes(queryKw)) {
          score += 3;
        }

        // Match in content
        if (doc.content.toLowerCase().includes(queryKw)) {
          score += 1;
        }
      }

      // Boost by priority
      score += doc.priority * 0.5;

      // Boost by usage count (logarithmic)
      score += Math.log10(doc.usage_count + 1);

      return {
        document: this.mapRowToDocument(doc),
        relevanceScore: score,
        matchedKeywords: [...new Set(matchedKeywords)] // Remove duplicates
      };
    });

    // Sort by relevance and take top results
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return scored.slice(0, maxResults).filter(s => s.relevanceScore > 0);
  }

  /**
   * Query the knowledge base (main method for LLM tool)
   * Returns formatted context string for system prompt
   */
  async queryKnowledgeBase(
    query: string,
    maxResults: number = 3
  ): Promise<string> {
    console.log(`📚 [KNOWLEDGE GRAPH] Querying: "${query}"`);

    const results = this.searchByKeywords({ 
      query, 
      maxResults 
    });

    if (results.length === 0) {
      console.log(`📚 [KNOWLEDGE GRAPH] No relevant documents found`);
      return '';
    }

    console.log(`📚 [KNOWLEDGE GRAPH] Found ${results.length} relevant documents`);

    // Update usage statistics
    for (const result of results) {
      this.incrementUsage(result.document.id!);
    }

    // Format results for context
    return this.formatKnowledgeContext(results);
  }

  /**
   * Increment usage count for a document
   */
  private incrementUsage(id: number): void {
    const now = new Date().toISOString();
    
    this.db.run(
      `UPDATE knowledge_documents 
       SET usage_count = usage_count + 1, last_accessed = ?
       WHERE id = ?`,
      [now, id]
    );
  }

  /**
   * Format search results for system prompt
   * Creates context that Lumia can naturally reference
   * Formatted to encourage chaotic, non-robotic responses
   */
  private formatKnowledgeContext(results: KnowledgeSearchResult[]): string {
    const sections = results.map((result) => {
      const doc = result.document;

      let section = `${doc.title}\n`;

      if (doc.type === 'link' && doc.url) {
        section += `[${doc.url}]\n`;
      }

      section += doc.content;

      return section;
    });

    return `<knowledge-base>
${sections.join('\n\n')}
</knowledge-base>`;
  }

  /**
   * Delete a document
   */
  deleteDocument(id: number): void {
    this.db.run('DELETE FROM knowledge_documents WHERE id = ?', [id]);
    console.log(`📚 [KNOWLEDGE GRAPH] Deleted document ${id}`);
  }

  /**
   * Clear all documents from the knowledge base
   * Use with caution - this deletes EVERYTHING!
   */
  clearAll(): { deletedCount: number } {
    const stats = this.getStats();
    const count = stats.totalDocuments;
    
    this.db.run('DELETE FROM knowledge_documents');
    console.log(`📚 [KNOWLEDGE GRAPH] Cleared all ${count} documents from knowledge base`);
    
    return { deletedCount: count };
  }

  /**
   * Delete all documents for a specific topic
   */
  deleteByTopic(topic: string): { deletedCount: number } {
    const beforeCount = this.db.query(
      'SELECT COUNT(*) as count FROM knowledge_documents WHERE topic = ?'
    ).get(topic) as { count: number };
    
    this.db.run('DELETE FROM knowledge_documents WHERE topic = ?', [topic]);
    console.log(`📚 [KNOWLEDGE GRAPH] Deleted ${beforeCount.count} documents from topic "${topic}"`);
    
    return { deletedCount: beforeCount.count };
  }

  /**
   * List all topics
   */
  listTopics(): string[] {
    const results = this.db.query(
      'SELECT DISTINCT topic FROM knowledge_documents ORDER BY topic'
    ).all() as Array<{ topic: string }>;

    return results.map(r => r.topic);
  }

  /**
   * Get statistics
   */
  getStats(): { totalDocuments: number; totalTopics: number; mostUsed: KnowledgeDocument[] } {
    const totalResult = this.db.query(
      'SELECT COUNT(*) as count FROM knowledge_documents'
    ).get() as { count: number };

    const topicsResult = this.db.query(
      'SELECT COUNT(DISTINCT topic) as count FROM knowledge_documents'
    ).get() as { count: number };

    const mostUsed = this.db.query(
      `SELECT * FROM knowledge_documents 
       ORDER BY usage_count DESC 
       LIMIT 5`
    ).all() as any[];

    return {
      totalDocuments: totalResult.count,
      totalTopics: topicsResult.count,
      mostUsed: mostUsed.map(r => this.mapRowToDocument(r))
    };
  }

  /**
   * Map database row to KnowledgeDocument
   */
  private mapRowToDocument(row: any): KnowledgeDocument {
    return {
      id: row.id,
      topic: row.topic,
      title: row.title,
      content: row.content,
      keywords: JSON.parse(row.keywords),
      type: row.type,
      url: row.url,
      priority: row.priority,
      usageCount: row.usage_count,
      lastAccessed: row.last_accessed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Bulk import documents from a JSON array
   */
  bulkImport(documents: Array<Omit<KnowledgeDocument, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>>): void {
    const now = new Date().toISOString();
    
    const insert = this.db.query(`
      INSERT INTO knowledge_documents 
      (topic, title, content, keywords, type, url, priority, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    for (const doc of documents) {
      insert.run(
        doc.topic,
        doc.title,
        doc.content,
        JSON.stringify(doc.keywords.map(k => k.toLowerCase())),
        doc.type,
        doc.url || null,
        doc.priority,
        now,
        now
      );
    }

    console.log(`📚 [KNOWLEDGE GRAPH] Bulk imported ${documents.length} documents`);
  }

  /**
   * Get document count by topic
   */
  getTopicStats(): Array<{ topic: string; count: number; avgPriority: number }> {
    const results = this.db.query(`
      SELECT 
        topic,
        COUNT(*) as count,
        AVG(priority) as avg_priority
      FROM knowledge_documents
      GROUP BY topic
      ORDER BY count DESC
    `).all() as Array<{ topic: string; count: number; avg_priority: number }>;

    return results.map(r => ({
      topic: r.topic,
      count: r.count,
      avgPriority: Math.round(r.avg_priority * 10) / 10
    }));
  }
}

// Singleton instance
export const knowledgeGraphService = new KnowledgeGraphService();
