import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Template variable substitutions
interface TemplateVariables {
  [key: string]: string;
}

// Cache for loaded prompts
const promptCache: Map<string, string | object> = new Map();

// Default template variables (can be overridden at runtime)
let templateVariables: TemplateVariables = {
  botName: 'Bad Kitty',
  ownerName: 'Prolix',
  ownerId: '944783522059673691',
  ownerUsername: 'prolix_oc',
};

/**
 * Get the root directory for prompt storage
 */
function getPromptStoragePath(): string {
  const rootDir = join(__dirname, '..', '..');
  return join(rootDir, 'prompt_storage');
}

/**
 * Substitute template variables in a string
 * Variables are in the format {variableName}
 */
function substituteVariables(text: string, variables: TemplateVariables = templateVariables): string {
  return text.replace(/\{(\w+)\}/g, (match, varName) => {
    return variables[varName] !== undefined ? variables[varName] : match;
  });
}

/**
 * Load a text file from prompt storage
 */
export function loadTextFile(relativePath: string, useCache: boolean = true): string | null {
  const cacheKey = `text:${relativePath}`;
  
  if (useCache && promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey) as string;
  }
  
  const filePath = join(getPromptStoragePath(), relativePath);
  
  if (!existsSync(filePath)) {
    console.warn(`⚠️ [PROMPTS] File not found: ${filePath}`);
    return null;
  }
  
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (useCache) {
      promptCache.set(cacheKey, content);
    }
    return content;
  } catch (error) {
    console.error(`❌ [PROMPTS] Error loading ${filePath}:`, error);
    return null;
  }
}

/**
 * Load a JSON file from prompt storage
 */
export function loadJsonFile<T = any>(relativePath: string, useCache: boolean = true): T | null {
  const cacheKey = `json:${relativePath}`;
  
  if (useCache && promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey) as unknown as T;
  }
  
  const filePath = join(getPromptStoragePath(), relativePath);
  
  if (!existsSync(filePath)) {
    console.warn(`⚠️ [PROMPTS] File not found: ${filePath}`);
    return null;
  }
  
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as T;
    if (useCache) {
      promptCache.set(cacheKey, parsed as unknown as string | object);
    }
    return parsed;
  } catch (error) {
    console.error(`❌ [PROMPTS] Error loading JSON ${filePath}:`, error);
    return null;
  }
}

/**
 * Get the bot identity/persona definition
 */
export function getBotIdentity(): string {
  const identity = loadTextFile('persona/identity.txt');
  if (identity) {
    return substituteVariables(identity);
  }
  
  // Fallback default
  return 'You are a helpful Discord bot assistant. You provide clear, concise, and accurate responses to user questions.';
}

/**
 * Get boredom ping messages
 */
export function getBoredomMessages(): { messages: string[]; default: string } {
  const config = loadJsonFile<{ messages: string[]; default: string }>('persona/boredom_pings.json');
  
  if (config) {
    // Substitute variables in all messages
    return {
      messages: config.messages.map(msg => substituteVariables(msg)),
      default: substituteVariables(config.default),
    };
  }
  
  // Fallback defaults
  return {
    messages: ['<@{userId}> *stares* ...bored... (=^-^=)'],
    default: '<@{userId}> *stares* ...bored... (=^-^=)',
  };
}

/**
 * Get a random boredom message
 */
export function getRandomBoredomMessage(userId: string): string {
  const { messages, default: defaultMsg } = getBoredomMessages();
  const index = Math.floor(Math.random() * messages.length);
  const message = messages[index] || defaultMsg;
  return message.replace('{userId}', userId);
}

/**
 * Get error message templates
 */
export function getErrorTemplates(): { [key: string]: string } {
  const templates = loadJsonFile<{ [key: string]: string }>('persona/error_templates.json');
  
  if (templates) {
    // Substitute variables in all templates
    const result: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(templates)) {
      result[key] = substituteVariables(value);
    }
    return result;
  }
  
  // Fallback defaults
  return {
    multiple_attempts_failure: 'I tried multiple times but failed to generate a response. Please try again.',
    empty_response: 'I drew a blank there! Could you rephrase that?',
    generic_error: 'Something went wrong. Please try again.',
  };
}

/**
 * Get a specific error message by key
 */
export function getErrorMessage(key: string): string {
  const templates = getErrorTemplates();
  return templates[key] || templates['generic_error'] || 'An error occurred.';
}

/**
 * Get command response templates
 */
export function getCommandResponses(): { [key: string]: string } {
  const templates = loadJsonFile<{ [key: string]: string }>('persona/command_responses.json');
  
  if (templates) {
    const result: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(templates)) {
      result[key] = substituteVariables(value);
    }
    return result;
  }
  
  return {};
}

/**
 * Get a specific command response by key
 */
export function getCommandResponse(key: string): string | null {
  const responses = getCommandResponses();
  return responses[key] || null;
}

/**
 * Get video reaction instructions
 */
export function getVideoReactionInstructions(): string {
  const instructions = loadTextFile('instructions/video_reaction.txt');
  return instructions ? substituteVariables(instructions) : '';
}

/**
 * Get reply context template
 */
export function getReplyContextTemplate(type: 'reply_to_bot' | 'reply_to_other', variables: { [key: string]: string } = {}): string {
  const templates = loadJsonFile<{ reply_to_bot: string; reply_to_other: string }>('instructions/reply_context.json');
  
  let template = '';
  if (templates) {
    template = templates[type] || '';
  }
  
  // First substitute the global template variables, then the specific ones
  let result = substituteVariables(template);
  result = substituteVariables(result, variables);
  
  return result;
}

/**
 * Get boredom update instructions
 */
