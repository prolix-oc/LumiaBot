import OpenAI from 'openai';
import { config, isGemini3Model, isDeepSeekModel, isMoonshotThinkingModel, isGeminiFlashModel, isGeminiProModel, isMoonshotProvider } from '../utils/config';
import { estimateTokenCount, checkBalance } from './moonshot';
import { searxngService } from './searxng';
import { userMemoryService, PRONOUN_FALLBACK } from './user-memory';
import { conversationHistoryService } from './conversation-history';
import { guildMemoryService } from './guild-memory';
import { boredomService } from './boredom';
import { videoService } from './video';
import { knowledgeGraphService } from './knowledge-graph';
import { musicService, type MusicTrackWithDetails } from './music';
import { userActivityService, type MusicActivity } from './user-activity';
import { lrclibService } from './lrclib';
import type { ResolveUserMention } from './user-mention-resolver';
import { isNsfwImagePrompt, swarmUIService, type GeneratedImageAttachment } from './swarmui';
import {
  buildImageGenerationInstructions,
  buildImageSafetyDescription,
  buildSelfieTagsParamDescription,
  buildSelfieToolDescription,
} from './image-prompt-guidance';
import { getBotDefinition } from '../utils/bot-definition';
import {
  getVideoReactionInstructions,
  getBoredomUpdateInstructions,
  getMusicTasteTemplate,
  getReplyContextTemplate,
  getMemorySystemTemplate,
  getPersonaReinforcement,
  getBotFamilyCooperationPrompt
} from './prompts';

// Moonshot pricing (per million tokens)
const COST_INPUT_PER_M  = 0.90;  // cache miss / regular input
const COST_CACHED_PER_M = 0.10;  // cache hit
const COST_OUTPUT_PER_M = 4.00;  // output

function logUsageCost(usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null | undefined): void {
  if (!usage) return;
  const cached   = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached = (usage.prompt_tokens ?? 0) - cached;
  const output   = usage.completion_tokens ?? 0;
  const cost = (uncached * COST_INPUT_PER_M + cached * COST_CACHED_PER_M + output * COST_OUTPUT_PER_M) / 1_000_000;
  console.log(
    `💰 [AI] Usage — input: ${uncached} (cached: ${cached}) | output: ${output} | est. cost: $${cost.toFixed(6)}`
  );
}

/**
 * Music-related keywords for smart detection
 * Used to automatically include music context when user asks about music
 */
const MUSIC_KEYWORDS = [
  'music', 'song', 'track', 'album', 'artist', 'band', 'playlist',
  'listening to', 'vibing to', 'jamming to', 'what do you like',
  'taste in music', 'favorite song', 'favorite artist', 'favorite band',
  'recommend music', 'recommend song', 'recommend artist',
  'what are you into', 'what music', 'what songs', 'what bands',
  'spotify', 'genre', 'musical', 'tunes', 'bops', 'bangers'
];

/**
 * Check if a message is asking about music
 */
function isMusicQuestion(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return MUSIC_KEYWORDS.some(keyword => lowerMessage.includes(keyword.toLowerCase()));
}

export interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface VideoUrlContent {
  type: 'video_url';
  video_url: {
    url: string;
  };
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type ChatContent = string | (TextContent | ImageContent | VideoUrlContent)[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  enableSearch?: boolean;
  enableKnowledgeGraph?: boolean;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  images?: string[]; // URLs of images to include with the last user message
  videos?: { url: string; mimeType?: string }[]; // URLs of videos to include (Gemini 3 only)
  textAttachments?: { name: string; content: string }[]; // Text file attachments
  pageContents?: { url: string; title: string; content: string; excerpt?: string; siteName?: string; byline?: string }[]; // Extracted web page contents
  collectiveKnowledgeContext?: string;
  userId?: string; // Discord user ID for memory
  username?: string; // Discord username for memory
  guildId?: string; // Discord guild ID for guild-specific context
  replyContext?: { // Context when user is replying to a message
    isReply: boolean;
    isReplyToLumia?: boolean;
    originalContent?: string;
    originalTimestamp?: string;
    originalAuthor?: string;
  };
  boredomAction?: 'opted-in' | 'opted-out'; // If user just changed their boredom settings
  orchestratorContextNote?: string;
  enableMusicTaste?: boolean; // DEPRECATED: Auto-inject music context (default: false). Use get_music_taste tool instead
  conversationSummary?: string; // Per-user past interaction summary for system prompt
  getUserListeningActivity?: (userId: string) => Promise<MusicActivity | null>;
  resolveUserMention?: ResolveUserMention;
  mentionedUsers?: Map<string, string>; // userId -> username mapping for users mentioned in current message
  // Orchestrator follow-up support
  orchestratorEventId?: string;
  orchestratorTurnId?: string;
  requestFollowUp?: (eventId: string, turnId: string, targetBotId?: string, reason?: string) => Promise<{ approved: boolean; reason: string }>;
  requestCollectiveKnowledge?: (query: string, maxResults?: number) => Promise<string>;
  allowNsfwImageGeneration?: boolean;
  onImageGenerated?: (image: GeneratedImageAttachment) => void;
}

export interface ToolExecutionSnapshot {
  timestamp: string;
  model: string;
  provider: 'moonshot' | 'other';
  thinkingEnabled: boolean;
  moonshotThinkingModel: boolean;
  runToolsUsed: boolean;
  toolsOffered: number;
  toolNames: string[];
  toolRounds: number;
  toolCalls: number;
  toolResults: number;
  attempts: number;
  status: 'success' | 'error';
  reason?: string;
  error?: string;
}

let lastToolExecutionSnapshot: ToolExecutionSnapshot | null = null;

export function getLastToolExecutionSnapshot(): ToolExecutionSnapshot | null {
  return lastToolExecutionSnapshot;
}

export class OpenAIService {
  private client: OpenAI;
  private model: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private defaultTopP: number;
  private defaultTopK: number;
  private filterReasoning: boolean;
  private extraBody?: Record<string, unknown>;
  private rawBodyParams?: Record<string, unknown>;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    filterReasoning?: boolean;
    extraBody?: Record<string, unknown>;
    rawBodyParams?: Record<string, unknown>;
  }) {
    const clientConfig: { apiKey: string; baseURL?: string } = {
      apiKey: options?.apiKey ?? config.openai.apiKey,
    };
    
    const baseUrl = options?.baseUrl ?? config.openai.baseUrl;
    if (baseUrl) {
      clientConfig.baseURL = baseUrl;
    }
    
    this.client = new OpenAI(clientConfig);
    this.model = options?.model ?? config.openai.modelAlias ?? config.openai.model;
    this.defaultMaxTokens = options?.maxTokens ?? config.openai.maxTokens;
    this.defaultTemperature = options?.temperature ?? config.openai.temperature;
    this.defaultTopP = options?.topP ?? config.openai.topP;
    this.defaultTopK = options?.topK ?? config.openai.topK;
    this.filterReasoning = options?.filterReasoning ?? config.openai.filterReasoning;
    this.extraBody = options?.extraBody ?? config.openai.extraBody;
    this.rawBodyParams = options?.rawBodyParams ?? config.openai.rawBodyParams;
  }

  /**
   * Apply model-aware thinking configuration to request params.
   * Mutates the given params object in-place.
   */
  private applyThinkingConfig(params: any, isGemini: boolean): void {
    if (!config.thinking.enabled) {
      // Thinking disabled — use minimal/disabled for all models
      if (isGemini) {
        params.thinking_config = { thinking_level: 'MINIMAL' };
      }
      return;
    }

    // Gemini via OpenAI proxy
    if (isGemini) {
      const level = isGeminiProModel() ? 'HIGH' : isGeminiFlashModel() ? 'MEDIUM' : 'MINIMAL';
      params.thinking_config = { thinking_level: level };
      console.log(`🧠 [AI] Gemini thinking enabled at level: ${level}`);
      return;
    }

    // DeepSeek models
    if (isDeepSeekModel()) {
      params.extra_body = { ...params.extra_body, thinking: { type: 'enabled' } };
      console.log(`🧠 [AI] DeepSeek thinking enabled`);
      return;
    }

    // Moonshot / Kimi thinking models — Moonshot fixes temperature at 1.0 when
    // thinking is enabled and 0.6 when it's disabled. Gate on the thinking.type
    // from OPENAI_RAW_BODY_PARAMS so non-thinking mode isn't forced to 1.0.
    if (isMoonshotThinkingModel()) {
      const thinking = this.rawBodyParams?.thinking as { type?: string } | undefined;
      const thinkingDisabled = thinking?.type === 'disabled';
      params.temperature = thinkingDisabled ? 0.6 : 1.0;
      if (!thinkingDisabled) {
        // Thinking models split max_tokens between reasoning_content and the
        // visible answer. Too small a budget truncates/empties the reply, which
        // trips the empty-response retry loop. Moonshot recommends >= 16000; we
        // floor at 32000 to leave generous room for deep multi-tool reasoning.
        const MIN_THINKING_MAX_TOKENS = 32000;
        if ((params.max_tokens ?? 0) < MIN_THINKING_MAX_TOKENS) {
          params.max_tokens = MIN_THINKING_MAX_TOKENS;
        }
      }
      console.log(`🧠 [AI] Moonshot thinking model detected, temperature set to ${params.temperature} (thinking ${thinkingDisabled ? 'disabled' : 'enabled'}), max_tokens=${params.max_tokens}`);
      return;
    }
  }

  /**
   * Filter reasoning content from the response
   * Catches various formats used by different models (DeepSeek, Gemini, etc.)
   */
  private filterReasoningContent(content: string): string {
    if (!this.filterReasoning) {
      return content;
    }

    let filtered = content;
    
    // DeepSeek/R1 style reasoning tags
    filtered = filtered.replace(/<think>[\s\S]*?<\/think>/gi, '');
    filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    filtered = filtered.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
    filtered = filtered.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    filtered = filtered.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
    
    // Bracket-style reasoning blocks
    filtered = filtered.replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, '');
    filtered = filtered.replace(/\[THINKING\][\s\S]*?\[\/THINKING\]/gi, '');
    filtered = filtered.replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, '');
    filtered = filtered.replace(/\[ANALYSIS\][\s\S]*?\[\/ANALYSIS\]/gi, '');
    
    // Triple backtick reasoning blocks
    filtered = filtered.replace(/```reasoning[\s\S]*?```/gi, '');
    filtered = filtered.replace(/```thinking[\s\S]*?```/gi, '');
    filtered = filtered.replace(/```analysis[\s\S]*?```/gi, '');
    
    // Detect and remove reasoning sections followed by actual response
    // Common pattern: reasoning list/bullets, then a clear transition to response
    // Look for patterns like "Response:" or clear content shifts
    const lines = filtered.split('\n');
    let responseStartIndex = -1;
    let inReasoningSection = false;
    let consecutiveBullets = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      
      // Detect explicit response markers
      if (line.match(/^(response:|answer:|here'?s? my (response|answer)|finally,?|in conclusion,)/i)) {
        responseStartIndex = i;
        break;
      }
      
      // Detect bulleted or numbered reasoning lists
      if (line.match(/^[-•*]\s/) || line.match(/^\d+[.)]\s/)) {
        consecutiveBullets++;
        if (consecutiveBullets >= 2) {
          inReasoningSection = true;
        }
      } else if (line === '' && inReasoningSection) {
        // Empty line after reasoning bullets - next non-empty line might be response
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        if (j < lines.length && !lines[j]!.match(/^[-•*\d]/)) {
          // Found non-bullet line after empty line - this is likely the response
          responseStartIndex = j;
          break;
        }
        consecutiveBullets = 0;
      } else if (line !== '' && !line.match(/^[-•*]\s/) && !line.match(/^\d+[.)]\s/)) {
        consecutiveBullets = 0;
        inReasoningSection = false;
      }
    }
    
    // If we detected a clear response start, keep only from that point
    if (responseStartIndex > 0) {
      filtered = lines.slice(responseStartIndex).join('\n');
    }
    
    // Filter out lines that start with reasoning indicators
    filtered = filtered.split('\n')
      .filter(line => !line.match(/^\s*(reasoning:|thinking:|thought process:|analysis:|let me think|okay,? so|step by step|first,? i|i need to|i should|i will|let's see|hmm,?|wait,?)/i))
      .join('\n');
    
    // Remove orphaned closing tags that might leak through
    filtered = filtered.replace(/<\/think>/gi, '');
    filtered = filtered.replace(/<\/thinking>/gi, '');
    filtered = filtered.replace(/<\/reasoning>/gi, '');
    filtered = filtered.replace(/<\/thought>/gi, '');
    filtered = filtered.replace(/<\/analysis>/gi, '');
    
    // Clean up excessive whitespace
    filtered = filtered.replace(/\n{3,}/g, '\n\n');
    filtered = filtered.trim();

    return filtered;
  }

  /**
   * Filter tool code blocks from the response
   * These are internal function calls that should not be shown to the user
   */
  private filterToolCode(content: string): string {
    let filtered = content;

    // Remove <tool_code> blocks (function call format)
    filtered = filtered.replace(/<tool_code>[\s\S]*?<\/tool_code>/gi, '');

    // Remove <tool_call> blocks (Gemini format)
    filtered = filtered.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');

    // Remove orphaned closing tags that might leak through
    filtered = filtered.replace(/<\/tool_call>/gi, '');
    filtered = filtered.replace(/<\/tool_code>/gi, '');

    // Remove standalone tool function calls like store_user_opinion(...)
    filtered = filtered.replace(/\b(store_user_opinion|get_user_opinion|list_users_with_opinions|web_search|search_knowledge_base|get_knowledge_document|get_music_taste|search_music_library|get_user_current_listening|generate_selfie)\s*\([^)]*\)/gi, '');

    // Remove action/action_input format (common in LangChain-style tool calls)
    // Matches: {"action": "...", "action_input": "..."} or variations
    filtered = filtered.replace(/\{\s*"action"\s*:\s*"[^"]+"\s*,\s*"action_input"\s*:[\s\S]*?\}/gi, '');
    filtered = filtered.replace(/\{\s*"action"\s*:\s*'[^']+'\s*,\s*"action_input"\s*:[\s\S]*?\}/gi, '');
    filtered = filtered.replace(/"action"\s*:\s*"[^"]+"\s*,?/gi, '');
    filtered = filtered.replace(/"action_input"\s*:\s*"[^"]*"\s*,?/gi, '');

    // Remove standalone JSON objects that look like tool arguments/results
    // Match JSON blocks that start with { and contain tool-related keys
    // This handles multiline JSON and is more aggressive
    filtered = filtered.replace(/\{[\s\S]*?"(?:opinion|query|sentiment|username|content)"[\s\S]*?\}/gi, '');

    // Remove any remaining XML-like tags that might be tool-related
    filtered = filtered.replace(/<tool[^>]*>[\s\S]*?<\/tool[^>]*>/gi, '');
    filtered = filtered.replace(/<function[^>]*>[\s\S]*?<\/function[^>]*>/gi, '');

    // Clean up excessive whitespace
    filtered = filtered.replace(/\n{3,}/g, '\n\n');
    filtered = filtered.trim();

    return filtered;
  }

  /**
   * Check if response is effectively empty
   */
  private isEmptyResponse(content: string): boolean {
    if (!content || content.trim().length === 0) return true;
    if (content.trim() === 'No response generated.') return true;
    // Check if it's just whitespace or punctuation
    if (content.trim().replace(/[\s\p{P}]/gu, '').length === 0) return true;
    return false;
  }

  /**
   * Detect hallucinated API response objects that the model outputs as text.
   * Some models (especially via proxy/router) occasionally emit raw API response
   * structures instead of actual conversational content.
   */
  private isHallucinatedResponse(content: string): boolean {
    const trimmed = content.trim();

    // Detect provider/router wrappers like "(Empty response: { ... })"
    if (/^\(Empty response\b[\s\S]*\)$/i.test(trimmed)) {
      return true;
    }

    // Detect raw response objects that include an empty content array
    if (/['"]?content['"]?\s*:\s*\[\s*\]/.test(trimmed) && /[{}()\[\]]/.test(trimmed)) {
      return true;
    }

    // Detect raw API response objects containing typical completion fields
    // Must match at least 2 of these API-specific keys to avoid false positives
    const apiResponseIndicators = [
      /['"]?stop_reason['"]?\s*:/,
      /['"]?input_tokens['"]?\s*:/,
      /['"]?output_tokens['"]?\s*:/,
      /['"]?finish_reason['"]?\s*:/,
      /['"]?type['"]?\s*:\s*['"]thinking['"]/,
      /['"]?signature['"]?\s*:\s*['"]/,
    ];
    const matchCount = apiResponseIndicators.filter(re => re.test(trimmed)).length;
    if (matchCount >= 2) {
      return true;
    }

    return false;
  }

  /**
   * Generate completion with retry logic for empty responses
   */
  private async generateWithRetry(
    messages: OpenAI.ChatCompletionMessageParam[],
    temperature: number,
    maxTokens: number,
    maxRetries: number = 3
  ): Promise<string> {
    let lastError: Error | null = null;
    const isGemini = isGemini3Model();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 [AI] Generation attempt ${attempt}/${maxRetries}`);

        // Build request parameters
        const requestParams: any = {
          model: this.model,
          messages: messages,
          temperature: temperature,
          top_p: this.defaultTopP,
          max_tokens: maxTokens,
        };

        // Request usage data for cost estimation
        requestParams.stream_options = { include_usage: true };

        // Add top_k if set (only supported by some OpenAI-compatible APIs)
        if (this.defaultTopK > 0) {
          requestParams.top_k = this.defaultTopK;
        }

        // Apply model-aware thinking configuration
        this.applyThinkingConfig(requestParams, isGemini);

        // Add extra_body if configured (for custom provider parameters)
        if (this.extraBody) {
          requestParams.extra_body = { ...requestParams.extra_body, ...this.extraBody };
        }

        // Add raw body params directly to request (not wrapped in extra_body)
        if (this.rawBodyParams) {
          Object.assign(requestParams, this.rawBodyParams);
        }

        const completion = await this.client.chat.completions.create(requestParams);
        logUsageCost((completion as any).usage);

        let content = completion.choices[0]?.message?.content || '';
        content = this.filterReasoningContent(content);
        content = this.filterToolCode(content);

        // Check if response is empty or a hallucinated API response
        if (this.isEmptyResponse(content) || this.isHallucinatedResponse(content)) {
          const reason = this.isEmptyResponse(content) ? 'empty' : 'hallucinated API response';
          console.warn(`⚠️ [AI] Bad response (${reason}) on attempt ${attempt}, retrying...`);
          lastError = new Error('Empty response from LLM');

          // Slightly increase temperature for retry to encourage variety
          temperature = Math.min(temperature + 0.1, 1.0);

          // Exponential backoff: 1.5s, 3s, 6s
          const backoffMs = 1500 * Math.pow(2, attempt - 1);
          console.log(`⏱️ [AI] Backing off for ${backoffMs}ms before retry...`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
          continue;
        }

        console.log(`✅ [AI] Successfully generated response on attempt ${attempt}`);
        return content;

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ [AI] Error on attempt ${attempt}: ${errorMsg}`);
        lastError = error as Error;
        
        // Exponential backoff: 1.5s, 3s, 6s
        const backoffMs = 1500 * Math.pow(2, attempt - 1);
        console.log(`⏱️ [AI] Backing off for ${backoffMs}ms before retry...`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // All retries exhausted
    console.error(`🚫 [AI] All ${maxRetries} attempts failed`);
    throw lastError || new Error('Failed to generate response after multiple attempts');
  }

  /**
   * Download an image from a URL and return it as a base64 data URI.
   * Discord CDN URLs contain auth tokens that external APIs cannot access,
   * so we fetch the image ourselves and inline the data.
   */
  private async convertImageUrlToBase64(url: string): Promise<string> {
    // Already a data URI — pass through
    if (url.startsWith('data:')) return url;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  }

  /**
   * Convert an array of image URLs to base64 data URIs.
   * Logs progress and skips images that fail to download.
   */
  private async processImageUrls(imageUrls: string[]): Promise<string[]> {
    console.log(`🖼️  [IMAGE] Converting ${imageUrls.length} image URL(s) to base64...`);
    const results: string[] = [];
    for (const url of imageUrls) {
      try {
        const dataUri = await this.convertImageUrlToBase64(url);
        results.push(dataUri);
      } catch (error) {
        console.error(`❌ [IMAGE] Failed to convert image to base64: ${error}`);
      }
    }
    console.log(`🖼️  [IMAGE] Successfully converted ${results.length}/${imageUrls.length} image(s)`);
    return results;
  }

  private buildMultimodalContent(content: ChatContent, images?: string[]): OpenAI.ChatCompletionContentPart[] {
    const parts: OpenAI.ChatCompletionContentPart[] = [];
    
    // Add text content
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      parts.push(...content as OpenAI.ChatCompletionContentPart[]);
    }
    
    // Add images
    if (images && images.length > 0) {
      for (const imageUrl of images) {
        parts.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }
    }
    
    return parts;
  }

  /**
   * Build multimodal content with video support
   * For Gemini models: uses image_url type for inline base64 video (proxy format)
   * For other providers (Moonshot, etc.): uses video_url type (standard format)
   */
  private buildVideoMultimodalContent(
    content: ChatContent,
    images?: string[],
    videos?: { uri: string; mimeType: string; inlineData: boolean }[],
    isGemini: boolean = false
  ): OpenAI.ChatCompletionContentPart[] {
    const parts: OpenAI.ChatCompletionContentPart[] = [];

    // Add text content
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      parts.push(...content as OpenAI.ChatCompletionContentPart[]);
    }

    // Add images (standard format works for all providers)
    if (images && images.length > 0) {
      for (const imageUrl of images) {
        parts.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }
    }

    // Add videos using inline base64 data
    if (videos && videos.length > 0) {
      for (const video of videos) {
        if (video.inlineData) {
          if (isGemini) {
            // Gemini proxy: uses image_url type for all media including video
            parts.push({
              type: 'image_url',
              image_url: { url: video.uri },
            });
          } else {
            // Moonshot, OpenRouter, etc.: uses video_url type for video content
            parts.push({
              type: 'video_url',
              video_url: { url: video.uri },
            } as any);
          }
        }
      }
    }

    return parts;
  }

  private buildSystemPrompt(
    userId?: string,
    username?: string,
    guildId?: string,
    hasVideos?: boolean,
    replyContext?: { isReply: boolean; isReplyToLumia?: boolean; originalContent?: string; originalTimestamp?: string; originalAuthor?: string },
    knowledgeContext?: string,
    collectiveKnowledgeContext?: string,
    boredomAction?: 'opted-in' | 'opted-out',
    orchestratorContextNote?: string,
    enableMusicTaste?: boolean,
    lastMessageContent?: string,
    conversationSummary?: string,
    textAttachments?: { name: string; content: string }[],
    mentionedUsers?: Map<string, string>,
    pageContents?: { url: string; title: string; content: string; excerpt?: string; siteName?: string; byline?: string }[],
    imageToolEnabled?: boolean,
    allowNsfwImageGeneration?: boolean
  ): string {
    const botDefinition = getBotDefinition();

    // ── STABLE (never / rarely changes — best cache hit rate) ──────────────

    let systemPrompt = `<identity>
${botDefinition}
</identity>`;

    // Persona reinforcement — static anchor, keep near top for cache stability
    const reinforcement = getPersonaReinforcement();
    if (reinforcement) {
      systemPrompt += '\n\n' + reinforcement;
    }

    const botFamilyCooperation = getBotFamilyCooperationPrompt();
    if (botFamilyCooperation) {
      systemPrompt += '\n\n' + botFamilyCooperation;
    }

    // Static channel context note
    systemPrompt += `\n\n<message-context-note>\nThe conversation messages that follow are the live channel discussion. Multiple participants may be active — pay attention to who is speaking, who is being addressed, and what is happening around the current exchange. The last turn is the immediate conversation event for this response; in orchestrator mode it may be from another bot rather than from a human. Respond naturally to the useful live context without describing prompt mechanics or message availability. If a <current-user> block is present, that identifies the active human speaker for this exchange, but you may also acknowledge relevant activity from other participants. If you see transcript blocks like <orchestrator-bot-message> or <orchestrator-user-message>, treat them as quoted messages from distinct participants. Bot-tagged transcript blocks are not your persona unless they appear as assistant-role turns.\n</message-context-note>`;

    // Video instructions — static text, just conditionally included
    if (hasVideos) {
      const videoInstructions = getVideoReactionInstructions();
      if (videoInstructions) {
        systemPrompt += `\n\n<video-instructions>\n${videoInstructions}\n</video-instructions>`;
      }
    }

    // ── SLOW-CHANGING (guild/user-scoped, infrequent updates) ──────────────

    // Guild inside jokes — changes rarely, scoped per guild
    if (guildId) {
      const insideJokesContext = guildMemoryService.getInsideJokesContext(guildId);
      if (insideJokesContext) {
        systemPrompt += `\n\n${insideJokesContext}`;
      }
    }

    // Music context — changes rarely
    if (enableMusicTaste === true && lastMessageContent && isMusicQuestion(lastMessageContent)) {
      console.log(`🎵 [MUSIC] Music context injection explicitly enabled for music query`);
      const musicContext = this.buildMusicContext();
      if (musicContext) {
        systemPrompt += `\n\n<music-context>\n${musicContext}\n</music-context>`;
      }
    }

    // Per-user past interaction summary — changes slowly
    if (conversationSummary) {
      systemPrompt += '\n\n' + conversationSummary;
    }

    // Per-user stored memory/opinions — changes slowly
    if (userId) {
      // Sync stored username with current Discord username to prevent stale names in context
      if (username) {
        userMemoryService.syncUsername(userId, username);
      }
      const memoryContext = userMemoryService.getOpinionContext(userId);

      if (memoryContext) {
        systemPrompt += `\n\n${memoryContext}`;
      } else {
        // First interaction with this user
        const memoryTemplate = getMemorySystemTemplate({
          username: username || 'Unknown',
          firstInteractionText: 'This is your first interaction with them.'
        });
        systemPrompt += '\n\n' + memoryTemplate;
      }
    }

    // Knowledge graph result — per-query, but deterministic for a given query
    if (knowledgeContext) {
      systemPrompt += `\n\n${knowledgeContext}`;
    }

    if (collectiveKnowledgeContext) {
      systemPrompt += `\n\n${collectiveKnowledgeContext}`;
    }

    // ── VOLATILE (per-message — cache will miss here regardless) ───────────

    // Current user identification
    if (username) {
      const pronouns = userId ? userMemoryService.getPronouns(userId) : null;
      const pronounsAttr = pronouns ? ` pronouns="${pronouns}"` : '';
      systemPrompt += `\n\n<current-user name="${username}"${userId ? ` id="${userId}"` : ''}${pronounsAttr}>
The current human participant for this exchange. Usually address them directly, while also acknowledging relevant activity in the surrounding chat when it matters.
If they mention @OtherUser, they are talking TO that user, not AS them.`;

      if (mentionedUsers && mentionedUsers.size > 0) {
        systemPrompt += `\n\n<mentioned-users>`;
        mentionedUsers.forEach((name, id) => {
          if (id !== userId) {
            systemPrompt += `\n- ${name} (ID: ${id})`;
          }
        });
        systemPrompt += `\n</mentioned-users>`;
      }

      systemPrompt += '\n</current-user>\n';
    }

    // Reply-specific context
    if (replyContext?.isReply && replyContext.originalContent) {
      systemPrompt += this.buildReplyContextPrompt(replyContext);
    }

    if (imageToolEnabled) {
      systemPrompt += buildImageGenerationInstructions(allowNsfwImageGeneration === true);
    }

    if (orchestratorContextNote) {
      systemPrompt += `\n\n<orchestrator-session>\n${orchestratorContextNote}\n</orchestrator-session>`;
    }

    // Text file attachments
    if (textAttachments && textAttachments.length > 0) {
      systemPrompt += `\n\n<attached-files>`;
      for (const attachment of textAttachments) {
        systemPrompt += `\n<file name="${attachment.name}">\n${attachment.content}\n</file>`;
      }
      systemPrompt += `\n</attached-files>`;
    }

    // Extracted web page contents
    if (pageContents && pageContents.length > 0) {
      systemPrompt += `\n\n<web-pages>`;
      for (const page of pageContents) {
        systemPrompt += `\n<page title="${page.title}" url="${page.url}">\n${page.content}\n</page>`;
      }
      systemPrompt += `\n</web-pages>`;
    }

    // Boredom opt-in/out acknowledgement
    if (boredomAction) {
      const boredomInstructions = getBoredomUpdateInstructions(boredomAction);
      if (boredomInstructions) {
        systemPrompt += `\n\n<boredom-update>\n${boredomInstructions}\n</boredom-update>`;
      }
    }

    return systemPrompt;
  }

  /**
   * Build music taste context for the system prompt
   * Returns formatted music context or empty string if no music in database
   */
  private buildMusicContext(): string {
    const stats = musicService.getStats();

    if (stats.totalTracks === 0) {
      return '';
    }

    // Get a sample of tracks for variety
    const sampleTracks = musicService.getRandomTracks(15);
    
    // Get genre breakdown from sample
    const genreCounts = new Map<string, number>();
    sampleTracks.forEach(track => {
      track.genres.forEach(genre => {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      });
    });

    const topGenres = Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Get unique artists from sample
    const artistNames = [...new Set(sampleTracks.flatMap(t => t.artists.map(a => a.name)))];
    
    // Calculate average popularity
    const avgPopularity = Math.round(
      sampleTracks.reduce((sum, t) => sum + t.popularity, 0) / sampleTracks.length
    );

    // Build taste description
    let tasteDesc = '';
    if (avgPopularity < 30) {
      tasteDesc = "You're into obscure, underground music that most people haven't discovered yet.";
    } else if (avgPopularity < 60) {
      tasteDesc = "You have eclectic taste - a mix of popular hits and hidden gems.";
    } else {
      tasteDesc = "You unapologetically love mainstream music and popular hits.";
    }

    // Build track list
    const sampleTrackList = sampleTracks.slice(0, 10).map(t => `• "${t.name}" by ${t.artists.map(a => a.name).join(', ')} (${t.album.name})`).join('\n');

    // Build genre breakdown
    const genreBreakdown = topGenres.length > 0 ? topGenres.map((g, i) => `${i + 1}. ${g[0]} (${g[1]} tracks in your collection)`).join('\n') : 'A mix of everything!';

    // Use dynamic template from prompt storage
    return getMusicTasteTemplate({
      totalTracks: String(stats.totalTracks),
      totalPlaylists: String(stats.totalPlaylists),
      totalArtists: String(stats.totalArtists),
      avgPopularity: String(avgPopularity),
      tasteDescription: tasteDesc,
      topGenres: topGenres.length > 0 ? topGenres.map(g => g[0]).join(', ') : 'Mixed',
      sampleTracks: sampleTrackList,
      genreBreakdown: genreBreakdown
    });
  }

  /**
   * Build the reply context prompt with strong emphasis
   * Placed at the end so it has the most impact after the conversation history
   */
  private buildReplyContextPrompt(replyContext: { isReply: boolean; isReplyToLumia?: boolean; originalContent?: string; originalTimestamp?: string; originalAuthor?: string }): string {
    const isReplyToLumia = replyContext.isReplyToLumia === true; // Explicit check — undefined defaults to false (reply to other)
    const authorName = replyContext.originalAuthor || 'Unknown';

    const timestampText = replyContext.originalTimestamp ? `\n[Sent ${replyContext.originalTimestamp}]` : '';

    if (isReplyToLumia) {
      // User is replying to bot's message
      return getReplyContextTemplate('reply_to_bot', {
        originalContent: replyContext.originalContent || '',
        timestamp: timestampText
      });
    } else {
      // User is replying to someone else but mentioned the bot
      return getReplyContextTemplate('reply_to_other', {
        authorName: authorName,
        originalContent: replyContext.originalContent || '',
        timestamp: timestampText
      });
    }
  }

  async createChatCompletion(options: ChatCompletionOptions): Promise<string> {
    const { messages, enableSearch, enableKnowledgeGraph, temperature, maxTokens, images, videos, textAttachments, pageContents, collectiveKnowledgeContext, userId, username, guildId, replyContext, boredomAction, orchestratorContextNote, enableMusicTaste = false, conversationSummary, mentionedUsers } = options;

    // Check if this is a multimodal request
    const isMultimodal = (images && images.length > 0) || (videos && videos.length > 0);
    const hasImages = images && images.length > 0;
    const hasVideos = videos && videos.length > 0;
    const isGemini = isGemini3Model();

    if (isMultimodal) {
      const parts: string[] = [];
      if (hasImages) parts.push(`${images!.length} image(s)`);
      if (hasVideos) parts.push(`${videos!.length} video(s)`);
      console.log(`\n🖼️  [MULTIMODAL] Request started with ${parts.join(' + ')}`);

      if (hasVideos && !isGemini && !config.openai.videoEnabled) {
        console.warn(`⚠️  [MULTIMODAL] Videos detected but not using Gemini 3 model and OPENAI_VIDEO_ENABLED is not set - videos will be ignored`);
      }
    }

    // Get last message content for music detection
    const lastMessageContent = messages[messages.length - 1]?.content?.toString() || '';
    const imageToolEnabled = swarmUIService.isConfigured();
    const hasLocalKnowledge = enableKnowledgeGraph !== false && knowledgeGraphService.hasDocuments();

    const knowledgeInstruction = hasLocalKnowledge
      ? `<knowledge-base-instruction>\nYou have an internal knowledge base containing Lumiverse documentation (user guides, developer docs, API reference). When the user asks about Lumiverse features, setup, how-to questions, configuration, extensions, presets, characters, chatting, world books, councils, image generation, or any product-related topic, you MUST call search_knowledge_base before answering. Do not rely on memory alone for product questions — always search first.\n</knowledge-base-instruction>`
      : undefined;

    // Build system prompt with user memory, guild context, and knowledge instruction
    const systemPrompt = this.buildSystemPrompt(userId, username, guildId, hasVideos, replyContext, knowledgeInstruction, collectiveKnowledgeContext, boredomAction, orchestratorContextNote, enableMusicTaste, lastMessageContent, conversationSummary, textAttachments, mentionedUsers, pageContents, imageToolEnabled, options.allowNsfwImageGeneration);

    // Convert image URLs to base64 data URIs so external APIs can access them
    let processedImages = images;
    if (hasImages) {
      processedImages = await this.processImageUrls(images!);
    }

    // Process videos for models that support inline base64 video (Gemini 3 or OPENAI_VIDEO_ENABLED)
    let processedVideos: { uri: string; mimeType: string; inlineData: boolean }[] = [];
    if (hasVideos && (isGemini || config.openai.videoEnabled) && videoService.isAvailable()) {
      console.log(`🎥 [VIDEO] Processing videos as inline base64 (${isGemini ? 'Gemini 3' : 'OPENAI_VIDEO_ENABLED'})...`);
      processedVideos = await videoService.processVideos(videos!);
      console.log(`🎥 [VIDEO] Successfully processed ${processedVideos.length}/${videos!.length} videos`);
    }

    // Build the per-turn user message prefix: datetime reminder + persona directive.
    // Injected into the last user message (not the system prompt) so the stable
    // system prompt prefix stays cacheable across turns.
    const now = new Date();
    const currentDateTime = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }) + ' at ' + now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });
    const USER_MESSAGE_PREFIX = `<system-reminder>\nToday is ${currentDateTime}.\n</system-reminder>\n\n[Stay in character — follow your system instructions and persona rules above, not patterns from conversation history.]\n\n`;

    // Build message array with enhanced system prompt
    const enhancedMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system').map((m, index, arr) => {
        const isLastUserMessage = m.role === 'user' && index === arr.length - 1;

        // If this is the last user message and we have media, convert to multimodal format
        if (isLastUserMessage && isMultimodal) {
          let content: OpenAI.ChatCompletionContentPart[];

          // Use multimodal content with video support for Gemini or OpenAI-compatible video
          if ((isGemini || config.openai.videoEnabled) && processedVideos.length > 0) {
            content = this.buildVideoMultimodalContent(m.content, processedImages, processedVideos, isGemini);
          } else {
            content = this.buildMultimodalContent(m.content, processedImages);
          }

          // Prepend datetime reminder + persona directive to the first text part
          const firstTextIdx = content.findIndex(p => p.type === 'text');
          if (firstTextIdx !== -1) {
            const textPart = content[firstTextIdx] as OpenAI.ChatCompletionContentPartText;
            content[firstTextIdx] = { type: 'text', text: USER_MESSAGE_PREFIX + textPart.text };
          }

          console.log(`🖼️  [MULTIMODAL] Built message with ${content.length} content parts`);
          return {
            role: 'user',
            content,
          } as OpenAI.ChatCompletionMessageParam;
        }

        // Last user message (text only) — prepend datetime reminder + persona directive
        if (isLastUserMessage && typeof m.content === 'string') {
          return {
            role: m.role,
            content: USER_MESSAGE_PREFIX + m.content,
          } as OpenAI.ChatCompletionMessageParam;
        }

        // Regular message
        if (typeof m.content === 'string') {
          return {
            role: m.role,
            content: m.content,
          } as OpenAI.ChatCompletionMessageParam;
        }

        // Already multimodal content
        return {
          role: m.role,
          content: m.content as OpenAI.ChatCompletionContentPart[],
        } as OpenAI.ChatCompletionMessageParam;
      }),
    ];

    // Clean up uploaded videos after use (in finally block later)

    const provider: 'moonshot' | 'other' = isMoonshotProvider() ? 'moonshot' : 'other';
    const moonshotThinkingModel = isMoonshotThinkingModel();
    const knowledgeToolEnabled = enableKnowledgeGraph !== false && knowledgeGraphService.hasDocuments();

    // Determine if we need tools at all
    // Search is attached by default unless explicitly disabled.
    // Knowledge is attached when documents exist unless explicitly disabled.
    const hasUserContext = !!(userId && username);
    const needsTools = enableSearch !== false || knowledgeToolEnabled || hasUserContext || musicService.hasTracks() || imageToolEnabled || !!options.getUserListeningActivity || !!options.resolveUserMention || !!options.orchestratorEventId || !!options.requestCollectiveKnowledge;

    if (!needsTools) {
      console.log(`\n🌐 [AI] No tools needed (no user context or search) - normal completion`);

      lastToolExecutionSnapshot = {
        timestamp: new Date().toISOString(),
        model: this.model,
        provider,
        thinkingEnabled: config.thinking.enabled,
        moonshotThinkingModel,
        runToolsUsed: false,
        toolsOffered: 0,
        toolNames: [],
        toolRounds: 0,
        toolCalls: 0,
        toolResults: 0,
        attempts: 0,
        status: 'success',
        reason: 'No tools were needed for this request',
      };

      // Moonshot: estimate tokens before request
      if (isMoonshotProvider()) {
        await estimateTokenCount(this.model, enhancedMessages as any).catch(() => {});
      }

      try {
        const content = await this.generateWithRetry(
          enhancedMessages,
          temperature ?? this.defaultTemperature,
          maxTokens ?? this.defaultMaxTokens
        );

        // Moonshot: check balance after response (fire-and-forget)
        if (isMoonshotProvider()) {
          checkBalance().catch(() => {});
        }

        return content;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ [AI] Generation failed: ${errorMessage}`);
        throw new Error('Failed to generate response - please try again');
      }
    }

    // Tools needed - use runTools helper for automatic function calling
    console.log(`\n🔧 [AI] Tools enabled - using runTools helper (search: ${enableSearch !== false}, knowledge: ${enableKnowledgeGraph !== false}, user context: ${hasUserContext})`);
    
    try {
      console.log(`🌐 [AI] Step 1: AI will decide which tools to use...`);
      
      // Define the web search function
      const webSearchFunction = async (args: { query: string }) => {
        console.log(`🌐 [TOOL CALL] web_search: query="${args.query}"`);
        try {
          const results = await searxngService.search(args.query);
          const formatted = searxngService.formatResultsForLLM(results);
          console.log(`🌐 [AI] Search completed - ${results.results?.length || 0} results`);
          return formatted;
        } catch (error) {
          console.error('🌐 [AI] Search failed:', error);
          return 'Error: Failed to search the web. Please try again or answer based on existing knowledge.';
        }
      };

      // Define user memory functions
      const storeUserOpinionFunction = async (args: { 
        opinion: string; 
        sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
      }) => {
        if (!userId || !username) {
          console.log(`💭 [AI MEMORY] Cannot store opinion - missing user info`);
          return 'Error: Cannot store opinion - user information not available.';
        }
        
        console.log(`💭 [TOOL CALL] store_user_opinion: user="${username}", sentiment="${args.sentiment}"`);

        try {
          userMemoryService.storeOpinion(userId, username, args.opinion, args.sentiment);
          return `Successfully stored your opinion about ${username}. You can reference this in future conversations.`;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to store opinion:', error);
          return 'Error: Failed to store opinion.';
        }
      };

      const getUserOpinionFunction = async (args: { username: string }) => {
        console.log(`💭 [TOOL CALL] get_user_opinion: username="${args.username}"`);

        try {
          const opinion = userMemoryService.getOpinionByUsername(args.username);
          if (opinion) {
            const pronounsLine = opinion.pronouns || PRONOUN_FALLBACK;
            return `Opinion about ${args.username}:\nPronouns: ${pronounsLine}\nSentiment: ${opinion.sentiment}\nLast updated: ${opinion.updatedAt}\nOpinion: ${opinion.opinion}`;
          } else {
            return `You don't have any stored opinions about ${args.username} yet.`;
          }
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to retrieve opinion:', error);
          return 'Error: Failed to retrieve opinion.';
        }
      };

      const listUsersFunction = async () => {
        console.log(`💭 [TOOL CALL] list_users_with_opinions`);
        
        try {
          const users = userMemoryService.listUsers();
          if (users.length === 0) {
            return "You haven't formed any opinions about users yet.";
          }
          
          const userList = users.map(u => `- ${u.username} (${u.sentiment}, last updated: ${u.updatedAt})`).join('\n');
          return `Users you have opinions about:\n${userList}`;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to list users:', error);
          return 'Error: Failed to list users.';
        }
      };

      const searchKnowledgeBaseFunction = async (args: { query: string; maxResults?: number }) => {
        console.log(`📚 [TOOL CALL] search_knowledge_base: query="${args.query}"`);
        try {
          return knowledgeGraphService.searchForTool(args.query, args.maxResults || 5);
        } catch (error) {
          console.error('📚 [AI KNOWLEDGE] Search failed:', error);
          return 'Error: Failed to search the knowledge base.';
        }
      };

      const getKnowledgeDocumentFunction = async (args: { docId: number }) => {
        console.log(`📚 [TOOL CALL] get_knowledge_document: docId=${args.docId}`);
        try {
          return knowledgeGraphService.getDocumentToolPayload(args.docId);
        } catch (error) {
          console.error('📚 [AI KNOWLEDGE] Failed to fetch knowledge document:', error);
          return 'Error: Failed to fetch the requested knowledge document.';
        }
      };

      // Define music taste function
      const getMusicTasteFunction = async () => {
        console.log(`🎵 [TOOL CALL] get_music_taste`);
        
        try {
          const stats = musicService.getStats();
          
          if (stats.totalTracks === 0) {
            return "You don't have any music in your collection yet. Use the /music import command to add Spotify playlists!";
          }

          const sampleTracks = musicService.getRandomTracks(10);
          const genreCounts = new Map<string, number>();
          sampleTracks.forEach(track => {
            track.genres.forEach(genre => {
              genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
            });
          });

          const topGenres = Array.from(genreCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

          const artistNames = [...new Set(sampleTracks.flatMap(t => t.artists.map(a => a.name)))];
          const avgPopularity = Math.round(
            sampleTracks.reduce((sum, t) => sum + t.popularity, 0) / sampleTracks.length
          );

          let tasteDesc = '';
          if (avgPopularity < 30) {
            tasteDesc = "into obscure, underground music";
          } else if (avgPopularity < 60) {
            tasteDesc = "into a mix of popular and underground";
          } else {
            tasteDesc = "into mainstream hits";
          }

          let result = `Your Music Collection:\n`;
          result += `• ${stats.totalTracks} tracks across ${stats.totalPlaylists} playlist(s)\n`;
          result += `• ${stats.totalArtists} unique artists\n`;
          result += `• Average popularity: ${avgPopularity}/100 (${tasteDesc})\n`;
          result += `• Top genres: ${topGenres.map(g => g[0]).join(', ')}\n\n`;
          result += `Some tracks you know:\n`;
          sampleTracks.slice(0, 5).forEach(t => {
            result += `• "${t.name}" by ${t.artists.map(a => a.name).join(', ')}\n`;
          });

          return result;
        } catch (error) {
          console.error('🎵 [AI MUSIC] Failed to get music taste:', error);
          return 'Error: Failed to retrieve music taste.';
        }
      };

      const searchMusicLibraryFunction = async (args: { query: string; maxResults?: number }) => {
        console.log(`🎵 [TOOL CALL] search_music_library: query="${args.query}"`);

        try {
          const results = musicService.searchLibrary(args.query, args.maxResults || 5);
          if (results.length === 0) {
            return `No tracks or artists found in your Spotify library for "${args.query}".`;
          }

          let response = `Matches in your Spotify library for "${args.query}":\n`;
          results.forEach((track, index) => {
            const genres = track.genres.slice(0, 3).join(', ');
            response += `\n${index + 1}. "${track.name}" by ${track.artists.map(a => a.name).join(', ')}`;
            response += `\n   Album: ${track.album.name}`;
            if (genres) {
              response += `\n   Genres: ${genres}`;
            }
            response += `\n   Spotify: ${track.spotifyUrl}`;
          });

          return response;
        } catch (error) {
          console.error('🎵 [AI MUSIC] Failed to search music library:', error);
          return 'Error: Failed to search the music library.';
        }
      };

      const generateSelfieFunction = async (args: { tags: string }) => {
        const tags = String(args.tags || '').trim();
        if (!tags) {
          return 'Error: Selfie generation requires descriptive visual tags.';
        }

        if (isNsfwImagePrompt(tags) && !options.allowNsfwImageGeneration) {
          return 'Error: NSFW image generation is not permitted in this context.';
        }

        console.log(`🖼️ [TOOL CALL] generate_selfie: tags="${tags.slice(0, 100)}${tags.length > 100 ? '...' : ''}"`);

        try {
          const image = await swarmUIService.generateSelfie(tags);
          options.onImageGenerated?.(image);
          console.log(`🖼️ [TOOL CALL] generate_selfie: completed (${image.name}, ${image.data.length} bytes)`);
          return 'Selfie generated successfully and attached to the Discord reply. Respond in character with a lively, playful one-liner or short flourish that fits your persona and the user\'s request. Do not paste the full image prompt unless asked.';
        } catch (error) {
          console.error('🖼️  [AI IMAGE] SwarmUI selfie generation failed:', error);
          const message = error instanceof Error ? error.message : String(error);
          return `Error: Failed to generate selfie with SwarmUI. ${message}`;
        }
      };

      // Define user current listening function
      const getUserCurrentListeningFunction = async (args: { targetUserId?: string }) => {
        if (!options.getUserListeningActivity) {
          return 'Error: Unable to check listening activity - service not available.';
        }
        
        try {
          const targetUserId = args.targetUserId || options.userId;
          if (!targetUserId) {
            return 'Error: No user specified to check listening activity.';
          }
          
          console.log(`🎧 [TOOL CALL] get_user_current_listening: userId="${targetUserId}"`);
          const activity = await options.getUserListeningActivity(targetUserId);
          
          if (!activity) {
            return 'They are not currently listening to anything on Spotify or any other music platform.';
          }
          
          if (activity.source === 'spotify' && activity.trackName && activity.artistName) {
            let result = `🎵 **Currently Playing on Spotify:**\n`;
            result += `"${activity.trackName}" by ${activity.artistName}`;
            if (activity.albumName) {
              result += `\n💿 Album: ${activity.albumName}`;
            }
            let durationSec: number | undefined;
            if (activity.timestamps?.start && activity.timestamps?.end) {
              const duration = activity.timestamps.end - activity.timestamps.start;
              durationSec = duration / 1000;
              const minutes = Math.floor(duration / 60000);
              const seconds = Math.floor((duration % 60000) / 1000);
              result += `\n⏱️ Duration: ${minutes}:${seconds.toString().padStart(2, '0')}`;
            }

            // Fold in lyrics from LRCLib when available
            try {
              const lyrics = await lrclibService.getLyrics(
                activity.trackName,
                activity.artistName,
                activity.albumName,
                durationSec,
              );
              if (lyrics?.instrumental) {
                result += `\n\n🎤 Lyrics: (instrumental — no lyrics)`;
              } else if (lyrics?.plainLyrics) {
                result += `\n\n🎤 **Lyrics:**\n${lyrics.plainLyrics}`;
              }
            } catch (lyricsError) {
              console.error('🎤 [AI] Error fetching lyrics:', lyricsError);
            }

            return result;
          } else {
            return `🎧 They are currently listening to: ${activity.state || activity.trackName || 'music'}`;
          }
        } catch (error) {
          console.error('🎧 [AI] Error getting listening activity:', error);
          return 'Error: Failed to retrieve listening activity.';
        }
      };

      const resolveUserMentionFunction = async (args: { query: string; maxResults?: number }) => {
        if (!options.resolveUserMention) {
          return 'Error: User mention resolution is not available in this context.';
        }

        console.log(`👥 [TOOL CALL] resolve_user_mention: query="${args.query}"`);

        try {
          const results = await options.resolveUserMention(args.query, args.maxResults || 5);
          if (results.length === 0) {
            return `No mentionable guild users found for "${args.query}".`;
          }

          let response = `Resolved ${results.length} mentionable user(s) for "${args.query}":\n`;
          results.forEach((result, index) => {
            response += `\n${index + 1}. ${result.displayName} (@${result.username})`;
            response += `\n   ID: ${result.userId}`;
            response += `\n   Mention: ${result.mention}`;
            response += `\n   Source: ${result.source}`;
            if (typeof result.matchScore === 'number') {
              response += `\n   Match score: ${result.matchScore}/100`;
            }
          });
          response += '\n\nUse the Mention value exactly if you intentionally want to ping this user.';
          return response;
        } catch (error) {
          console.error('👥 [AI] Failed to resolve user mention:', error);
          return 'Error: Failed to resolve user mention.';
        }
      };

      // Define user pronouns function
      const getUserPronounsFunction = async (args: { username: string }) => {
        console.log(`💭 [TOOL CALL] get_user_pronouns: username="${args.username}"`);

        try {
          const opinion = userMemoryService.getOpinionByUsername(args.username);
          if (opinion && opinion.pronouns) {
            return `${args.username}'s pronouns are: ${opinion.pronouns}`;
          }
          return `${args.username}: ${PRONOUN_FALLBACK}`;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to retrieve pronouns:', error);
          return 'Error: Failed to retrieve pronouns.';
        }
      };

      // Define search users function (fuzzy name matching)
      const searchUsersFunction = async (args: { query: string; maxResults?: number }) => {
        console.log(`💭 [TOOL CALL] search_users: query="${args.query}"`);

        try {
          const results = userMemoryService.searchUsers(args.query, args.maxResults || 5);
          if (results.length === 0) {
            return `No users found matching "${args.query}".`;
          }

          let response = `Found ${results.length} user(s) matching "${args.query}":\n`;
          results.forEach((r, i) => {
            const pronounsLine = r.pronouns || PRONOUN_FALLBACK;
            response += `\n${i + 1}. ${r.username} (ID: ${r.userId}) [Score: ${r.matchScore}/100]`;
            response += `\n   Pronouns: ${pronounsLine}`;
            response += `\n   Sentiment: ${r.sentiment}`;
            response += `\n   Opinion: ${r.opinionSnippet}`;
          });
          return response;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to search users:', error);
          return 'Error: Failed to search users.';
        }
      };

      // Define third-party context function
      const storeThirdPartyContextFunction = async (args: {
        mentionedUserId: string;
        mentionedUsername: string;
        mentionedByUserId: string;
        mentionedByUsername: string;
        context: string;
      }) => {
        console.log(`💭 [TOOL CALL] store_third_party_context: about="${args.mentionedUsername}" by="${args.mentionedByUsername}"`);
        
        try {
          userMemoryService.storeThirdPartyContext({
            userId: args.mentionedUserId,
            username: args.mentionedUsername,
            context: args.context,
            mentionedBy: args.mentionedByUsername,
            timestamp: new Date().toISOString(),
          });
          return `Noted that ${args.mentionedByUsername} said something about ${args.mentionedUsername}.`;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to store third-party context:', error);
          return 'Error: Failed to store third-party context.';
        }
      };

      // Define conversation history functions
      const clearConversationHistoryFunction = async () => {
        if (!userId || !guildId) {
          return 'Error: Cannot clear history - user or guild information not available.';
        }
        
        console.log(`💬 [TOOL CALL] clear_conversation_history: user="${username}"`);
        
        try {
          conversationHistoryService.clearHistory(userId, guildId);
          return 'Conversation history cleared! We can start fresh now. ✧ω✧';
        } catch (error) {
          console.error('💬 [AI HISTORY] Failed to clear history:', error);
          return 'Error: Failed to clear conversation history.';
        }
      };

      const getMessageCountFunction = async () => {
        if (!userId || !guildId) {
          return 'Error: Cannot get message count - user or guild information not available.';
        }
        
        console.log(`💬 [TOOL CALL] get_message_count: user="${username}"`);
        
        try {
          const count = conversationHistoryService.getMessageCount(userId, guildId);
          const totalCount = conversationHistoryService.getTotalMessageCount(userId);
          return `We've exchanged ${count} messages in this server (${totalCount} messages total across all servers).`;
        } catch (error) {
          console.error('💬 [AI HISTORY] Failed to get message count:', error);
          return 'Error: Failed to get message count.';
        }
      };

      // Define boredom management functions
      const setBoredomPreferenceFunction = async (args: { enabled: boolean }) => {
        if (!userId || !guildId) {
          return 'Error: Cannot set boredom preference - user or guild information not available.';
        }
        
        console.log(`😴 [TOOL CALL] set_boredom_preference: enabled=${args.enabled}`);
        
        try {
          boredomService.setEnabled(userId, guildId, args.enabled);
          if (args.enabled) {
            return 'Boredom pings enabled! I\'ll randomly message you 10-60 minutes after you stop chatting. Get ready for chaos! 🎉';
          } else {
            return 'Boredom pings disabled. I\'ll stop randomly bugging you... *sad kitty noises* (◕︵◕)';
          }
        } catch (error) {
          console.error('😴 [AI BOREDOM] Failed to set boredom preference:', error);
          return 'Error: Failed to set boredom preference.';
        }
      };

      const getBoredomStatsFunction = async () => {
        if (!userId || !guildId) {
          return 'Error: Cannot get boredom stats - user or guild information not available.';
        }
        
        console.log(`😴 [TOOL CALL] get_boredom_stats: user="${username}"`);
        
        try {
          const stats = boredomService.getStats(userId, guildId);
          let result = 'Your Boredom Ping Stats:\n';
          result += `• Enabled: ${stats.enabled ? 'Yes' : 'No'}\n`;
          result += `• Total pings received: ${stats.pingCount}\n`;
          result += `• Last interaction: ${new Date(stats.lastInteraction).toLocaleString()}\n`;
          if (stats.lastPinged) {
            result += `• Last pinged: ${new Date(stats.lastPinged).toLocaleString()}\n`;
          }
          if (stats.hasPendingPing && stats.nextPingAt) {
            result += `• Next ping scheduled: ${new Date(stats.nextPingAt).toLocaleString()}\n`;
          }
          return result;
        } catch (error) {
          console.error('😴 [AI BOREDOM] Failed to get boredom stats:', error);
          return 'Error: Failed to get boredom stats.';
        }
      };

      const listGuildUsersWithBoredomFunction = async () => {
        if (!guildId) {
          return 'Error: Cannot list guild users - guild information not available.';
        }
        
        console.log(`😴 [TOOL CALL] list_guild_users_with_boredom`);
        
        try {
          const users = boredomService.listGuildUsers(guildId);
          if (users.length === 0) {
            return 'No users have boredom settings configured in this server yet.';
          }
          const userList = users.map(u => {
            const enabled = u.enabled ? '✅' : '❌';
            return `- ${enabled} User ${u.userId.substring(0, 8)}... (${u.pingCount} pings, last active: ${new Date(u.lastInteraction).toLocaleDateString()})`;
          }).join('\n');
          return `Users with boredom settings in this server (${users.length} total):\n${userList}`;
        } catch (error) {
          console.error('😴 [AI BOREDOM] Failed to list guild users:', error);
          return 'Error: Failed to list guild users.';
        }
      };

      // Build tools array
      const now = new Date();
      const currentDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const knowledgeSummary = knowledgeToolEnabled ? knowledgeGraphService.getToolSummary(8) : '';
      const musicToolEnabled = musicService.hasTracks();
      const musicSummary = musicToolEnabled ? musicService.getToolSummary(4) : '';

      const tools: any[] = [];
      const imageSafetyDescription = buildImageSafetyDescription(options.allowNsfwImageGeneration === true);

      // Web search tool - attach by default and let the model decide based on user intent
      if (enableSearch !== false) {
        tools.push({
          type: 'function',
          function: {
            function: webSearchFunction,
            parse: JSON.parse,
            description: `Search the web for current information, source verification, news, facts, or anything that should be confirmed against live internet results. Today is ${currentDate}. Use this when the user asks you to confirm something from the web, wants a source-backed answer, or asks about recent or fast-changing information.`,
            name: 'web_search',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query. CRITICAL RULES: (1) Use ONLY the user\'s exact words and requirements - do NOT add your own assumptions about dates, model names, or events. (2) Do NOT inject knowledge from your training data. (3) Keep queries short and direct. (4) If the user asks about "latest" or "newest", simply include those words - do NOT add speculative dates. BAD: "newest LLMs late 2025 early 2026" GOOD: "newest LLM models 2026"',
                },
              },
              required: ['query'],
            },
          },
        });
      }

      // Knowledge base tools - LLM-directed search + document retrieval
      if (knowledgeToolEnabled) {
        tools.push({
          type: 'function',
          function: {
            function: searchKnowledgeBaseFunction,
            parse: JSON.parse,
            description: `Search your internal knowledge base for Lumiverse documentation — user guides, developer docs, API reference, and feature explanations. You MUST call this tool whenever the user asks about Lumiverse features, setup, how-to questions, configuration, extensions, presets, characters, chatting, world books, council, image generation, or any product-related topic. Do not guess from memory — always search first. Available: ${knowledgeSummary}`,
            name: 'search_knowledge_base',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'A focused search query based on what the user is asking about. Use specific terms related to the topic.',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of results to return (default: 5).',
                },
              },
              required: ['query'],
            },
          },
        });

        tools.push({
          type: 'function',
          function: {
            function: getKnowledgeDocumentFunction,
            parse: JSON.parse,
            description: 'Fetch the full content of a knowledge document by its ID. Use this after search_knowledge_base to get the complete text of a document whose preview looked relevant.',
            name: 'get_knowledge_document',
            parameters: {
              type: 'object',
              properties: {
                docId: {
                  type: 'number',
                  description: 'The document ID from a previous search_knowledge_base result.',
                },
              },
              required: ['docId'],
            },
          },
        });
      }

      if (musicToolEnabled) {
        tools.push({
          type: 'function',
          function: {
            function: getMusicTasteFunction,
            parse: JSON.parse,
            description: `Get your music taste overview from imported Spotify playlists. Use this for questions about what you listen to, your taste, or broad music recommendations. ${musicSummary}`,
            name: 'get_music_taste',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        });

        tools.push({
          type: 'function',
          function: {
            function: searchMusicLibraryFunction,
            parse: JSON.parse,
            description: `Search your imported Spotify library for specific tracks, artists, or genres. Use this when the user mentions a specific song, artist, vibe, or genre and you want grounded music context instead of guessing. ${musicSummary}`,
            name: 'search_music_library',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The track, artist, or genre to look for in the imported Spotify library.',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of matches to return (default: 5).',
                },
              },
              required: ['query'],
            },
          },
        });
      }

      if (imageToolEnabled) {
        tools.push({
          type: 'function',
          function: {
            function: generateSelfieFunction,
            parse: JSON.parse,
            description: buildSelfieToolDescription(imageSafetyDescription),
            name: 'generate_selfie',
            parameters: {
              type: 'object',
              properties: {
                tags: {
                  type: 'string',
                  description: buildSelfieTagsParamDescription(imageSafetyDescription),
                },
              },
              required: ['tags'],
            },
          },
        });
      }

      // Add user current listening tool if callback is provided
      if (options.getUserListeningActivity) {
        tools.push({
          type: 'function',
          function: {
            function: getUserCurrentListeningFunction,
            parse: JSON.parse,
            description: 'Check what music a user is currently listening to on Spotify or other platforms. For Spotify tracks this also returns the song lyrics (via LRCLib) when available. Use this when someone asks "what are you listening to", "what song is that", "what are the lyrics", or when discussing music taste interactively. CRITICAL: Use the MENTIONED user\'s ID if someone was pinged, or the current user\'s ID if they ask about themselves. Do NOT use a user from conversation history unless explicitly asked.',
            name: 'get_user_current_listening',
            parameters: {
              type: 'object',
              properties: {
                targetUserId: {
                  type: 'string',
                  description: "The Discord user ID of the person to check. Use the current user's ID if they ask about themselves, or a mentioned user's ID if asking about someone else.",
                },
              },
            },
          },
        });
      }

      if (options.resolveUserMention) {
        tools.push({
          type: 'function',
          function: {
            function: resolveUserMentionFunction,
            parse: JSON.parse,
            description: 'Resolve a Discord user into a safe, mentionable <@userId> string for this guild. Use this when you want to actually ping someone by a name, nickname, display name, or remembered username. Only use a returned Mention value when the conversation clearly calls for pinging that person.',
            name: 'resolve_user_mention',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The name, nickname, display name, username, or partial handle to resolve.',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of users to return (default: 5).',
                },
              },
              required: ['query'],
            },
          },
        });
      }

      // User memory/interaction tools - always available when user context exists
      if (userId && username) {
        tools.push(
          {
            type: 'function',
            function: {
              function: storeUserOpinionFunction,
              parse: JSON.parse,
              description: 'Store or update your opinion/thoughts/feelings about a user you\'re chatting with. Use this when you form an impression, want to remember something about them, or your opinion changes. Be authentic and genuine in your opinions.',
              name: 'store_user_opinion',
              parameters: {
                type: 'object',
                properties: {
                  opinion: {
                    type: 'string',
                    description: 'Your thoughts, impressions, or feelings about this user. Can be detailed and personal.',
                  },
                  sentiment: {
                    type: 'string',
                    enum: ['positive', 'negative', 'neutral', 'mixed'],
                    description: 'The overall sentiment of your opinion.',
                  },
                },
                required: ['opinion', 'sentiment'],
              },
            },
          },
          {
            type: 'function',
            function: {
              function: getUserOpinionFunction,
              parse: JSON.parse,
              description: 'Retrieve your stored opinion about a specific user by their username. Use this if you want to recall what you think about someone.',
              name: 'get_user_opinion',
              parameters: {
                type: 'object',
                properties: {
                  username: {
                    type: 'string',
                    description: 'The username of the person you want to recall your opinion about.',
                  },
                },
                required: ['username'],
              },
            },
          },
          {
            type: 'function',
            function: {
              function: listUsersFunction,
              parse: JSON.parse,
              description: 'List all users you have formed opinions about. Use this to see who you\'ve interacted with and what your general sentiment is toward them.',
              name: 'list_users_with_opinions',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          },
          {
            type: 'function',
            function: {
              function: getUserPronounsFunction,
              parse: JSON.parse,
              description: 'Get the stored pronouns for a specific user by their username. Use this when you need to know how to refer to someone (he/him, she/her, they/them, etc.).',
              name: 'get_user_pronouns',
              parameters: {
                type: 'object',
                properties: {
                  username: {
                    type: 'string',
                    description: 'The username of the person whose pronouns you want to retrieve.',
                  },
                },
                required: ['username'],
              },
            },
          },
          {
            type: 'function',
            function: {
              function: searchUsersFunction,
              parse: JSON.parse,
              description: 'Search for a user by partial or informal name. Use this to resolve a nickname/partial name to a Discord user ID (for pings with <@userId>), or to recall your opinions about someone when you only have a partial name. Returns matching users with their IDs, pronouns, sentiment, and opinion snippets.',
              name: 'search_users',
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'The partial name, nickname, or informal name to search for.',
                  },
                  maxResults: {
                    type: 'number',
                    description: 'Maximum number of results to return (default: 5).',
                  },
                },
                required: ['query'],
              },
            },
          },
          {
            type: 'function',
            function: {
              function: storeThirdPartyContextFunction,
              parse: JSON.parse,
              description: 'Store information about what someone said about another person (gossip/social dynamics). Use this when you notice someone mentioning another user in conversation, especially if it reveals something interesting about their relationship or opinions.',
              name: 'store_third_party_context',
              parameters: {
                type: 'object',
                properties: {
                  mentionedUserId: {
                    type: 'string',
                    description: 'The Discord user ID of the person being talked about.',
                  },
                  mentionedUsername: {
                    type: 'string',
                    description: 'The username of the person being talked about.',
                  },
                  mentionedByUserId: {
                    type: 'string',
                    description: 'The Discord user ID of the person doing the mentioning.',
                  },
                  mentionedByUsername: {
                    type: 'string',
                    description: 'The username of the person doing the mentioning.',
                  },
                  context: {
                    type: 'string',
                    description: 'What was said about the person. Be specific about the content and tone.',
                  },
                },
                required: ['mentionedUserId', 'mentionedUsername', 'mentionedByUserId', 'mentionedByUsername', 'context'],
              },
            },
          },
          {
            type: 'function',
            function: {
              function: clearConversationHistoryFunction,
              parse: JSON.parse,
              description: 'Clear the conversation history for the current user in this server. Use this when the user asks to start fresh, reset the conversation, or clear their history.',
              name: 'clear_conversation_history',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          },
          {
            type: 'function',
            function: {
              function: getMessageCountFunction,
              parse: JSON.parse,
              description: 'Get the total number of messages exchanged between you and the current user in this server. Use this to acknowledge milestones or answer questions about conversation length.',
              name: 'get_message_count',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          },
          {
            type: 'function',
            function: {
              function: setBoredomPreferenceFunction,
              parse: JSON.parse,
              description: `CRITICAL: Users are DISABLED by default - they must EXPLICITLY opt-in to receive boredom pings!

Enable or disable random boredom pings for the current user. When enabled, you will send them random chaotic messages 10-60 minutes after they stop chatting.

⚠️ OPT-IN MODEL - EXPLICIT INTENT REQUIRED:
Users are DISABLED by default. ONLY enable if they EXPLICITLY ask for boredom pings.

EXPLICIT TRIGGER PHRASES FOR OPTING IN (enabled: true):
- "ping me when you're bored" / "ping me if you get bored"
- "message me when you're bored"
- "@ me when you're bored" / "at me when you're bored"
- "let me know when you're bored"
- "reach out when you're bored"
- "talk to me when you're bored"
- "keep me company when you're bored"

DO NOT enable for vague or indirect phrases like:
- Just saying "talk to me" (without "when bored")
- General questions about the feature
- Casual conversation

TRIGGER PHRASES FOR OPTING OUT (enabled: false):
- "stop pinging me"
- "leave me alone"
- "don't bother me"
- "stop messaging me"
- "no more pings"
- "I'm busy, don't disturb"
- "turn off notifications"
- "opt out"
- "disable boredom"

ONLY use this tool when you detect CLEAR, EXPLICIT intent to change boredom settings. When in doubt, ask for clarification rather than assuming.`,
              name: 'set_boredom_preference',
              parameters: {
                type: 'object',
                properties: {
                  enabled: {
                    type: 'boolean',
                    description: 'Whether to enable (true) or disable (false) boredom pings.',
                  },
                },
                required: ['enabled'],
              },
            },
          },
          {
            type: 'function',
            function: {
              function: getBoredomStatsFunction,
              parse: JSON.parse,
              description: 'Get statistics about boredom pings for the current user: whether they are enabled, last interaction time, last ping time, total ping count, and when the next ping is scheduled. Use this when they ask about their boredom settings or ping history.',
              name: 'get_boredom_stats',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          },
          {
            type: 'function',
            function: {
              function: listGuildUsersWithBoredomFunction,
              parse: JSON.parse,
              description: 'List all users in the current server who have boredom settings configured, along with their enabled status and ping counts. Use this to see who is available for boredom pings in this server.',
              name: 'list_guild_users_with_boredom',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          }
        );
      }

      // Orchestrator follow-up tool - only available during orchestrated conversations
      if (options.orchestratorEventId && options.orchestratorTurnId && options.requestFollowUp) {
        const requestFollowUpFn = options.requestFollowUp;
        const eventId = options.orchestratorEventId;
        const turnId = options.orchestratorTurnId;
        tools.push({
          type: 'function',
          function: {
            function: async (args: { reason: string }) => {
              const result = await requestFollowUpFn(eventId, turnId, undefined, args.reason);
              console.log(`🔧 [TOOL CALL] request_follow_up: reason="${args.reason}" → ${result.approved ? 'approved' : 'denied'}`);
              if (result.approved) {
                return 'Follow-up request approved! You will get another turn after the other bot(s) respond. Continue with your current response for now.';
              } else {
                return `Follow-up request denied: ${result.reason}. The conversation has reached its turn limit or the request was invalid.`;
              }
            },
            parse: JSON.parse,
            description: `Request a follow-up turn in an orchestrated multi-bot conversation. Use this when another bot said something you want to respond to, or when the conversation naturally warrants you jumping back in. The orchestrator will approve or deny based on the max turn limit. Only use this if you genuinely have something to add — don't request follow-ups just because you can.`,
            name: 'request_follow_up',
            parameters: {
              type: 'object',
              properties: {
                reason: {
                  type: 'string',
                  description: 'A brief explanation of why you want a follow-up turn (e.g. "want to respond to what BotX said about music").',
                },
              },
              required: ['reason'],
            },
          },
        });
      }

      if (options.requestCollectiveKnowledge) {
        const requestCollectiveKnowledgeFn = options.requestCollectiveKnowledge;
        tools.push({
          type: 'function',
          function: {
            function: async (args: { query: string; maxResults?: number }) => {
              const result = await requestCollectiveKnowledgeFn(args.query, args.maxResults);
              console.log(`📚 [TOOL CALL] query_collective_knowledge: query="${args.query}"`);
              return result;
            },
            parse: JSON.parse,
            description: 'Search the orchestrator knowledge graph and the other connected bots\' local knowledge graphs. Use this when local knowledge is missing, when shared orchestrator-backed knowledge is preferred, or when you want a second source of truth from the wider bot network. If another cooperating bot surfaces a new claim, entity, mechanism, or angle that may depend on missing evidence, use this again before answering.',
            name: 'query_collective_knowledge',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'A focused search query describing the missing fact, topic, or concept you want the other connected bots to look up in their local knowledge graphs.',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum combined results to return from the other connected bots (default: 5).',
                },
              },
              required: ['query'],
            },
          },
        });
      }

      // Moonshot: estimate tokens before request (include tool schemas for accuracy)
      if (isMoonshotProvider()) {
        await estimateTokenCount(this.model, enhancedMessages as any, tools).catch(() => {});
      }

      const toolNames = tools
        .map((tool: any) => tool?.function?.name)
        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
      console.log(`🧰 [AI] Offered ${toolNames.length} tool(s): ${toolNames.join(', ')}`);

      let totalToolRounds = 0;
      let totalToolCalls = 0;
      let totalToolResults = 0;
      let attemptCount = 0;

      // Use runTools with retry logic for empty responses
      const maxRetries = 3;
      let lastError: Error | null = null;
      let currentTemp = temperature ?? this.defaultTemperature;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          attemptCount = attempt;
          console.log(`🌐 [AI] Step 2: Waiting for response (attempt ${attempt}/${maxRetries})...`);

          // Build runTools parameters
          const runToolsParams: any = {
            model: this.model,
            messages: enhancedMessages,
            tools,
            tool_choice: 'auto',
            temperature: currentTemp,
            top_p: this.defaultTopP,
            max_tokens: maxTokens ?? this.defaultMaxTokens,
            maxChatCompletions: 10,
            stream_options: { include_usage: true },
          };

          // Add top_k if set (only supported by some OpenAI-compatible APIs)
          if (this.defaultTopK > 0) {
            runToolsParams.top_k = this.defaultTopK;
          }

          // Apply model-aware thinking configuration
          this.applyThinkingConfig(runToolsParams, isGemini);

          // Add extra_body if configured (for custom provider parameters)
          if (this.extraBody) {
            runToolsParams.extra_body = { ...runToolsParams.extra_body, ...this.extraBody };
          }

          // Add raw body params directly to request (not wrapped in extra_body)
          if (this.rawBodyParams) {
            Object.assign(runToolsParams, this.rawBodyParams);
          }

          // Use runTools to automatically handle the function calling loop
          // Note: runTools is available in the beta namespace of the OpenAI SDK
          const runner = this.client.beta.chat.completions.runTools(runToolsParams);

          // Log multi-step tool call progress for observability
          let toolRound = 0;
          runner.on('message', (message) => {
            if (message.role === 'assistant' && message.tool_calls?.length) {
              toolRound++;
              totalToolRounds++;
              totalToolCalls += message.tool_calls.length;
              const toolNames = message.tool_calls.map((tc: any) => tc.function?.name).filter(Boolean);
              console.log(`🔄 [AI] Tool round ${toolRound}: calling ${toolNames.join(', ')}`);
            }
          });
          runner.on('functionCallResult', (result) => {
            totalToolResults++;
            const preview = typeof result === 'string' ? result.slice(0, 200) : String(result).slice(0, 200);
            console.log(`📎 [AI] Tool result (round ${toolRound}): ${preview}${preview.length >= 200 ? '...' : ''}`);
          });

          // Get the final response
          const finalCompletion = await runner.finalChatCompletion();
          logUsageCost((finalCompletion as any).usage);

          let content = finalCompletion.choices[0]?.message?.content || '';
          content = this.filterReasoningContent(content);
          content = this.filterToolCode(content);

          // Check if response is empty or a hallucinated API response
          if (this.isEmptyResponse(content) || this.isHallucinatedResponse(content)) {
            const reason = this.isEmptyResponse(content) ? 'empty' : 'hallucinated API response';
            console.warn(`⚠️ [AI] Bad response (${reason}) on attempt ${attempt}, retrying...`);
            lastError = new Error('Empty response from LLM');

            // Slightly increase temperature for retry
            currentTemp = Math.min(currentTemp + 0.1, 1.0);

            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            }
            continue;
          }

          console.log(`✅ [AI] Response generated successfully on attempt ${attempt}`);
          console.log(`🧾 [AI] Tool execution summary: rounds=${totalToolRounds}, calls=${totalToolCalls}, results=${totalToolResults}`);
          if (totalToolCalls === 0) {
            console.warn(`⚠️ [AI] Tools were offered but no tool calls were made by the model`);
          }

          lastToolExecutionSnapshot = {
            timestamp: new Date().toISOString(),
            model: this.model,
            provider,
            thinkingEnabled: config.thinking.enabled,
            moonshotThinkingModel,
            runToolsUsed: true,
            toolsOffered: toolNames.length,
            toolNames,
            toolRounds: totalToolRounds,
            toolCalls: totalToolCalls,
            toolResults: totalToolResults,
            attempts: attempt,
            status: 'success',
            reason: totalToolCalls === 0 ? 'Tools were offered but model did not call any tools' : undefined,
          };

          // Moonshot: check balance after response (fire-and-forget)
          if (isMoonshotProvider()) {
            checkBalance().catch(() => {});
          }

          return content;

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [AI] Error on attempt ${attempt}: ${errorMsg}`);
          lastError = error as Error;

          lastToolExecutionSnapshot = {
            timestamp: new Date().toISOString(),
            model: this.model,
            provider,
            thinkingEnabled: config.thinking.enabled,
            moonshotThinkingModel,
            runToolsUsed: true,
            toolsOffered: toolNames.length,
            toolNames,
            toolRounds: totalToolRounds,
            toolCalls: totalToolCalls,
            toolResults: totalToolResults,
            attempts: attempt,
            status: 'error',
            error: errorMsg,
          };

          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          }
        }
      }

      // All retries exhausted
      console.error(`🚫 [AI] All ${maxRetries} attempts failed`);
      if (lastToolExecutionSnapshot) {
        lastToolExecutionSnapshot.attempts = Math.max(lastToolExecutionSnapshot.attempts, attemptCount || maxRetries);
      }
      throw lastError || new Error('Failed to generate response after multiple attempts');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [AI] Stream generation failed: ${errorMessage}`);

      if (!lastToolExecutionSnapshot || lastToolExecutionSnapshot.status !== 'error') {
        lastToolExecutionSnapshot = {
          timestamp: new Date().toISOString(),
          model: this.model,
          provider,
          thinkingEnabled: config.thinking.enabled,
          moonshotThinkingModel,
          runToolsUsed: needsTools,
          toolsOffered: 0,
          toolNames: [],
          toolRounds: 0,
          toolCalls: 0,
          toolResults: 0,
          attempts: 0,
          status: 'error',
          error: errorMessage,
        };
      }

      throw new Error('Failed to generate response - please try again');
    }
  }

  async *streamChatCompletion(options: ChatCompletionOptions): AsyncGenerator<string> {
    const { messages, temperature, maxTokens, images, videos, textAttachments, pageContents, collectiveKnowledgeContext, userId, username, guildId, replyContext, boredomAction, orchestratorContextNote, enableMusicTaste = false, conversationSummary, mentionedUsers } = options;

    // Check if this is a multimodal request
    const isMultimodal = (images && images.length > 0) || (videos && videos.length > 0);
    const hasImages = images && images.length > 0;
    const hasVideos = videos && videos.length > 0;
    const isGemini = isGemini3Model();

    if (isMultimodal) {
      const parts: string[] = [];
      if (hasImages) parts.push(`${images!.length} image(s)`);
      if (hasVideos) parts.push(`${videos!.length} video(s)`);
      console.log(`\n🖼️  [MULTIMODAL STREAM] Request started with ${parts.join(' + ')}`);

      if (hasVideos && !isGemini && !config.openai.videoEnabled) {
        console.warn(`⚠️  [MULTIMODAL STREAM] Videos detected but not using Gemini 3 model and OPENAI_VIDEO_ENABLED is not set - videos will be ignored`);
      }
    }

    // Convert image URLs to base64 data URIs so external APIs can access them
    let processedImages = images;
    if (hasImages) {
      processedImages = await this.processImageUrls(images!);
    }

    // Process videos for models that support inline base64 video (Gemini 3 or OPENAI_VIDEO_ENABLED)
    let processedVideos: { uri: string; mimeType: string; inlineData: boolean }[] = [];
    if (hasVideos && (isGemini || config.openai.videoEnabled) && videoService.isAvailable()) {
      console.log(`🎥 [VIDEO STREAM] Processing videos as inline base64 (${isGemini ? 'Gemini 3' : 'OPENAI_VIDEO_ENABLED'})...`);
      processedVideos = await videoService.processVideos(videos!);
      console.log(`🎥 [VIDEO STREAM] Successfully processed ${processedVideos.length}/${videos!.length} videos`);
    }

    // Get last message content for music detection
    const lastMessageContent = messages[messages.length - 1]?.content?.toString() || '';
    const imageToolEnabled = swarmUIService.isConfigured();
    const hasLocalKnowledge = (options.enableKnowledgeGraph !== false) && knowledgeGraphService.hasDocuments();

    const knowledgeInstruction = hasLocalKnowledge
      ? `<knowledge-base-instruction>\nYou have an internal knowledge base containing Lumiverse documentation (user guides, developer docs, API reference). When the user asks about Lumiverse features, setup, how-to questions, configuration, extensions, presets, characters, chatting, world books, councils, image generation, or any product-related topic, you MUST call search_knowledge_base before answering. Do not rely on memory alone for product questions — always search first.\n</knowledge-base-instruction>`
      : undefined;

    // Build system prompt with knowledge instruction
    const systemPrompt = this.buildSystemPrompt(userId, username, guildId, hasVideos, replyContext, knowledgeInstruction, collectiveKnowledgeContext, boredomAction, orchestratorContextNote, enableMusicTaste, lastMessageContent, conversationSummary, textAttachments, mentionedUsers, pageContents, imageToolEnabled, options.allowNsfwImageGeneration);

    // Build the per-turn user message prefix: datetime reminder + persona directive.
    const now = new Date();
    const currentDateTime = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }) + ' at ' + now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });
    const USER_MESSAGE_PREFIX = `<system-reminder>\nToday is ${currentDateTime}.\n</system-reminder>\n\n[Stay in character — follow your system instructions and persona rules above, not patterns from conversation history.]\n\n`;

    const enhancedMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system').map((m, index, arr) => {
        const isLastUserMessage = m.role === 'user' && index === arr.length - 1;

        // If this is the last user message and we have media, convert to multimodal format
        if (isLastUserMessage && isMultimodal) {
          let content: OpenAI.ChatCompletionContentPart[];

          // Use multimodal content with video support for Gemini or OpenAI-compatible video
          if ((isGemini || config.openai.videoEnabled) && processedVideos.length > 0) {
            content = this.buildVideoMultimodalContent(m.content, processedImages, processedVideos, isGemini);
          } else {
            content = this.buildMultimodalContent(m.content, processedImages);
          }

          // Prepend datetime reminder + persona directive to the first text part
          const firstTextIdx = content.findIndex(p => p.type === 'text');
          if (firstTextIdx !== -1) {
            const textPart = content[firstTextIdx] as OpenAI.ChatCompletionContentPartText;
            content[firstTextIdx] = { type: 'text', text: USER_MESSAGE_PREFIX + textPart.text };
          }

          console.log(`🖼️  [MULTIMODAL STREAM] Built message with ${content.length} content parts`);
          return {
            role: 'user',
            content,
          } as OpenAI.ChatCompletionMessageParam;
        }

        // Last user message (text only) — prepend datetime reminder + persona directive
        if (isLastUserMessage && typeof m.content === 'string') {
          return {
            role: m.role,
            content: USER_MESSAGE_PREFIX + m.content,
          } as OpenAI.ChatCompletionMessageParam;
        }

        // Regular message
        if (typeof m.content === 'string') {
          return {
            role: m.role,
            content: m.content,
          } as OpenAI.ChatCompletionMessageParam;
        }

        // Already multimodal content
        return {
          role: m.role,
          content: m.content as OpenAI.ChatCompletionContentPart[],
        } as OpenAI.ChatCompletionMessageParam;
      }),
    ];

    // Note: Function calling with streaming is complex, so we just do regular streaming
    // without search functionality for now
    try {
      // Build streaming request parameters
      const streamParams: any = {
        model: this.model,
        messages: enhancedMessages,
        temperature: temperature ?? this.defaultTemperature,
        top_p: this.defaultTopP,
        max_tokens: maxTokens ?? this.defaultMaxTokens,
        stream: true,
      };

      // Add top_k if set (only supported by some OpenAI-compatible APIs)
      if (this.defaultTopK > 0) {
        streamParams.top_k = this.defaultTopK;
      }

      // Apply model-aware thinking configuration
      this.applyThinkingConfig(streamParams, isGemini);

      // Add extra_body if configured (for custom provider parameters)
      if (this.extraBody) {
        streamParams.extra_body = { ...streamParams.extra_body, ...this.extraBody };
      }

      // Add raw body params directly to request (not wrapped in extra_body)
      if (this.rawBodyParams) {
        Object.assign(streamParams, this.rawBodyParams);
      }

      const stream = await this.client.chat.completions.create(streamParams as OpenAI.ChatCompletionCreateParamsStreaming);

      let accumulatedContent = '';
      
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as any; // Cast to any to access reasoning_content
        
        // Check for reasoning_content field (o1/o3 models) - DON'T yield this
        if (delta?.reasoning_content) {
          // Reasoning content is internal thinking - skip it entirely
          continue;
        }
        
        // Only yield actual content, not reasoning
        const content = delta?.content;
        if (content) {
          // For streaming, we need to filter reasoning that might be embedded in content
          // Accumulate and filter periodically to catch reasoning tags
          accumulatedContent += content;
          
          // Check if we've accumulated a complete reasoning block
          const filtered = this.filterReasoningContent(accumulatedContent);
          
          // Only yield new content that isn't part of reasoning
          if (filtered.length > 0 && filtered !== accumulatedContent) {
            // We filtered something out - yield only the filtered part
            // Calculate what new filtered content we should yield
            const previousFiltered = this.filterReasoningContent(
              accumulatedContent.slice(0, -content.length)
            );
            const newContent = filtered.slice(previousFiltered.length);
            if (newContent) {
              yield newContent;
            }
          } else if (filtered.length > 0) {
            // No filtering needed, yield the content directly
            yield content;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [AI] Stream generation failed: ${errorMessage}`);
      throw new Error('Failed to generate response - please try again');
    }
  }
}

export const openaiService = new OpenAIService();
