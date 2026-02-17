import { bot } from './bot/client';
import { validateConfig, config } from './utils/config';
import { loadBotDefinition } from './utils/bot-definition';
import { setTemplateVariables } from './services/prompts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Events } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function loadCommands() {
  const commandsPath = join(__dirname, 'commands');
  const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.ts'));

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const command = await import(filePath);
    
    if ('default' in command && command.default.data && command.default.execute) {
      bot.commands.set(command.default.data.name, command.default);
      console.log(`Registered command: ${command.default.data.name}`);
    }
  }
}

async function main() {
  try {
    // Validate environment configuration
    validateConfig();
    console.log('Configuration validated successfully');

    // Apply bot template variables from environment
    setTemplateVariables({
      botName: config.bot.name,
      ownerName: config.bot.ownerName,
      ownerId: config.bot.ownerId,
      ownerUsername: config.bot.ownerUsername,
    });
    console.log(`Bot configured as: ${config.bot.name}`);

    // Load bot definition from bot.txt
    loadBotDefinition();

    // Load commands
    await loadCommands();
    console.log('Commands loaded successfully');

    // Start the bot
    await bot.login();
    console.log('Bot started successfully');

    // Note: Guild updates are now handled by the onConnect callback in the orchestrator
    // This ensures guilds are sent immediately after the WebSocket connection is established

    // Handle guild join/leave events for orchestrator
    bot.client.on(Events.GuildCreate, (guild) => {
      console.log(`[Orchestrator] Joined guild: ${guild.name} (${guild.id})`);
      bot.updateOrchestratorGuilds();
    });

    bot.client.on(Events.GuildDelete, (guild) => {
      console.log(`[Orchestrator] Left guild: ${guild.name} (${guild.id})`);
      bot.updateOrchestratorGuilds();
    });

    // Periodic guild sync every 5 minutes to ensure orchestrator has latest data
    setInterval(() => {
      if (bot.client.isReady()) {
        const status = bot.getOrchestratorStatus();
        if (status?.isConnected) {
          console.log('[Orchestrator] Periodic guild sync check...');
          bot.updateOrchestratorGuilds();
        }
      }
    }, 5 * 60 * 1000);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down gracefully...');
      await bot.destroy();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down gracefully...');
      await bot.destroy();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
