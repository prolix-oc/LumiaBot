import { REST, Routes } from 'discord.js';
import { config } from '../utils/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands: unknown[] = [];

// Load all command files
const commandsPath = path.join(__dirname, '..', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = await import(filePath);
  
  if ('default' in command && command.default.data) {
    commands.push(command.default.data.toJSON());
    console.log(`Loaded command: ${command.default.data.name}`);
  }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(config.discord.token);

// Deploy commands
(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    // The put method is used to fully refresh all commands in the guild with the current set
    const data = await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commands },
    ) as unknown[];

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
  }
})();
