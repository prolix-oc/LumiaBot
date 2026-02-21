export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    redirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback',
  },
  bot: {
    name: process.env.BOT_NAME || 'Bad Kitty',
    ownerName: process.env.BOT_OWNER_NAME || 'Prolix',
    ownerId: process.env.BOT_OWNER_ID || '944783522059673691',
    ownerUsername: process.env.BOT_OWNER_USERNAME || 'prolix_oc',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    modelAlias: process.env.OPENAI_MODEL_ALIAS || undefined,
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2000'),
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '1'),
    topP: process.env.OPENAI_TOP_P ? parseFloat(process.env.OPENAI_TOP_P) : 0.95,
    topK: process.env.OPENAI_TOP_K ? parseInt(process.env.OPENAI_TOP_K) : 0,
    filterReasoning: process.env.OPENAI_FILTER_REASONING !== 'false',
    extraBody: (() => {
      try {
        return process.env.OPENAI_EXTRA_BODY ? JSON.parse(process.env.OPENAI_EXTRA_BODY) : undefined;
      } catch (e) {
        console.warn('⚠️ [Config] Failed to parse OPENAI_EXTRA_BODY as JSON, ignoring');
        return undefined;
      }
    })(),
    rawBodyParams: (() => {
      try {
        return process.env.OPENAI_RAW_BODY_PARAMS ? JSON.parse(process.env.OPENAI_RAW_BODY_PARAMS) : undefined;
      } catch (e) {
        console.warn('⚠️ [Config] Failed to parse OPENAI_RAW_BODY_PARAMS as JSON, ignoring');
        return undefined;
      }
    })(),
    videoEnabled: process.env.OPENAI_VIDEO_ENABLED === 'true',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || undefined,
    baseUrl: process.env.GEMINI_BASE_URL || undefined,
    enabled: !!process.env.GEMINI_API_KEY,
  },
  vision: {
    enabled: !!process.env.VISION_SECONDARY_MODEL,
    model: process.env.VISION_SECONDARY_MODEL || '',
    provider: (process.env.VISION_SECONDARY_PROVIDER || 'openai') as 'openai' | 'gemini',
    apiKey: process.env.VISION_SECONDARY_API_KEY || process.env.OPENAI_API_KEY!,
    baseUrl: process.env.VISION_SECONDARY_BASE_URL || process.env.OPENAI_BASE_URL,
    maxTokens: parseInt(process.env.VISION_SECONDARY_MAX_TOKENS || '2000'),
    temperature: parseFloat(process.env.VISION_SECONDARY_TEMPERATURE || '1'),
    promptPrefix: process.env.VISION_SECONDARY_PROMPT_PREFIX || 'Describe what you see in this image in detail:',
  },
  searxng: {
    baseUrl: process.env.SEARXNG_URL || 'https://search.example.com',
    maxResults: parseInt(process.env.SEARXNG_MAX_RESULTS || '5'),
    safeSearch: parseInt(process.env.SEARXNG_SAFE_SEARCH || '1'),
  },
  conversation: {
    maxHistoryLength: parseInt(process.env.CONVERSATION_MAX_HISTORY || '20'),
  },
  channel: {
    maxHistoryLength: parseInt(process.env.CHANNEL_MAX_HISTORY || '20'),
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
  },
  video: {
    // Max video size in MB (default: 50)
    maxSizeMB: parseInt(process.env.VIDEO_MAX_SIZE_MB || '50'),
    // Target vertical resolution (default: 720, options: 480, 720, 1080)
    targetResolution: parseInt(process.env.VIDEO_TARGET_RESOLUTION || '720'),
    // CRF quality setting (default: 23, range: 18-28, lower = better quality)
    crf: parseInt(process.env.VIDEO_CRF || '23'),
  },
  attachments: {
    // Max text file size in KB (default: 25)
    maxTextFileSizeKB: parseInt(process.env.ATTACHMENTS_MAX_TEXT_SIZE_KB || '25'),
  },
  orchestrator: {
    // Optional: Enable orchestrator integration for multi-bot coordination
    enabled: process.env.ORCHESTRATOR_ENABLED === 'true',
    url: process.env.ORCHESTRATOR_URL || 'ws://localhost:3000',
    apiKey: process.env.ORCHESTRATOR_API_KEY || '',
    // Unique bot identifier for the orchestrator
    botId: process.env.ORCHESTRATOR_BOT_ID || process.env.DISCORD_CLIENT_ID || 'lumia-bot',
    botName: process.env.ORCHESTRATOR_BOT_NAME || process.env.BOT_NAME || 'LumiaBot',
    // Reconnection settings
    reconnectIntervalMs: parseInt(process.env.ORCHESTRATOR_RECONNECT_INTERVAL || '5000'),
    maxReconnectAttempts: parseInt(process.env.ORCHESTRATOR_MAX_RECONNECT || '10'),
  },
};

/**
 * Check if the current model is a Gemini 3 model
 * Gemini 3 models support native video understanding
 */
export function isGemini3Model(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  return model.includes('gemini-3') || model.includes('gemini3');
}

export function validateConfig(): void {
  const required = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'OPENAI_API_KEY',
    'SEARXNG_URL',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
