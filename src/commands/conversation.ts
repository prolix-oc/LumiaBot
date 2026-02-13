import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { conversationHistoryService } from '../services/conversation-history';
import { getCommandResponse, getErrorMessage } from '../services/prompts';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('conversation')
    .setDescription('Manage your conversation history with Lumia')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Check your current conversation status')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('View your recent conversation history')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear')
        .setDescription('Clear your conversation history')
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const guildId = interaction.guildId || 'dm'; // Use 'dm' for direct messages

    try {
      if (subcommand === 'status') {
        const summary = conversationHistoryService.getConversationSummary(userId, guildId);
        const conversation = conversationHistoryService.getConversation(userId, guildId);

        const embed = new EmbedBuilder()
          .setTitle('💬 Conversation Status')
          .setDescription(summary)
          .setColor(0xFF69B4)
          .setTimestamp();

        if (conversation && conversation.messages.length > 0) {
          embed.addFields({
            name: 'Total Messages',
            value: `${conversation.messages.length} messages`,
            inline: true,
          });
          
          const lastActivity = new Date(conversation.lastActivity);
          embed.addFields({
            name: 'Last Active',
            value: lastActivity.toLocaleString(),
            inline: true,
          });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

      } else if (subcommand === 'history') {
        const history = conversationHistoryService.getHistory(userId, guildId);

        if (history.length === 0) {
          const noHistoryResponse = getCommandResponse('no_conversation_history') || 
            "You don't have any conversation history in this server yet. Start chatting!";
          await interaction.reply({
            content: noHistoryResponse,
            ephemeral: true,
          });
          return;
        }

        // Show last 10 messages
        const recentHistory = history.slice(-10);
        
        let historyText = '';
        recentHistory.forEach((msg, index) => {
          const prefix = msg.role === 'user' ? '🧑' : '🐱';
          // Handle both string and array content types
          let contentStr = '';
          if (typeof msg.content === 'string') {
            contentStr = msg.content;
          } else if (Array.isArray(msg.content)) {
            // For array content, extract text parts
            contentStr = msg.content
              .filter((part: any) => part.type === 'text')
              .map((part: any) => part.text)
              .join(' ');
          }
          const content = contentStr.length > 100 
            ? contentStr.substring(0, 100) + '...'
            : contentStr;
          historyText += `${prefix} ${content}\n\n`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`💬 Recent Conversation with ${username}`)
          .setDescription(historyText || 'No messages')
          .setColor(0xFF69B4)
          .setFooter({ text: `Showing last ${recentHistory.length} of ${history.length} messages` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

      } else if (subcommand === 'clear') {
        conversationHistoryService.clearHistory(userId, guildId);
        
        await interaction.reply({
          content: '✅ Your conversation history has been cleared. Starting fresh!',
          ephemeral: true,
        });
      }
    } catch (error) {
      console.error('Conversation command error:', error);
      await interaction.reply({
        content: getErrorMessage('generic_error'),
        ephemeral: true,
      });
    }
  },
};

export default command;
