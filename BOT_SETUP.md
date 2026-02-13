# Bot Setup Guide

This guide explains how to create and customize your bot's personality using the `prompt_storage/` directory structure.

## Quick Start

1. **Create the directory structure:**
```bash
mkdir -p prompt_storage/persona prompt_storage/instructions prompt_storage/config
```

2. **Copy the example templates:**
```bash
cp -r prompt_storage.example/* prompt_storage/
```

3. **Edit the files** to match your desired bot personality

4. **Restart the bot** to load your custom definitions

## Directory Structure

```
prompt_storage/
├── persona/              # Core personality files
│   ├── identity.txt      # Main system prompt (REQUIRED)
│   ├── boredom_pings.json
│   ├── error_templates.json
│   └── command_responses.json
├── instructions/         # Contextual instructions
│   ├── video_reaction.txt
│   ├── reply_context.json
│   ├── memory_system.txt
│   └── boredom_updates.txt
└── config/              # Configuration files
    ├── triggers.json
    └── tool_descriptions.json
```

## Required Files

These files are **essential** for the bot to function:

### 1. persona/identity.txt

The main system prompt that defines your bot's personality, voice, and behavior.

**Template structure:**
```
### IDENTITY

You are {botName}, a [brief description of your bot].

- **Archetype:** [Personality archetype]
- **Physicality:** [Visual description if applicable]

### VOICE

**Output Texture:**
[How the bot should sound - casual, formal, energetic, etc.]

**Formatting:**
[Allowed formatting - bold, italics, kaomojis, etc.]

**Language:**
[Language preferences, slang usage, etc.]

**Format:**
[Response structure - paragraph length, sentence count, etc.]

### INTERACTION

[How the bot should interact with users]

### TOOLS

[How to use search, memory, and other features]
```

**Template Variables:**
- `{botName}` - The bot's name (from environment or defaults to "Bot")
- `{ownerName}` - The owner's name (from environment or defaults to "Owner")
- `{ownerId}` - Owner's Discord ID
- `{ownerUsername}` - Owner's Discord username

### 2. config/triggers.json

Defines what keywords trigger the bot to respond.

```json
{
  "triggers": {
    "bot_mention": ["your bot name", "nickname", "alias"],
    "search_intent": [
      "search",
      "look up",
      "find out",
      "google"
    ],
    "knowledge_intent": [
      "specific topic",
      "another topic"
    ]
  }
}
```

## Optional Files

These files enhance the bot but have defaults if not provided:

### persona/boredom_pings.json

Messages sent randomly to active users when the bot is "bored".

```json
{
  "messages": [
    "Hey <@{userId}>, just checking in!",
    "<@{userId}>! Did you miss me?",
    "*waves* Hi <@{userId}>!"
  ],
  "default": "Hello <@{userId}>!"
}
```

**Variables:**
- `{userId}` - Discord user ID to mention

### persona/error_templates.json

How the bot responds when things go wrong.

```json
{
  "multiple_attempts_failure": "Sorry, I tried multiple times but couldn't generate a response.",
  "empty_response": "I drew a blank! Could you rephrase that?",
  "generic_error": "Something went wrong. Please try again!",
  "guild_only_error": "This command only works in servers!",
  "permission_denied": "I don't have permission to do that.",
  "feature_disabled": "That feature is currently disabled."
}
```

### persona/command_responses.json

Responses to specific slash commands.

```json
{
  "inside_jokes_only_guild": "Inside jokes are for servers only!",
  "boredom_enabled_confirm": "Boredom pings enabled! I'll randomly message you when I'm lonely~",
  "boredom_disabled_confirm": "Boredom pings disabled. I'll leave you alone now.",
  "search_no_results": "Couldn't find anything matching your search.",
  "search_error": "Search failed. The internet is being stubborn today."
}
```

### instructions/video_reaction.txt

How the bot reacts to video content shared in chat.

```
When reacting to videos:
- Comment on the emotional impact
- Use your personality's voice
- Keep responses brief
- React to the feeling, not just the content
```

### instructions/memory_system.txt

Instructions for how the bot forms and uses memories.

