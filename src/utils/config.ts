export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    redirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback',
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
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || undefined,
    baseUrl: process.env.GEMINI_BASE_URL || undefined,
    enabled: !!process.env.GEMINI_API_KEY,
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
