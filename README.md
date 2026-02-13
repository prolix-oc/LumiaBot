# LumiaBot

A Discord bot built with Bun + TypeScript that provides AI-powered chat completions with optional web search capabilities via SearXNG.

## Features

- **AI Chat Completions**: Powered by OpenAI's GPT models
- **Web Search Integration**: Uses SearXNG for real-time web search results
- **Message Triggers**: Responds to mentions (@bot) and keywords ("Bad Kitty", "Lumia")
- **Slash Commands**: Modern Discord slash command interface
- **Streaming Support**: Real-time response streaming (optional)
- **TypeScript**: Fully typed for better development experience
- **Bun Runtime**: Fast, modern JavaScript runtime

## Prerequisites

- [Bun](https://bun.sh) installed (v1.3.5 or higher)
- A Discord Application with Bot token
- OpenAI API key
- SearXNG instance (public or self-hosted)

## Installation

1. **Clone the repository** (or create from scratch):
```bash
cd BadKittyBot
```

2. **Install dependencies**:
```bash
bun install
```

3. **Configure environment variables**:
```bash
cp .env.example .env
# Edit .env with your actual credentials
```

4. **Set up bot definitions** (IMPORTANT):
```bash
# Create the prompt_storage directory structure
mkdir -p prompt_storage/persona prompt_storage/instructions prompt_storage/config

# Copy example templates from prompt_storage.example/
cp -r prompt_storage.example/* prompt_storage/

# Edit the files to create your own bot personality
# See BOT_SETUP.md for detailed instructions
```

## Configuration

Create a `.env` file with the following variables:

```env
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_id_here
DISCORD_CLIENT_SECRET=your_discord_client_secret_here
DISCORD_REDIRECT_URI=http://localhost:3000/auth/callback

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
# OPENAI_BASE_URL=https://api.openai.com/v1  # Optional: Custom API base URL (e.g., for OpenRouter, Together AI)
OPENAI_MODEL=gpt-4o-mini
# OPENAI_MODEL_ALIAS=gpt-4o-mini  # Optional: Map to a different model name for the provider
OPENAI_MAX_TOKENS=2000
OPENAI_TEMPERATURE=0.7
OPENAI_FILTER_REASONING=true  # Filter out reasoning content from responses (e.g., o1/o3 models)

# SearXNG Configuration
SEARXNG_URL=https://search.example.com
SEARXNG_MAX_RESULTS=5
SEARXNG_SAFE_SEARCH=1

# Server Configuration
PORT=3000
```

### Using Custom AI Providers

The bot supports custom OpenAI-compatible API providers such as:
- **OpenRouter** (access to multiple models)
- **Together AI**
- **Groq**
- **Google GenAI** (supports video/audio modality)
- **Local models** (via llama.cpp, etc.)

**Example: OpenRouter Configuration**
```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=your_openrouter_key_here
OPENAI_MODEL=anthropic/claude-sonnet-4-5
OPENAI_MODEL_ALIAS=claude-sonnet-4-5  # Optional: alias for the model
```

**Example: Local Model via llama.cpp**
```env
OPENAI_BASE_URL=http://localhost:8080/v1
OPENAI_API_KEY=optional-for-local
OPENAI_MODEL=local-model
```

### Using Google GenAI (Direct Gemini API)

For Gemini 3 models, you can use Google's native GenAI SDK instead of going through an OpenAI-compatible proxy. This provides better native support for Gemini-specific features.

**When to use this:**
- When using Gemini 3 Flash/Pro models
- When you have direct access to Google's Gemini API
- When you want to avoid proxy layers

**Configuration:**
```env
# Set the model to a Gemini 3 variant
OPENAI_MODEL=gemini-3-flash

# Configure Google GenAI (required to activate the native SDK)
GEMINI_API_KEY=your_gemini_api_key_here  # Get from https://ai.google.dev/
# GEMINI_BASE_URL=https://generativelanguage.googleapis.com  # Optional: for custom endpoints
```

**How it works:**
- If `GEMINI_API_KEY` is set AND the model name contains "gemini-3", the bot automatically uses the Google GenAI SDK
- Otherwise, it falls back to the OpenAI SDK (for OpenRouter, Together AI, etc.)
- The bot logs which service it's using on startup: `[AI Service] Using Google GenAI for gemini-3-flash`

### Getting Discord Credentials

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token (DISCORD_TOKEN)
5. Go to "OAuth2" → "General" and copy the Client ID (DISCORD_CLIENT_ID) and Client Secret (DISCORD_CLIENT_SECRET)
6. In "OAuth2" → "URL Generator", select `bot` and `applications.commands` scopes, then copy the generated URL to invite your bot

### Getting OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Go to API keys section and create a new secret key

### Setting up SearXNG

You have two options:

**Option 1: Use a public instance**
- Find public instances at [searx.space](https://searx.space/)
- Note: Public instances may have rate limits

**Option 2: Self-host SearXNG**
```bash
docker run -d --name searxng -p 8080:8080 -e "BASE_URL=http://localhost:8080" searxng/searxng
```

## Usage

### Register Slash Commands

Before using the bot, register the slash commands with Discord:

```bash
bun run register-commands
```

### Start the Bot

Development mode (with hot reload):
```bash
bun run dev
```

Production mode:
```bash
bun run start
```

### Available Commands

Once the bot is running and invited to your server, use these slash commands:

- **`/chat <message> [search]`** - Chat with the AI
  - `message`: Your question or message
  - `search`: (Optional) Enable web search for better answers

- **`/search <query> [category] [timerange]`** - Search the web
  - `query`: What to search for
  - `category`: (Optional) Filter by category (general, images, news, science, files)
  - `timerange`: (Optional) Filter by time (day, month, year)

## Project Structure

```
BadKittyBot/
├── src/
│   ├── bot/
│   │   └── client.ts          # Discord client setup
│   ├── commands/
│   │   ├── chat.ts            # /chat command
│   │   └── search.ts          # /search command
│   ├── scripts/
│   │   └── register-commands.ts # Command registration script
│   ├── services/
│   │   ├── openai.ts          # OpenAI integration
│   │   └── searxng.ts         # SearXNG search integration
│   ├── utils/
│   │   └── config.ts          # Configuration management
│   └── index.ts               # Entry point
├── .env                       # Environment variables
├── .env.example               # Example environment file
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Adding New Commands

1. Create a new file in `src/commands/`:
```typescript
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('Description of my command'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply('Hello from my command!');
  },
};

export default command;
```

2. Register the command:
```bash
bun run register-commands
```

### Environment Variables

All configuration is managed through environment variables. See `.env.example` for all available options.

## Bot Personality Configuration

The bot's personality is defined in the `prompt_storage/` directory, which is **excluded from git** for privacy. You must create these files yourself using the provided templates.

### Setting Up Bot Definitions

1. **Create the directory structure:**
```bash
mkdir -p prompt_storage/persona prompt_storage/instructions prompt_storage/config
```

2. **Copy example templates:**
```bash
cp -r prompt_storage.example/* prompt_storage/
```

3. **Customize the files** to create your own bot personality (see `BOT_SETUP.md` for detailed instructions)

4. **Restart the bot** to load your custom personality

### Why This Approach?

The `prompt_storage/` directory is gitignored to keep your bot's unique personality private. The example templates in `prompt_storage.example/` show you the required file structure and format without exposing any proprietary content.

### File Structure

```
prompt_storage/
├── persona/
│   ├── identity.txt           # Main bot personality/system prompt
│   ├── boredom_pings.json     # Random messages when bot is "bored"
│   ├── error_templates.json   # Error/fallback responses
│   └── command_responses.json # Command-specific responses
├── instructions/
│   ├── video_reaction.txt     # How to react to videos
│   ├── reply_context.json     # Reply conversation templates
│   ├── memory_system.txt      # Memory formation instructions
│   └── boredom_updates.txt    # Boredom opt-in/opt-out responses
└── config/
    ├── triggers.json          # Bot trigger keywords
    └── tool_descriptions.json # Tool descriptions with personality
```

See `BOT_SETUP.md` for complete documentation on creating and customizing these files.

## Message Triggers

The bot automatically responds to messages when:

1. **Mentioned directly** - `@BadKittyBot hello!`
2. **Trigger keywords detected** - Messages containing:
   - `Bad Kitty` (case insensitive)
   - `Lumia` (case insensitive)
3. **Replied to** — replies to their messages

### Examples

```
@BadKittyBot What's the weather today?
→ Bot responds with AI-generated answer

Hey Bad Kitty, can you help me with something?
→ Bot responds with AI-generated answer

Lumia, what do you think about this?
→ Bot responds with AI-generated answer
```

### How it Works

- The bot monitors all messages in channels it has access to
- When triggered, it extracts the actual message content (removing the trigger)
- Generates an AI response using the bot's personality from `prompt_storage/persona/identity.txt`
- Replies directly to the user's message

**Note:** Message triggers do not use web search by default (unlike the `/chat` command with `search: true`).

### Reasoning Content Filtering

The bot automatically filters out reasoning content from AI models that include it (such as o1, o3, DeepSeek-R1, etc.). This prevents internal "thinking" from being shown to users.

**Filtered patterns include:**
- `<think>...</think>` tags
- `<reasoning>...</reasoning>` tags
- `[REASONING]...[/REASONING]` tags
- Lines starting with "reasoning:", "thinking:", etc.

To disable filtering, set:
```env
OPENAI_FILTER_REASONING=false
```

## Troubleshooting

### Bot not responding to commands
- Ensure you've registered commands with `bun run register-commands`
- Check that the bot has proper permissions in the Discord server
- Verify the bot token is correct

### OpenAI errors
- Check your API key is valid and has available credits
- Verify the model name is correct
- Check rate limits haven't been exceeded

### SearXNG errors
- Ensure the SearXNG URL is accessible
- Check if the instance requires authentication
- Verify the instance supports JSON output format

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
