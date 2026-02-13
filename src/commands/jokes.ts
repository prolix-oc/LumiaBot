import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { guildMemoryService } from '../services/guild-memory';
import { getCommandResponse, getErrorMessage } from '../services/prompts';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('jokes')
    .setDescription('Manage inside jokes for this server')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add a new inside joke')
        .addStringOption((option) =>
          option
            .setName('joke')
            .setDescription('The inside joke or running gag')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('context')
            .setDescription('Optional context for when to use this joke')
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('List all inside jokes for this server')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('random')
        .setDescription('Get a random inside joke')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('Delete an inside joke (requires joke ID)')
        .addIntegerOption((option) =>
          option
            .setName('id')
            .setDescription('The ID of the joke to delete (use /jokes list to see IDs)')
            .setRequired(true)
        )
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // Inside jokes only work in guilds
    if (!guildId) {
      const guildOnlyResponse = getCommandResponse('inside_jokes_only_guild') || 'Inside jokes are for servers only!';
      await interaction.reply({
        content: guildOnlyResponse,
        ephemeral: true,
      });
      return;
    }

    try {
      if (subcommand === 'add') {
        const joke = interaction.options.getString('joke', true);
        const context = interaction.options.getString('context') || undefined;
        
        guildMemoryService.addInsideJoke(guildId, joke, interaction.user.username, context);

        const embed = new EmbedBuilder()
          .setTitle('🎭 New Inside Joke Added!')
          .setDescription(`**${joke}**`)
          .setColor(0xFFD700)
          .setTimestamp();

        if (context) {
          embed.addFields({
            name: 'Context',
            value: context,
            inline: false,
          });
        }

        await interaction.reply({ embeds: [embed] });

      } else if (subcommand === 'list') {
        const jokes = guildMemoryService.getInsideJokes(guildId);

        if (jokes.length === 0) {
          const noJokesResponse = getCommandResponse('no_jokes_found') || 
            'No inside jokes found for this server yet! Add some with `/jokes add`.';
          await interaction.reply({
            content: noJokesResponse,
            ephemeral: true,
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('🎭 Inside Jokes for This Server')
          .setDescription(`Total: ${jokes.length} inside jokes`)
          .setColor(0xFFD700)
          .setTimestamp();

        // Show up to 10 jokes to avoid hitting embed limits
        jokes.slice(0, 10).forEach((joke, index) => {
          const contextStr = joke.context ? `\n*Context: ${joke.context}*` : '';
          const usageStr = `\n_Used ${joke.usageCount} time${joke.usageCount !== 1 ? 's' : ''}_`;
          
          embed.addFields({
            name: `${index + 1}. ID: ${joke.id}`,
            value: `"${joke.joke}"${contextStr}${usageStr}`,
            inline: false,
          });
        });

        if (jokes.length > 10) {
          embed.setFooter({ text: `Showing 10 of ${jokes.length} jokes` });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

      } else if (subcommand === 'random') {
        const joke = guildMemoryService.getRandomInsideJoke(guildId);

        if (!joke) {
          const noJokesResponse = getCommandResponse('no_jokes_found') || 
            'No inside jokes found for this server yet! Add some with `/jokes add`.';
          await interaction.reply({
            content: noJokesResponse,
            ephemeral: true,
          });
          return;
        }

        // Increment usage count
        if (joke.id) {
          guildMemoryService.incrementJokeUsage(joke.id);
        }

        const embed = new EmbedBuilder()
          .setTitle('🎭 Random Inside Joke')
          .setDescription(`**${joke.joke}**`)
          .setColor(0xFFD700)
          .setFooter({ text: `Used ${joke.usageCount + 1} time${joke.usageCount + 1 !== 1 ? 's' : ''} • Created by ${joke.createdBy}` })
          .setTimestamp();

        if (joke.context) {
          embed.addFields({
            name: 'Context',
            value: joke.context,
            inline: false,
          });
        }

        await interaction.reply({ embeds: [embed] });

      } else if (subcommand === 'delete') {
        const jokeId = interaction.options.getInteger('id', true);
        
        // Get the joke first to confirm it exists
        const jokes = guildMemoryService.getInsideJokes(guildId);
        const joke = jokes.find(j => j.id === jokeId);
        
        if (!joke) {
          const notFoundResponse = getCommandResponse('joke_not_found') || 
            "Couldn't find an inside joke with that ID! Use `/jokes list` to see available jokes.";
          await interaction.reply({
            content: notFoundResponse,
            ephemeral: true,
          });
          return;
        }

        guildMemoryService.deleteInsideJoke(jokeId);

        const embed = new EmbedBuilder()
          .setTitle('🗑️ Inside Joke Deleted')
          .setDescription(`**"${joke.joke}"** has been removed.`)
          .setColor(0xFF6B6B)
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
      }
    } catch (error) {
      console.error('Jokes command error:', error);
      await interaction.reply({
        content: getErrorMessage('generic_error'),
        ephemeral: true,
      });
    }
  },
};

export default command;