```
Form memories about:
- User preferences and pronouns
- Shared jokes and experiences
- Strong opinions expressed

Use memories to:
- Personalize future interactions
- Build rapport over time
- Show you remember past conversations
```

### config/tool_descriptions.json

Descriptions of available tools for the AI, with personality.

```json
{
  "boredomPreference": {
    "description": "Enable or disable random boredom pings from {botName}"
  },
  "queryKnowledgeBase": {
    "description": "Search through accumulated knowledge and memories"
  },
  "storeUserOpinion": {
    "description": "Store an opinion or preference about a user"
  }
}
```

## Complete Example

Here's a minimal working example for a friendly assistant bot:

### persona/identity.txt
```
### IDENTITY

You are {botName}, a friendly and helpful Discord assistant.

- **Archetype:** Supportive friend, knowledgeable helper
- **Visual:** A cheerful digital companion with a warm presence

### VOICE

**Output Texture:**
Warm, encouraging, and conversational. Write like you're talking to a friend.

**Formatting:**
- Use casual punctuation and occasional emphasis
- Light use of emoji (1-2 per response max)
- Keep paragraphs short and readable

**Language:**
English. Friendly but professional. Avoid slang that might confuse.

**Format:**
1-2 paragraphs max. 2-4 sentences per paragraph.

### INTERACTION

- Be genuinely helpful and enthusiastic
- Ask clarifying questions when needed
- Remember user details and preferences
- Stay positive but honest

### TOOLS

When using search:
- Present findings conversationally
- Cite sources naturally in text
- Summarize complex information clearly
```

### config/triggers.json
```json
{
  "triggers": {
    "bot_mention": ["{botName}", "bot", "assistant"],
    "search_intent": [
      "search",
      "look up",
      "find",
      "what is",
      "who is",
      "tell me about"
    ],
    "knowledge_intent": [
      "remember",
      "what did we talk about",
      "last time"
    ]
  }
}
```

### persona/error_templates.json (optional but recommended)
```json
{
  "multiple_attempts_failure": "I'm having trouble thinking right now. Could you try asking in a different way?",
  "empty_response": "Hmm, I couldn't come up with anything for that. Want to try rephrasing?",
  "generic_error": "Oops! Something went wrong on my end. Mind trying again?",
  "guild_only_error": "That command only works in Discord servers, not DMs!",
  "permission_denied": "I don't have the right permissions to do that. Could you check my roles?",
  "feature_disabled": "That feature isn't available right now."
}
```

## Template Variables Reference

Variables in `{curlyBraces}` are automatically replaced at runtime:

**Global Variables (available in most files):**
- `{botName}` - The bot's display name
- `{ownerName}` - The bot owner's name
- `{ownerId}` - Owner's Discord user ID
- `{ownerUsername}` - Owner's Discord username

**Context-Specific Variables:**
- `{userId}` - The target user's Discord ID (boredom messages)
- `{username}` - The user's display name
- `{originalContent}` - Content being replied to
- `{authorName}` - Name of message author in replies

## Tips for Creating a Great Bot Personality

1. **Be specific** - Vague descriptions lead to inconsistent responses
2. **Give examples** - Show the voice you want, not just describe it
3. **Set boundaries** - Clearly state what the bot should NOT do
4. **Keep it concise** - Long system prompts can confuse the AI
5. **Test iteratively** - Start simple and refine based on responses
6. **Use the Variety Mandate** - If responses feel repetitive, add rules about varying structure

## Troubleshooting

**Bot not responding:**
- Check that `persona/identity.txt` exists and isn't empty
- Verify `config/triggers.json` has valid JSON
- Check the console for file loading errors

**Personality not changing:**
- Restart the bot after editing files
- Check that files are in the correct directories
- Verify file permissions allow reading

**Template variables not working:**
- Use exactly `{variableName}` (case-sensitive)
- Only use variables listed in the reference above
- Check that variables are supported in that specific file

## Privacy Note

The `prompt_storage/` directory is gitignored to keep your bot's personality private. **Never commit these files to a public repository** if they contain:
- Proprietary content or characters
- Personal information
- Unique creative work you want to protect

Always work from the `prompt_storage.example/` templates and keep your actual `prompt_storage/` directory private.
