import OpenAI from 'openai';
import { config, isGemini3Model } from '../utils/config';
import { searxngService } from './searxng';
import { userMemoryService } from './user-memory';
import { conversationHistoryService } from './conversation-history';
import { guildMemoryService } from './guild-memory';
import { boredomService } from './boredom';
import { videoService } from './video';
import { knowledgeGraphService } from './knowledge-graph';
import { musicService, type MusicTrackWithDetails } from './music';
import { userActivityService, type MusicActivity } from './user-activity';
import { getBotDefinition } from '../utils/bot-definition';
import {
  getVideoReactionInstructions,
  getBoredomUpdateInstructions,
  getMusicTasteTemplate,
  getReplyContextTemplate,
  getMemorySystemTemplate
} from './prompts';

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

export interface VideoContent {
  type: 'video';
  video: {
    url: string;
    mimeType?: string;
  };
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type ChatContent = string | (TextContent | ImageContent | VideoContent)[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  enableSearch?: boolean;
  enableKnowledgeGraph?: boolean;
  knowledgeQuery?: string; // Query for knowledge graph (if not provided, uses message content)
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  images?: string[]; // URLs of images to include with the last user message
  videos?: { url: string; mimeType?: string }[]; // URLs of videos to include (Gemini 3 only)
  textAttachments?: { name: string; content: string }[]; // Text file attachments
  userId?: string; // Discord user ID for memory
  username?: string; // Discord username for memory
  guildId?: string; // Discord guild ID for guild-specific context
  replyContext?: { // Context when user is replying to Lumia's message
    isReply: boolean;
    originalContent?: string;
    originalTimestamp?: string;
  };
  boredomAction?: 'opted-in' | 'opted-out'; // If user just changed their boredom settings
  enableMusicTaste?: boolean; // DEPRECATED: Auto-inject music context (default: false). Use get_music_taste tool instead
  channelHistory?: string; // Recent channel conversation context
  getUserListeningActivity?: (userId: string) => Promise<MusicActivity | null>;
  mentionedUsers?: Map<string, string>; // userId -> username mapping for users mentioned in current message
  // Orchestrator follow-up support
  orchestratorEventId?: string;
  requestFollowUp?: (eventId: string, targetBotId?: string, reason?: string) => Promise<{ approved: boolean; reason: string }>;
}

export class OpenAIService {
  private client: OpenAI;
  private model: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private defaultTopP: number;
  private defaultTopK: number;
  private filterReasoning: boolean;

  constructor() {
    const clientConfig: { apiKey: string; baseURL?: string } = {
      apiKey: config.openai.apiKey,
    };
    
    if (config.openai.baseUrl) {
      clientConfig.baseURL = config.openai.baseUrl;
    }
    
    this.client = new OpenAI(clientConfig);
    this.model = config.openai.modelAlias || config.openai.model;
    this.defaultMaxTokens = config.openai.maxTokens;
    this.defaultTemperature = config.openai.temperature;
    this.defaultTopP = config.openai.topP;
    this.defaultTopK = config.openai.topK;
    this.filterReasoning = config.openai.filterReasoning;
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
    filtered = filtered.replace(/\b(store_user_opinion|get_user_opinion|list_users_with_opinions|web_search)\s*\([^)]*\)/gi, '');

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

        // Add top_k if set (only supported by some OpenAI-compatible APIs)
        if (this.defaultTopK > 0) {
          requestParams.top_k = this.defaultTopK;
        }

        // Disable reasoning for Gemini models to prevent leaks
        if (isGemini) {
          requestParams.thinking_config = {
            thinking_level: 'MINIMAL' // MINIMAL, LOW, MEDIUM, HIGH
          };
        }

        const completion = await this.client.chat.completions.create(requestParams);

        let content = completion.choices[0]?.message?.content || '';
        content = this.filterReasoningContent(content);
        content = this.filterToolCode(content);

