import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction } from 'discord.js';
import { knowledgeGraphService } from '../services/knowledge-graph';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('knowledge')
    .setDescription('Manage the knowledge graph')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a new document to the knowledge base')
        .addStringOption(option =>
          option
            .setName('topic')
            .setDescription('Topic category (e.g., lucid-loom, coding, ai)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('title')
            .setDescription('Document title')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('content')
            .setDescription('Document content')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('keywords')
            .setDescription('Comma-separated keywords for search (e.g., loom, preset, ll)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('type')
            .setDescription('Document type')
            .setRequired(true)
            .addChoices(
              { name: 'Document', value: 'document' },
              { name: 'Link/URL', value: 'link' },
              { name: 'Snippet', value: 'snippet' }
            )
        )
        .addStringOption(option =>
          option
            .setName('url')
            .setDescription('URL (if type is link)')
            .setRequired(false)
        )
        .addIntegerOption(option =>
          option
            .setName('priority')
            .setDescription('Priority (1-10, higher = more important)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List documents in the knowledge base')
        .addStringOption(option =>
          option
            .setName('topic')
            .setDescription('Filter by topic')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('search')
        .setDescription('Search the knowledge base')
        .addStringOption(option =>
          option
            .setName('query')
            .setDescription('Search query')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Delete a document')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Document ID')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Show knowledge base statistics')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('topics')
        .setDescription('List all topics')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear')
        .setDescription('⚠️ Clear all documents from the knowledge base')
        .addBooleanOption(option =>
          option
            .setName('confirm')
            .setDescription('Set to true to confirm deletion')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear-topic')
        .setDescription('Clear all documents from a specific topic')
        .addStringOption(option =>
          option
            .setName('topic')
            .setDescription('Topic to clear')
            .setRequired(true)
        )
        .addBooleanOption(option =>
          option
            .setName('confirm')
            .setDescription('Set to true to confirm deletion')
            .setRequired(true)
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'add': {
          const topic = interaction.options.getString('topic', true);
          const title = interaction.options.getString('title', true);
          const content = interaction.options.getString('content', true);
          const keywordsStr = interaction.options.getString('keywords', true);
          const type = interaction.options.getString('type', true) as 'document' | 'link' | 'snippet';
          const url = interaction.options.getString('url') || undefined;
          const priority = interaction.options.getInteger('priority') || 5;

          const keywords = keywordsStr.split(',').map(k => k.trim()).filter(k => k.length > 0);

          knowledgeGraphService.storeDocument({
            topic,
            title,
            content,
            keywords,
            type,
            url,
            priority,
          });

          await interaction.reply({
            content: `✅ Document "${title}" added to knowledge base under topic "${topic}"!`,
            ephemeral: true,
          });
          break;
        }

        case 'list': {
          const topic = interaction.options.getString('topic');
          let documents;
          
          if (topic) {
            documents = knowledgeGraphService.getDocumentsByTopic(topic, 20);
          } else {
            // Get all documents (limit to 20)
            const topics = knowledgeGraphService.listTopics();
            documents = [];
            for (const t of topics.slice(0, 5)) {
              const docs = knowledgeGraphService.getDocumentsByTopic(t, 5);
              documents.push(...docs);
            }
          }

          if (documents.length === 0) {
            await interaction.reply({
              content: '📚 No documents found in the knowledge base.',
              ephemeral: true,
            });
            return;
          }

          const formatted = documents.map(doc => 
            `**${doc.id}**. **${doc.title}** (${doc.topic}) - Priority: ${doc.priority}`
          ).join('\n');

          // Split into chunks if too long
          const chunks = [];
          let currentChunk = '📚 **Knowledge Base Documents:**\n\n';
          
          for (const line of formatted.split('\n')) {
            if (currentChunk.length + line.length > 1900) {
              chunks.push(currentChunk);
              currentChunk = line + '\n';
            } else {
              currentChunk += line + '\n';
            }
          }
          chunks.push(currentChunk);

          await interaction.reply({
            content: chunks[0],
            ephemeral: true,
          });

          // Send additional chunks if needed
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({
              content: chunks[i],
              ephemeral: true,
            });
          }
          break;
        }

        case 'search': {
          const query = interaction.options.getString('query', true);
          const results = knowledgeGraphService.searchByKeywords({ 
            query, 
            maxResults: 5 
          });

          if (results.length === 0) {
            await interaction.reply({
              content: `🔍 No documents found matching "${query}".`,
              ephemeral: true,
            });
            return;
          }

          const formatted = results.map(result => {
            const doc = result.document;
            return `**${doc.id}**. **${doc.title}** (${doc.topic})\n` +
                   `   Score: ${Math.round(result.relevanceScore)} | ` +
                   `Keywords: ${result.matchedKeywords.join(', ') || 'none'}`;
          }).join('\n\n');

          await interaction.reply({
            content: `🔍 **Search Results for "${query}":**\n\n${formatted}`,
            ephemeral: true,
          });
          break;
        }

        case 'delete': {
          const id = interaction.options.getInteger('id', true);
          
          const doc = knowledgeGraphService.getDocument(id);
          if (!doc) {
            await interaction.reply({
              content: `❌ Document with ID ${id} not found.`,
              ephemeral: true,
            });
            return;
          }

          knowledgeGraphService.deleteDocument(id);

          await interaction.reply({
            content: `🗑️ Document "${doc.title}" deleted from knowledge base.`,
            ephemeral: true,
          });
          break;
        }

        case 'stats': {
          const stats = knowledgeGraphService.getStats();
          const topicStats = knowledgeGraphService.getTopicStats();

          let message = `📊 **Knowledge Base Statistics:**\n\n`;
          message += `Total Documents: **${stats.totalDocuments}**\n`;
          message += `Total Topics: **${stats.totalTopics}**\n\n`;
          
          message += `**Topics Breakdown:**\n`;
          topicStats.forEach(stat => {
            message += `• ${stat.topic}: ${stat.count} docs (avg priority: ${stat.avgPriority})\n`;
          });

          if (stats.mostUsed.length > 0) {
            message += `\n**Most Referenced:**\n`;
            stats.mostUsed.slice(0, 3).forEach(doc => {
              message += `• "${doc.title}" (${doc.usageCount} times)\n`;
            });
          }

          await interaction.reply({
            content: message,
            ephemeral: true,
          });
          break;
        }

        case 'topics': {
          const topics = knowledgeGraphService.listTopics();
          
          if (topics.length === 0) {
            await interaction.reply({
              content: '📚 No topics found in the knowledge base.',
              ephemeral: true,
            });
            return;
          }

          const message = `📁 **Knowledge Base Topics:**\n\n` +
            topics.map(t => `• ${t}`).join('\n');

          await interaction.reply({
            content: message,
            ephemeral: true,
          });
          break;
        }

        case 'clear': {
          const confirm = interaction.options.getBoolean('confirm', true);
          
          if (!confirm) {
            await interaction.reply({
              content: '⚠️ This would clear ALL documents from the knowledge base! Set confirm to true if you\'re sure.',
              ephemeral: true,
            });
            return;
          }

          const stats = knowledgeGraphService.getStats();
          const result = knowledgeGraphService.clearAll();

          await interaction.reply({
            content: `🗑️ **Knowledge Base Cleared**\n\nDeleted ${result.deletedCount} documents from ${stats.totalTopics} topics.\nThe knowledge base is now empty.`,
            ephemeral: true,
          });
          break;
        }

        case 'clear-topic': {
          const topic = interaction.options.getString('topic', true);
          const confirm = interaction.options.getBoolean('confirm', true);
          
          if (!confirm) {
            await interaction.reply({
              content: `⚠️ This would clear all documents from topic "${topic}"! Set confirm to true if you're sure.`,
              ephemeral: true,
            });
            return;
          }

          const topicDocs = knowledgeGraphService.getDocumentsByTopic(topic);
          
          if (topicDocs.length === 0) {
            await interaction.reply({
              content: `❌ Topic "${topic}" not found or has no documents.`,
              ephemeral: true,
            });
            return;
          }

          const result = knowledgeGraphService.deleteByTopic(topic);

          await interaction.reply({
            content: `🗑️ **Topic Cleared: "${topic}"**\n\nDeleted ${result.deletedCount} documents.`,
            ephemeral: true,
          });
          break;
        }

        default:
          await interaction.reply({
            content: '❓ Unknown subcommand.',
            ephemeral: true,
          });
      }
    } catch (error) {
      console.error('Knowledge command error:', error);
      await interaction.reply({
          content: '❌ An error occurred while processing your command.',
          ephemeral: true,
        });
    }
  },
};

export default command;
