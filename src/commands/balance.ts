import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { config, isMoonshotProvider } from '../utils/config';
import { getLastBalance, getLastRequestCost, getBalanceCurrency } from '../services/moonshot';
import { getLastToolExecutionSnapshot } from '../services/openai';
import type { Command } from '../bot/client';

const balanceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check the Moonshot API account balance (owner only)') as SlashCommandBuilder,
  ownerOnly: true,

  async execute(interaction: ChatInputCommandInteraction) {
    if (interaction.user.id !== config.bot.ownerId) {
      await interaction.reply({
        content: 'This command is only available to the bot owner.',
        ephemeral: true,
      });
      return;
    }

    if (!isMoonshotProvider()) {
      await interaction.reply({
        content: 'Balance tracking is only available when using a Moonshot API provider.',
        ephemeral: true,
      });
      return;
    }

    const balance = getLastBalance();

    if (!balance) {
      await interaction.reply({
        content: 'No balance data available yet. Send a message first so the bot can fetch the balance.',
        ephemeral: true,
      });
      return;
    }

    const lastCost = getLastRequestCost();
    const c = getBalanceCurrency();
    const snapshot = getLastToolExecutionSnapshot();

    const toolSummary = snapshot
      ? [
          `status: ${snapshot.status}`,
          `runTools: ${snapshot.runToolsUsed ? 'yes' : 'no'}`,
          `offered: ${snapshot.toolsOffered}`,
          `calls/rounds: ${snapshot.toolCalls}/${snapshot.toolRounds}`,
          `thinking: ${snapshot.thinkingEnabled ? 'on' : 'off'}${snapshot.moonshotThinkingModel ? ' (moonshot model)' : ''}`,
          snapshot.reason ? `note: ${snapshot.reason}` : null,
        ].filter(Boolean).join('\n')
      : 'No recent AI execution snapshot yet.';

    const embed = new EmbedBuilder()
      .setTitle('Moonshot API Balance')
      .addFields(
        { name: 'Available', value: `${c}${balance.available_balance.toFixed(2)}`, inline: true },
        { name: 'Cash', value: `${c}${balance.cash_balance.toFixed(2)}`, inline: true },
        { name: 'Voucher', value: `${c}${balance.voucher_balance.toFixed(2)}`, inline: true },
        { name: 'Last Request Cost', value: lastCost !== null ? `${c}${lastCost.toFixed(4)}` : 'N/A', inline: true },
        { name: 'Last Tool Execution', value: toolSummary, inline: false },
      )
      .setColor(0x5865F2)
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  },
};

export default balanceCommand;