        // Check if response is empty
        if (this.isEmptyResponse(content)) {
          console.warn(`⚠️ [AI] Empty response on attempt ${attempt}, retrying...`);
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
   * Build multimodal content for Gemini 3 models with video support
   * Uses inline base64 data for videos (works with proxies)
   */
  private buildGeminiMultimodalContent(
    content: ChatContent,
    images?: string[],
    videos?: { uri: string; mimeType: string; inlineData: boolean }[]
  ): OpenAI.ChatCompletionContentPart[] {
    const parts: OpenAI.ChatCompletionContentPart[] = [];

    // Add text content
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      parts.push(...content as OpenAI.ChatCompletionContentPart[]);
    }

    // Add images (standard format works for Gemini too)
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
          // Inline base64 video - send as image_url with data URI
          // Gemini 3 models support this format
          parts.push({
            type: 'image_url',
            image_url: { url: video.uri },
          });
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
    boredomAction?: 'opted-in' | 'opted-out',
    enableMusicTaste?: boolean,
    lastMessageContent?: string,
    channelHistory?: string,
    textAttachments?: { name: string; content: string }[],
    mentionedUsers?: Map<string, string>
  ): string {
    const botDefinition = getBotDefinition();
    
    // Add current date/time context at the very beginning
    const now = new Date();
    const currentDateTime = now.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    }) + ' at ' + now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZoneName: 'short'
    });
    
    let systemPrompt = `╔════════════════════════════════════════════════════════════════╗
║  📅 CURRENT DATE & TIME                                         ║
╚════════════════════════════════════════════════════════════════╝

Today is ${currentDateTime}.

${botDefinition}`;
    
    // PRIORITY 1: Add explicit current user identification
    // This MUST be prominent so the bot always knows who it's talking to
    if (username) {
      systemPrompt += `\n\n╔════════════════════════════════════════════════════════════════╗
║  👤 CURRENT USER CONTEXT                                        ║
╚════════════════════════════════════════════════════════════════╝

You are currently talking to: **${username}**${userId ? ` (ID: ${userId})` : ''}

⚠️  CRITICAL - USER IDENTIFICATION RULES:
1. **MESSAGE AUTHOR:** The current message was sent by the user shown above - always address THEM, not others
2. **MENTIONED USERS:** Users explicitly pinged/mentioned in the current message${mentionedUsers && mentionedUsers.size > 0 ? ' (see below)' : ''} - if responding TO or ABOUT them, use THEIR name
3. **CONVERSATION HISTORY:** Other users mentioned in previous messages below - they are NOT the current author unless explicitly stated

❌ NEVER confuse the current author with users mentioned in conversation history
✅ If the current author says "Hey @OtherUser", they are talking TO OtherUser, not AS OtherUser`;

      // Get and display pronouns prominently
      if (userId) {
        const pronouns = userMemoryService.getPronouns(userId);
        if (pronouns) {
          systemPrompt += `\n\n📋 **Pronouns:** ${pronouns}\n✅ **ALWAYS use these pronouns when referring to the current user**`;
        } else {
          systemPrompt += `\n\n📋 **Pronouns:** Not specified yet. If the current user mentions their pronouns, make sure to note them!`;
        }
      }

      // Add explicitly mentioned users section if present
      if (mentionedUsers && mentionedUsers.size > 0) {
        systemPrompt += `\n\n👥 **USERS MENTIONED IN THIS MESSAGE:**\n`;
        mentionedUsers.forEach((name, id) => {
          if (id !== userId) { // Don't list the author as a mention
            systemPrompt += `• ${name} (ID: ${id})\n`;
          }
        });
        systemPrompt += `\n⚠️ These users were explicitly pinged by the current author. If they are asking you to interact with or respond to one of them, use the MENTIONED user's name, not the current user's.`;
      }

      systemPrompt += '\n';
    }
    
    // PRIORITY 2: Add video-specific instructions if videos are present
    if (hasVideos) {
      const videoInstructions = getVideoReactionInstructions();
      if (videoInstructions) {
        systemPrompt += '\n\n' + videoInstructions;
      }
    }
    
    // PRIORITY 3: Add recent conversation context (MOST IMPORTANT for current flow)
    if (userId && guildId) {
      const conversationContext = conversationHistoryService.formatHistoryForPrompt(userId, guildId);
      if (conversationContext) {
        systemPrompt += conversationContext;
      }
    }
    
    // PRIORITY 4: Add recent channel conversation history
    if (channelHistory) {
      systemPrompt += channelHistory;
    }
    
    // PRIORITY 5: Add reply-specific context (HIGHEST PRIORITY for this specific turn)
    if (replyContext?.isReply && replyContext.originalContent) {
      systemPrompt += this.buildReplyContextPrompt(replyContext);
    }
    
    // Add text file attachments if present
    if (textAttachments && textAttachments.length > 0) {
      systemPrompt += `\n\n╔════════════════════════════════════════════════════════════════╗
║  📎 ATTACHED FILES                                              ║
╚════════════════════════════════════════════════════════════════╝\n`;
      for (const attachment of textAttachments) {
        systemPrompt += `\n--- File: ${attachment.name} ---\n${attachment.content}\n--- End of ${attachment.name} ---\n`;
      }
    }
    
    // Add guild-specific context if available
    if (guildId) {
      const insideJokesContext = guildMemoryService.getInsideJokesContext(guildId);
      if (insideJokesContext) {
        systemPrompt += `\n\n${insideJokesContext}`;
      }
    }
    
    // Add knowledge graph context if available
    if (knowledgeContext) {
      systemPrompt += `\n\n${knowledgeContext}`;
    }
    
    // PRIORITY 6: Add stored memory/opinion context (LOWER PRIORITY than recent conversation)
    // This prevents old memories from overriding current conversation flow
    if (userId) {
      const memoryContext = userMemoryService.getOpinionContext(userId);
      
      if (memoryContext) {
        systemPrompt += `\n\n## 📚 STORED MEMORIES (Reference Only)

The following are your past thoughts about ${username || 'this user'}. Use these as background context, but **prioritize the recent conversation above** when responding.\n\n${memoryContext}`;
      } else {
        // First interaction with this user
        const memoryTemplate = getMemorySystemTemplate({
          username: username || 'Unknown',
          firstInteractionText: 'This is your first interaction with them.'
        });
        systemPrompt += '\n\n' + memoryTemplate;
      }
    }

    // Add boredom action context if user just opted in/out
    if (boredomAction) {
      const boredomInstructions = getBoredomUpdateInstructions(boredomAction);
      if (boredomInstructions) {
        systemPrompt += '\n\n## BOREDOM PING UPDATE\n\n' + boredomInstructions;
      }
    }

    // Music context auto-injection is DISABLED by default
    if (enableMusicTaste === true && lastMessageContent && isMusicQuestion(lastMessageContent)) {
      console.log(`🎵 [MUSIC] Music context injection explicitly enabled for music query`);
      const musicContext = this.buildMusicContext();
      if (musicContext) {
        systemPrompt += musicContext;
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
    const isReplyToLumia = replyContext.isReplyToLumia !== false; // Default to true for backward compatibility
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
    const { messages, enableSearch = false, enableKnowledgeGraph = false, knowledgeQuery, temperature, maxTokens, images, videos, textAttachments, userId, username, guildId, replyContext, boredomAction, enableMusicTaste = false, channelHistory, mentionedUsers } = options;

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
      
      if (hasVideos && !isGemini) {
        console.warn(`⚠️  [MULTIMODAL] Videos detected but not using Gemini 3 model - videos will be ignored`);
      }
    }

    // Query knowledge graph if enabled
    let knowledgeContext: string | undefined;
    if (enableKnowledgeGraph) {
      // Use knowledgeQuery if provided, otherwise extract from last user message
      const query = knowledgeQuery || messages[messages.length - 1]?.content?.toString() || '';
      if (query) {
        knowledgeContext = await knowledgeGraphService.queryKnowledgeBase(query, 3);
      }
    }

    // Get last message content for music detection
    const lastMessageContent = messages[messages.length - 1]?.content?.toString() || '';

    // Build system prompt with user memory, guild context, and knowledge
    const systemPrompt = this.buildSystemPrompt(userId, username, guildId, hasVideos, replyContext, knowledgeContext, boredomAction, enableMusicTaste, lastMessageContent, channelHistory, textAttachments, mentionedUsers);

    // Process videos for Gemini 3 models (using inline base64, works with proxies)
    let processedVideos: { uri: string; mimeType: string; inlineData: boolean }[] = [];
    if (hasVideos && isGemini && videoService.isAvailable()) {
      console.log(`🎥 [VIDEO] Gemini 3 detected - processing videos as inline base64...`);
      processedVideos = await videoService.processVideos(videos!);
      console.log(`🎥 [VIDEO] Successfully processed ${processedVideos.length}/${videos!.length} videos`);
    }
     
    // Build message array with enhanced system prompt
    const enhancedMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system').map((m, index, arr) => {
        // If this is the last user message and we have media, convert to multimodal format
        if (m.role === 'user' && index === arr.length - 1 && isMultimodal) {
          let content: OpenAI.ChatCompletionContentPart[];
          
          // For Gemini 3 with videos, we need special handling
          if (isGemini && processedVideos.length > 0) {
            content = this.buildGeminiMultimodalContent(m.content, images, processedVideos);
          } else {
            content = this.buildMultimodalContent(m.content, images);
          }
          
          console.log(`🖼️  [MULTIMODAL] Built message with ${content.length} content parts`);
          return {
            role: 'user',
            content,
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

    // If search is not enabled, just do a normal completion (no tools)
    if (!enableSearch) {
      console.log(`\n🌐 [AI] Web search not enabled - normal completion`);
      
      try {
        const content = await this.generateWithRetry(
          enhancedMessages,
          temperature ?? this.defaultTemperature,
          maxTokens ?? this.defaultMaxTokens
        );
        
        return content;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ [AI] Generation failed: ${errorMessage}`);
        throw new Error('Failed to generate response - please try again');
      }
    }

    // Search is enabled - use runTools helper for automatic function calling
    console.log(`\n🌐 [AI] Tools enabled - using runTools helper`);
    
    try {
      console.log(`🌐 [AI] Step 1: AI will decide which tools to use...`);
      
      // Define the web search function
      const webSearchFunction = async (args: { query: string }) => {
        console.log(`🌐 [AI] AI requested search: "${args.query}"`);
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
        
        console.log(`💭 [AI MEMORY] Storing opinion about ${username}: "${args.opinion.substring(0, 50)}..." (${args.sentiment})`);
        
        try {
          userMemoryService.storeOpinion(userId, username, args.opinion, args.sentiment);
          return `Successfully stored your opinion about ${username}. You can reference this in future conversations.`;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to store opinion:', error);
          return 'Error: Failed to store opinion.';
        }
      };

      const getUserOpinionFunction = async (args: { username: string }) => {
        console.log(`💭 [AI MEMORY] Retrieving opinion about ${args.username}`);
        
        try {
          const opinion = userMemoryService.getOpinionByUsername(args.username);
          if (opinion) {
            return `Opinion about ${args.username}: ${opinion.opinion} (Sentiment: ${opinion.sentiment}, Last updated: ${opinion.updatedAt})`;
          } else {
            return `You don't have any stored opinions about ${args.username} yet.`;
          }
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to retrieve opinion:', error);
          return 'Error: Failed to retrieve opinion.';
        }
      };

      const listUsersFunction = async () => {
        console.log(`💭 [AI MEMORY] Listing all users with opinions`);
        
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

      // Define knowledge graph function
      const queryKnowledgeBaseFunction = async (args: { query: string; maxResults?: number }) => {
        console.log(`📚 [AI KNOWLEDGE] Querying knowledge base: "${args.query}"`);
        
        try {
          const context = await knowledgeGraphService.queryKnowledgeBase(
            args.query, 
            args.maxResults || 3
          );
          
          if (context) {
            return `Retrieved knowledge base context:\n\n${context}`;
          } else {
            return 'No relevant documents found in the knowledge base for this query.';
          }
        } catch (error) {
          console.error('📚 [AI KNOWLEDGE] Failed to query knowledge base:', error);
          return 'Error: Failed to query knowledge base.';
        }
      };

      // Define music taste function
      const getMusicTasteFunction = async () => {
        console.log(`🎵 [AI MUSIC] Getting music taste context`);
        
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
          
          console.log(`🎧 [AI] Checking listening activity for user: ${targetUserId}`);
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
            if (activity.timestamps?.start && activity.timestamps?.end) {
              const duration = activity.timestamps.end - activity.timestamps.start;
              const minutes = Math.floor(duration / 60000);
              const seconds = Math.floor((duration % 60000) / 1000);
              result += `\n⏱️ Duration: ${minutes}:${seconds.toString().padStart(2, '0')}`;
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

      // Define user pronouns function
      const getUserPronounsFunction = async (args: { username: string }) => {
        console.log(`💭 [AI MEMORY] Retrieving pronouns for ${args.username}`);
        
        try {
          const opinion = userMemoryService.getOpinionByUsername(args.username);
          if (opinion && opinion.pronouns) {
            return `${args.username}'s pronouns are: ${opinion.pronouns}`;
          }
          return `I don't have pronouns stored for ${args.username}.`;
        } catch (error) {
          console.error('💭 [AI MEMORY] Failed to retrieve pronouns:', error);
          return 'Error: Failed to retrieve pronouns.';
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
        console.log(`💭 [AI MEMORY] Storing third-party context about ${args.mentionedUsername}`);
        
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
        
        console.log(`💬 [AI HISTORY] Clearing conversation history for ${username}`);
        
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
        
        console.log(`💬 [AI HISTORY] Getting message count for ${username}`);
        
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
        
        console.log(`😴 [AI BOREDOM] Setting boredom preference: ${args.enabled}`);
        
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
        
        console.log(`😴 [AI BOREDOM] Getting boredom stats for ${username}`);
        
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
        
        console.log(`😴 [AI BOREDOM] Listing users with boredom settings in guild`);
        
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

      // Build tools array - always include web search and knowledge graph, optionally include user memory
      const now = new Date();
      const currentDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      
      const tools: any[] = [
        {
          type: 'function',
          function: {
            function: webSearchFunction,
            parse: JSON.parse,
            description: `Search the web for current information, news, facts, or any query that requires up-to-date or external information. Today is ${currentDate}. Use this when you need information you don't already know or when the user asks about current events, recent developments, or specific facts.`,
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
        },
        {
          type: 'function',
          function: {
            function: queryKnowledgeBaseFunction,
            parse: JSON.parse,
            description: 'Query your internal knowledge base for domain-specific information, documentation, or resources. Use this when the user asks about specific topics like "Loom", "Lucid Loom", technical concepts, or any subject you have stored documents about. This retrieves curated knowledge that you should present naturally in your chaotic voice.',
            name: 'query_knowledge_base',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query to find relevant knowledge documents. Should include key terms and topics.',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of documents to retrieve (1-5). Default is 3.',
                },
              },
              required: ['query'],
            },
          },
        },
        {
          type: 'function',
          function: {
            function: getMusicTasteFunction,
            parse: JSON.parse,
            description: 'Get your music taste information - what songs, artists, and genres you know. Use this when someone asks about your music taste, what you listen to, your favorite songs, or wants music recommendations. Returns real tracks from your imported Spotify playlists.',
            name: 'get_music_taste',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        },
      ];

      // Add user current listening tool if callback is provided
      if (options.getUserListeningActivity) {
        tools.push({
          type: 'function',
          function: {
            function: getUserCurrentListeningFunction,
            parse: JSON.parse,
            description: 'Check what music a user is currently listening to on Spotify or other platforms. Use this when someone asks "what are you listening to", "what song is that", or when discussing music taste interactively. CRITICAL: Use the MENTIONED user\'s ID if someone was pinged, or the current user\'s ID if they ask about themselves. Do NOT use a user from conversation history unless explicitly asked.',
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

      // Add user memory tools if we have user info
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
      if (options.orchestratorEventId && options.requestFollowUp) {
        const requestFollowUpFn = options.requestFollowUp;
        const eventId = options.orchestratorEventId;
        tools.push({
          type: 'function',
          function: {
            function: async (args: { reason: string }) => {
              const result = await requestFollowUpFn(eventId, undefined, args.reason);
              console.log(`🔧 [AI] Follow-up request result: ${result.approved ? 'approved' : 'denied'} (${result.reason})`);
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

      // Use runTools with retry logic for empty responses
      const maxRetries = 3;
      let lastError: Error | null = null;
      let currentTemp = temperature ?? this.defaultTemperature;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
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
          };

          // Add top_k if set (only supported by some OpenAI-compatible APIs)
          if (this.defaultTopK > 0) {
            runToolsParams.top_k = this.defaultTopK;
          }

          // Disable reasoning for Gemini models to prevent leaks
          if (isGemini) {
            runToolsParams.thinking_config = {
              thinking_level: 'MINIMAL' // MINIMAL, LOW, MEDIUM, HIGH
            };
          }

          // Use runTools to automatically handle the function calling loop
          const runner = (this.client as any).chat.completions.runTools(runToolsParams);

          // Get the final response
          const finalCompletion = await runner.finalChatCompletion();

          let content = finalCompletion.choices[0]?.message?.content || '';
          content = this.filterReasoningContent(content);
          content = this.filterToolCode(content);

          // Check if response is empty
          if (this.isEmptyResponse(content)) {
            console.warn(`⚠️ [AI] Empty response on attempt ${attempt}, retrying...`);
            lastError = new Error('Empty response from LLM');

            // Slightly increase temperature for retry
            currentTemp = Math.min(currentTemp + 0.1, 1.0);

            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            }
            continue;
          }

          console.log(`✅ [AI] Response generated successfully on attempt ${attempt}`);
          return content;

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [AI] Error on attempt ${attempt}: ${errorMsg}`);
          lastError = error as Error;

          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          }
        }
      }

      // All retries exhausted
      console.error(`🚫 [AI] All ${maxRetries} attempts failed`);
      throw lastError || new Error('Failed to generate response after multiple attempts');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [AI] Stream generation failed: ${errorMessage}`);
      throw new Error('Failed to generate response - please try again');
    }
  }

  async *streamChatCompletion(options: ChatCompletionOptions): AsyncGenerator<string> {
    const { messages, enableSearch = false, enableKnowledgeGraph = false, knowledgeQuery, temperature, maxTokens, images, videos, textAttachments, userId, username, guildId, replyContext, boredomAction, enableMusicTaste = false, channelHistory, mentionedUsers } = options;

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

      if (hasVideos && !isGemini) {
        console.warn(`⚠️  [MULTIMODAL STREAM] Videos detected but not using Gemini 3 model - videos will be ignored`);
      }
    }

    // Process videos for Gemini 3 models (using inline base64, works with proxies)
    let processedVideos: { uri: string; mimeType: string; inlineData: boolean }[] = [];
    if (hasVideos && isGemini && videoService.isAvailable()) {
      console.log(`🎥 [VIDEO STREAM] Gemini 3 detected - processing videos as inline base64...`);
      processedVideos = await videoService.processVideos(videos!);
      console.log(`🎥 [VIDEO STREAM] Successfully processed ${processedVideos.length}/${videos!.length} videos`);
    }

    // Query knowledge graph if enabled
    let knowledgeContext: string | undefined;
    if (enableKnowledgeGraph) {
      // Use knowledgeQuery if provided, otherwise extract from last user message
      const query = knowledgeQuery || messages[messages.length - 1]?.content?.toString() || '';
      if (query) {
        knowledgeContext = await knowledgeGraphService.queryKnowledgeBase(query, 3);
      }
    }

    // Get last message content for music detection
    const lastMessageContent = messages[messages.length - 1]?.content?.toString() || '';

    // Build system prompt with user memory, guild context, and knowledge
    const systemPrompt = this.buildSystemPrompt(userId, username, guildId, hasVideos, replyContext, knowledgeContext, boredomAction, enableMusicTaste, lastMessageContent, channelHistory, textAttachments, mentionedUsers);

    const enhancedMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system').map((m, index, arr) => {
        // If this is the last user message and we have media, convert to multimodal format
        if (m.role === 'user' && index === arr.length - 1 && isMultimodal) {
          let content: OpenAI.ChatCompletionContentPart[];
          
          // For Gemini 3 with videos, we need special handling
          if (isGemini && processedVideos.length > 0) {
            content = this.buildGeminiMultimodalContent(m.content, images, processedVideos);
          } else {
            content = this.buildMultimodalContent(m.content, images);
          }
          
          console.log(`🖼️  [MULTIMODAL STREAM] Built message with ${content.length} content parts`);
          return {
            role: 'user',
            content,
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

      // Disable reasoning for Gemini models to prevent leaks
      if (isGemini) {
        streamParams.thinking_config = {
          thinking_level: 'MINIMAL' // MINIMAL, LOW, MEDIUM, HIGH
        };
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
