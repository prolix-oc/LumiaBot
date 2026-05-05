import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { userMemoryService } from '../services/user-memory';
import { getCommandResponse, getErrorMessage } from '../services/prompts';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('memories')
    .setDescription('View users Lumia has formed opinions about')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('List all users Lumia has opinions about')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('view')
        .setDescription('View Lumia\'s opinion about a specific user')
        .addStringOption((option) =>
          option
            .setName('username')
            .setDescription('Username to look up')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear')
        .setDescription('Clear all memories (owner only)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear-user')
        .setDescription('Clear stored opinion for a user ID (owner only)')
        .addStringOption((option) =>
          option
            .setName('user-id')
            .setDescription('Discord user ID whose stored opinion should be cleared')
            .setRequired(true)
        )
    ) as SlashCommandBuilder,
  ownerOnlySubcommands: ['clear', 'clear-user'],

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'list') {
        const users = userMemoryService.listUsers();

        if (users.length === 0) {
          const noMemoriesResponse = getCommandResponse('no_memories_yet') || 
            "I haven't formed any opinions about users yet. Start chatting with me to build up your memory collection~";
          await interaction.reply({
            content: noMemoriesResponse,
            ephemeral: true,
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('Users Lumia Has Opinions About')
          .setDescription(`Total: ${users.length} users`)
          .setColor(0xFF69B4)
          .setTimestamp();

        // Group by sentiment
        const sentimentEmojis: Record<string, string> = {
          positive: '😊',
          negative: '😤',
          neutral: '😐',
          mixed: '🤔',
        };

        users.slice(0, 25).forEach((user) => {
          const emoji = sentimentEmojis[user.sentiment] || '💭';
          embed.addFields({
            name: `${emoji} ${user.username}`,
            value: `Sentiment: ${user.sentiment}\nLast updated: ${new Date(user.updatedAt).toLocaleDateString()}`,
            inline: true,
          });
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });

      } else if (subcommand === 'view') {
        const username = interaction.options.getString('username', true);
        const opinion = userMemoryService.getOpinionByUsername(username);

        if (!opinion) {
          await interaction.reply({
            content: `Lumia doesn't have any opinions about **${username}** yet.`,
            ephemeral: true,
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`Lumia's Opinion About ${opinion.username}`)
          .setDescription(opinion.opinion)
          .addFields(
            { name: 'Sentiment', value: opinion.sentiment, inline: true },
            { name: 'Pronouns', value: opinion.pronouns || 'Not specified', inline: true },
            { name: 'First Met', value: new Date(opinion.createdAt).toLocaleDateString(), inline: true }
          )
          .setColor(
            opinion.sentiment === 'positive' ? 0x00FF00 :
            opinion.sentiment === 'negative' ? 0xFF0000 :
            opinion.sentiment === 'mixed' ? 0xFFA500 :
            0x808080
          )
          .setTimestamp();

        // Add third-party context if it exists
        if (opinion.thirdPartyContext) {
          embed.addFields({
            name: 'What Others Have Said',
            value: opinion.thirdPartyContext.length > 1024 
              ? opinion.thirdPartyContext.substring(0, 1021) + '...'
              : opinion.thirdPartyContext,
            inline: false,
          });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

      } else if (subcommand === 'clear') {
        // In a real implementation, you'd want to check for bot owner/admin permissions
        // For now, just return info
        await interaction.reply({
          content: 'This command would clear all user memories. Feature available to bot owner only.',
          ephemeral: true,
        });
      } else if (subcommand === 'clear-user') {
        const userId = interaction.options.getString('user-id', true);
        const opinion = userMemoryService.getOpinion(userId);
        const deletedCount = userMemoryService.deleteOpinion(userId);

        await interaction.reply({
          content: deletedCount > 0
            ? `✅ Cleared stored opinion for ${opinion?.username || userId} (${userId}).`
            : `No stored opinion found for user ID ${userId}.`,
          ephemeral: true,
        });
      }
    } catch (error) {
      console.error('Memories command error:', error);
      await interaction.reply({
        content: getErrorMessage('generic_error'),
        ephemeral: true,
      });
    }
  },
};

export default command;
