# Knowledge Documents Directory

This directory contains Markdown files that will be automatically parsed and imported into Lumia's knowledge graph.

## Quick Start

1. **Create a Markdown file** in this directory
2. **Add metadata** (see formats below)
3. **Run the import**: `bun run src/scripts/import-to-db.ts`
4. **Test it**: Ask Lumia about the topic!

## Document Format

### Option 1: Frontmatter Style (Recommended)

```markdown
---
topic: lucid-loom
title: My Awesome Guide
keywords: loom, guide, tutorial, help
type: document
priority: 8
url: https://example.com/optional-link
---

# My Awesome Guide

Your content here in Markdown format...
```

### Option 2: Inline Header Style

```markdown
# My Awesome Guide

**Topic:** lucid-loom  
**Keywords:** loom, guide, tutorial, help  
**Type:** document  
**Priority:** 8  
**URL:** https://example.com/optional-link

Your content here...
```

## Metadata Fields

| Field | Required | Description |
|-------|----------|-------------|
| `topic` | Yes | Category/topic (e.g., `lucid-loom`, `coding`, `ai`) |
| `title` | No | Document title (auto-extracted from H1 if not provided) |
| `keywords` | Yes | Comma-separated search terms |
| `type` | No | `document`, `link`, or `snippet` (default: `document`) |
| `priority` | No | 1-10 importance rating (default: 5) |
| `url` | No | External link (required if type is `link`) |

## Document Types

- **`document`** - Full article/guide (most common)
- **`link`** - Reference to external resource
- **`snippet`** - Short fact or quick reference

## Naming Convention

Files are sorted alphabetically during import. Use prefixes for organization:

```
01-overview.md
02-setup-guide.md
03-advanced-topics.md
```

**Note:** `README.md` files are automatically excluded from import. Use README.md for directory documentation only.

## Commands

### Import Documents
```bash
# Preview what will be imported (dry run)
bun run src/scripts/import-to-db.ts --dry-run

# Import to database
bun run src/scripts/import-to-db.ts

# Force import even if duplicates exist
bun run src/scripts/import-to-db.ts --force

# Import from different directory
bun run src/scripts/import-to-db.ts ./my-docs
```

### Clear Knowledge Base
```bash
# Preview what would be deleted (dry run)
bun run src/scripts/clear-knowledge.ts --dry-run

# Clear all documents (requires confirmation)
bun run src/scripts/clear-knowledge.ts --all

# Clear specific topic
bun run src/scripts/clear-knowledge.ts --topic lucid-loom --all
```

## Tips for Great Documents

1. **Keep it conversational** - Lumia will reframe this in her voice, so write naturally
2. **Include specific keywords** - Think about what users might ask
3. **One concept per document** - Easier to retrieve and more relevant
4. **Use proper Markdown** - Headers, lists, and formatting help readability
5. **Set appropriate priority** - 9-10 for critical info, 1-3 for niche topics

## Discord Commands

Administrators can manage the knowledge base directly from Discord:

- **`/knowledge add`** - Add a new document
- **`/knowledge list`** - Browse all documents
- **`/knowledge search <query>`** - Find documents by keywords
- **`/knowledge delete <id>`** - Remove a specific document
- **`/knowledge stats`** - View usage analytics
- **`/knowledge topics`** - List all topic categories
- **`/knowledge clear confirm:true`** - ⚠️ Clear ALL documents (use with caution!)
- **`/knowledge clear-topic topic:loom confirm:true`** - Clear documents from a specific topic

## Example Documents

See the existing `.md` files in this directory for examples!

---

**Need help?** Use `/knowledge` commands in Discord or check the code in `src/utils/markdown-parser.ts`
