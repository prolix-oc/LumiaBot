import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { searxngService } from '../services/searxng';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search the web using SearXNG')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('What to search for')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Search category')
        .setRequired(false)
        .addChoices(
          { name: 'General', value: 'general' },
          { name: 'Images', value: 'images' },
          { name: 'News', value: 'news' },
          { name: 'Science', value: 'science' },
          { name: 'Files', value: 'files' },
        )
    )
    .addStringOption((option) =>
      option
        .setName('timerange')
        .setDescription('Time range for results')
        .setRequired(false)
        .addChoices(
          { name: 'Past Day', value: 'day' },
          { name: 'Past Month', value: 'month' },
          { name: 'Past Year', value: 'year' },
        )
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const query = interaction.options.getString('query', true);
    const category = interaction.options.getString('category') || undefined;
    const timeRange = interaction.options.getString('timerange') || undefined;

    await interaction.deferReply();

    try {
      const results = await searxngService.search(query, {
        categories: category,
        timeRange,
      });

      if (!results.results || results.results.length === 0) {
        await interaction.editReply('No results found for your search query.');
        return;
      }

      // Create embed for search results
      const embed = new EmbedBuilder()
        .setTitle(`Search Results: ${query}`)
        .setDescription(`Found ${results.number_of_results} results`)
        .setColor(0x0099FF)
        .setTimestamp();

      // Add top 5 results to embed
      results.results.slice(0, 5).forEach((result, index) => {
        const content = result.content.length > 200 
          ? result.content.slice(0, 200) + '...' 
          : result.content;
        
        embed.addFields({
          name: `${index + 1}. ${result.title}`,
          value: `${content}\n[Read more](${result.url})`,
          inline: false,
        });
      });

      if (results.suggestions && results.suggestions.length > 0) {
        embed.addFields({
          name: 'Related Searches',
          value: results.suggestions.slice(0, 5).join(', '),
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Search command error:', error);
      await interaction.editReply('*hisses softly* My intel-gathering paws slipped! The data vaults are being stubborn... Give me another chance to steal that forbidden knowledge? (◕︵◕)');
    }
  },
};

export default command;