export function getBoredomUpdateInstructions(action: 'opted-in' | 'opted-out'): string {
  const instructions = loadTextFile('instructions/boredom_updates.txt');
  
  if (!instructions) {
    return '';
  }
  
  // Parse the sections manually since it's a combined file
  const sections = instructions.split('## BOREDOM PING UPDATE - OPTED');
  
  if (action === 'opted-in') {
    const section = sections.find(s => s.includes('IN'));
    if (section) {
      return substituteVariables(section.replace('IN', '').trim());
    }
  } else {
    const section = sections.find(s => s.includes('OUT'));
    if (section) {
      return substituteVariables(section.replace('OUT', '').trim());
    }
  }
  
  return '';
}

/**
 * Get music taste context template
 */
export function getMusicTasteTemplate(variables: {
  totalTracks: string;
  totalPlaylists: string;
  totalArtists: string;
  avgPopularity: string;
  tasteDescription: string;
  topGenres: string;
  sampleTracks: string;
  genreBreakdown: string;
}): string {
  const template = loadTextFile('instructions/music_taste.txt');
  
  if (!template) {
    return '';
  }
  
  // Substitute all variables
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  
  return substituteVariables(result);
}

/**
 * Get memory system template
 */
export function getMemorySystemTemplate(variables: {
  username: string;
  firstInteractionText: string;
}): string {
  const template = loadTextFile('instructions/memory_system.txt');
  
  if (!template) {
    return `## Memory System\n\nYou have the ability to form opinions about users you interact with.\nCurrent user: ${variables.username}\n${variables.firstInteractionText}\n\nAs you chat, you can use the store_user_opinion function to save your thoughts, impressions, or feelings about this user.`;
  }
  
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  
  return substituteVariables(result);
}

/**
 * Get persona reinforcement text (appended to end of system prompt)
 * Returns empty string if file doesn't exist — feature is opt-in via file presence
 */
export function getPersonaReinforcement(): string {
  const reinforcement = loadTextFile('persona/reinforcement.txt');
  return reinforcement ? substituteVariables(reinforcement) : '';
}

/**
 * Get trigger keywords configuration
 */
export function getTriggerKeywords(): {
  botMention: string[];
  searchIntent: string[];
  knowledgeIntent: string[];
} {
  const config = loadJsonFile<{
    triggers: {
      bot_mention: string[];
      search_intent: string[];
      knowledge_intent: string[];
    };
  }>('config/triggers.json');
  
  if (config) {
    return {
      botMention: config.triggers.bot_mention,
      searchIntent: config.triggers.search_intent,
      knowledgeIntent: config.triggers.knowledge_intent,
    };
  }
  
  // Fallback defaults
  return {
    botMention: ['bad kitty', 'lumia'],
    searchIntent: ['search', 'look up', 'find out', 'google'],
    knowledgeIntent: ['loom', 'lucid loom'],
  };
}

/**
 * Get tool descriptions
 */
export function getToolDescriptions(): {
  boredomPreference?: {
    description: string;
    triggerPhrasesOptIn: string[];
    triggerPhrasesOptOut: string[];
    note: string;
  };
  queryKnowledgeBase?: { description: string };
  storeUserOpinion?: { description: string };
} {
  const descriptions = loadJsonFile<{
    boredom_preference: {
      description: string;
      trigger_phrases_opt_in: string[];
      trigger_phrases_opt_out: string[];
      note: string;
    };
    query_knowledge_base: { description: string };
    store_user_opinion: { description: string };
  }>('config/tool_descriptions.json');
  
  if (descriptions) {
    return {
      boredomPreference: {
        description: descriptions.boredom_preference.description,
        triggerPhrasesOptIn: descriptions.boredom_preference.trigger_phrases_opt_in,
        triggerPhrasesOptOut: descriptions.boredom_preference.trigger_phrases_opt_out,
        note: descriptions.boredom_preference.note,
      },
      queryKnowledgeBase: descriptions.query_knowledge_base,
      storeUserOpinion: descriptions.store_user_opinion,
    };
  }
  
  return {};
}

/**
 * Set global template variables
 */
export function setTemplateVariables(variables: Partial<TemplateVariables>): void {
  // Filter out undefined values to maintain type safety
  const validVariables: TemplateVariables = {};
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) {
      validVariables[key] = value;
    }
  }
  templateVariables = { ...templateVariables, ...validVariables };
  // Clear cache to ensure new variables are applied
  clearCache();
}

/**
 * Get current template variables
 */
export function getTemplateVariables(): TemplateVariables {
  const result: TemplateVariables = {};
  for (const [key, value] of Object.entries(templateVariables)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Clear the prompt cache
 */
export function clearCache(): void {
  promptCache.clear();
  console.log('📝 [PROMPTS] Cache cleared');
}

/**
 * Reload all prompts from disk
 */
export function reloadPrompts(): void {
  clearCache();
  console.log('✅ [PROMPTS] All prompts reloaded from disk');
}

/**
 * Initialize the prompt service
 */
export function initializePromptService(): void {
  console.log('📝 [PROMPTS] Initializing prompt service...');
  
  // Pre-load critical prompts
  const identity = getBotIdentity();
  const boredomMessages = getBoredomMessages();
  const errorTemplates = getErrorTemplates();
  const triggers = getTriggerKeywords();
  
  console.log(`✅ [PROMPTS] Loaded identity (${identity.length} chars)`);
  console.log(`✅ [PROMPTS] Loaded ${boredomMessages.messages.length} boredom messages`);
  console.log(`✅ [PROMPTS] Loaded ${Object.keys(errorTemplates).length} error templates`);
  console.log(`✅ [PROMPTS] Loaded ${triggers.botMention.length} bot triggers, ${triggers.searchIntent.length} search patterns`);
  
  console.log('✅ [PROMPTS] Prompt service initialized');
}

// Auto-initialize when imported
initializePromptService();
