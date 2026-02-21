import { GoogleGenAI, type GenerateContentConfig, type Content, type FunctionDeclaration, Type, HarmCategory, HarmBlockThreshold, FunctionCallingConfigMode } from '@google/genai';
import { config } from '../utils/config';
import { getBotDefinition } from '../utils/bot-definition';
import { searxngService } from './searxng';
import { userMemoryService } from './user-memory';
import { knowledgeGraphService } from './knowledge-graph';
import { musicService } from './music';
import { videoService } from './video';
import { boredomService } from './boredom';
import { conversationHistoryService } from './conversation-history';
import { guildMemoryService } from './guild-memory';
import { userActivityService, type MusicActivity } from './user-activity';
import {
  getVideoReactionInstructions,
  getBoredomUpdateInstructions,
  getMusicTasteTemplate,
  getReplyContextTemplate,
  getMemorySystemTemplate,
  getPersonaReinforcement
} from './prompts';

/**
 * Music-related keywords for smart detection
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

/**
 * Types matching the OpenAI service interface for compatibility
 */
export interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type ChatContent = string | (TextContent | ImageContent)[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  enableSearch?: boolean;
  enableKnowledgeGraph?: boolean;
  knowledgeQuery?: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  images?: string[]; // URLs of images to include with the last user message
  videos?: { url: string; mimeType?: string }[]; // URLs of videos to include (Gemini 3 only)
  textAttachments?: { name: string; content: string }[]; // Text file attachments
  pageContents?: { url: string; title: string; content: string; excerpt?: string; siteName?: string; byline?: string }[]; // Extracted web page contents
  userId?: string;
  username?: string;
  guildId?: string;
  replyContext?: {
    isReply: boolean;
    isReplyToLumia?: boolean;
    originalContent?: string;
    originalTimestamp?: string;
    originalAuthor?: string;
  };
  boredomAction?: 'opted-in' | 'opted-out';
  enableMusicTaste?: boolean;
  channelHistory?: string;
  getUserListeningActivity?: (userId: string) => Promise<MusicActivity | null>;
  mentionedUsers?: Map<string, string>; // userId -> username mapping for users mentioned in current message
  // Orchestrator follow-up support
  orchestratorEventId?: string; // The event ID for the current orchestrated conversation
  requestFollowUp?: (eventId: string, targetBotId?: string, reason?: string) => Promise<{ approved: boolean; reason: string }>;
}

/**
 * Google GenAI Service
 * 
 * Provides a compatible interface to the OpenAIService but uses Google's GenAI SDK
 * for direct Gemini API access. This is useful when:
 * - Using Gemini 3 Flash/Pro models with native API
 * - Need better support for Gemini-specific features
 * - Want to avoid OpenAI SDK proxy layers
 */
export class GoogleGenAIService {
  private client: GoogleGenAI;
  private model: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private defaultTopP: number;
  private defaultTopK: number;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
  }) {
    const clientConfig: {
      apiKey: string;
      httpOptions?: { baseUrl?: string };
    } = {
      apiKey: options?.apiKey ?? config.gemini.apiKey!,
    };

    const baseUrl = options?.baseUrl ?? config.gemini.baseUrl;
    if (baseUrl) {
      clientConfig.httpOptions = { baseUrl };
    }

    this.client = new GoogleGenAI(clientConfig);
    this.model = options?.model ?? config.openai.modelAlias ?? config.openai.model;
    this.defaultMaxTokens = options?.maxTokens ?? config.openai.maxTokens;
    this.defaultTemperature = options?.temperature ?? config.openai.temperature;
    this.defaultTopP = options?.topP ?? config.openai.topP;
    this.defaultTopK = options?.topK ?? config.openai.topK;

    console.log(`🔮 [Google GenAI] Initialized with model: ${this.model}`);
    if (baseUrl) {
      console.log(`🔮 [Google GenAI] Using custom base URL: ${baseUrl}`);
    }
  }

  /**
   * Convert OpenAI-style messages to Google GenAI Content format
   * 
   * Google GenAI uses a different format:
   * - Roles: 'user' | 'model' (no 'system' - system prompt goes in config)
   * - Content: array of Part objects with text/image data
   * - Images/videos must use inlineData with base64, NOT fileData with URLs
   */
  private async convertMessages(
    messages: ChatMessage[],
    images?: string[],
    videos?: { url: string; mimeType?: string }[]
  ): Promise<{ contents: Content[]; systemInstruction: string }> {
    const contents: Content[] = [];
    // ALWAYS have a system instruction - start with bot definition as default
    let systemInstruction: string = getBotDefinition();
    
    // Check if we have multimodal attachments
    const hasImages = images && images.length > 0;
    const hasVideos = videos && videos.length > 0;
    const isMultimodal = hasImages || hasVideos;

    // Process videos to get inline base64 data (like OpenAI service does)
    let processedVideos: { uri: string; mimeType: string; inlineData: boolean }[] = [];
    if (hasVideos && videoService.isAvailable()) {
      console.log(`🎥 [Google GenAI] Processing videos for inline base64...`);
      processedVideos = await videoService.processVideos(videos!);
      console.log(`🎥 [Google GenAI] Successfully processed ${processedVideos.length}/${videos!.length} videos`);
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;
      
      if (message.role === 'system') {
        // System messages become the system instruction
        systemInstruction = typeof message.content === 'string' 
          ? message.content 
          : message.content.filter(c => c.type === 'text').map(c => (c as TextContent).text).join('\n');
      } else {
        // Convert user/assistant to user/model
        const role = message.role === 'assistant' ? 'model' : 'user';
        
        // Convert content to parts
        const parts: any[] = [];
        
        if (typeof message.content === 'string') {
          // Only add non-empty text content
          if (message.content && message.content.trim()) {
            parts.push({ text: message.content });
          }
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text') {
              // Only add non-empty text parts
              if (part.text && part.text.trim()) {
                parts.push({ text: part.text });
              }
            } else if (part.type === 'image_url') {
              // Handle image URLs - need to convert to inline base64
              // For now, we'll fetch the image and convert to base64
              if (part.image_url?.url) {
                try {
                  const base64Data = await this.urlToBase64(part.image_url.url);
                  parts.push({
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: base64Data
                    }
                  });
                } catch (error) {
                  console.error(`❌ [Google GenAI] Failed to convert image to base64: ${error}`);
                }
              }
            }
          }
        }
        
        // Skip messages with no valid parts - Google GenAI requires at least one valid part
        if (parts.length === 0) {
          console.log(`⚠️ [Google GenAI] Skipping ${message.role} message with no valid content`);
          continue;
        }

        // If this is the last user message and we have multimodal attachments, add them
        const isLastUserMessage = role === 'user' && 
          !messages.slice(i + 1).some(m => m.role === 'user');
        
        // Only add attachments if we have valid parts in this message
        if (isLastUserMessage && isMultimodal && parts.length > 0) {
          // Add images from the separate images parameter
          if (hasImages) {
            for (const imageUrl of images!) {
              try {
                const base64Data = await this.urlToBase64(imageUrl);
                parts.push({
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data
                  }
                });
              } catch (error) {
                console.error(`❌ [Google GenAI] Failed to convert image to base64: ${error}`);
              }
            }
          }
          
          // Add videos from processed videos (already in base64)
          if (processedVideos.length > 0) {
            for (const video of processedVideos) {
              // Extract base64 data from data URI (format: data:mimeType;base64,actualData)
              const base64Match = video.uri.match(/^data:([^;]+);base64,(.+)$/);
              if (base64Match) {
                parts.push({
                  inlineData: {
                    mimeType: base64Match[1],
                    data: base64Match[2]
                  }
                });
              } else {
                console.error(`❌ [Google GenAI] Video data URI format unexpected: ${video.uri.substring(0, 50)}...`);
              }
            }
          }
          
          if (hasImages || hasVideos) {
            console.log(`🖼️  [Google GenAI] Attached ${hasImages ? images!.length + ' image(s)' : ''}${hasImages && hasVideos ? ' + ' : ''}${hasVideos ? processedVideos.length + ' video(s)' : ''} to last user message`);
          }
        }

        contents.push({ role, parts });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * Build the system prompt with user context, conversation history, etc.
   * This mirrors the OpenAI service's buildSystemPrompt method
   */
  private buildSystemPrompt(
    options: ChatCompletionOptions,
    hasVideos: boolean,
    knowledgeContext?: string
  ): string {
    const { userId, username, guildId, replyContext, boredomAction, channelHistory, enableMusicTaste, textAttachments, pageContents, mentionedUsers } = options;
    
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

${getBotDefinition()}`;
    
    // Get last message content for music detection
    const messages = options.messages;
    const lastMessageContent = messages[messages.length - 1]?.content?.toString() || '';
    
    // PRIORITY 1: Add explicit current user identification
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
    
    // PRIORITY 3: Conversation history context
    // The full conversation history (with username attribution) is already in the API messages array.
    // A brief note here helps the AI connect the dots without duplicating context at different fidelity levels.
    if (userId && guildId) {
      systemPrompt += `\n\n## Conversation History\n\nRefer to the conversation messages above for your recent exchanges with this user. Each user message is prefixed with their username in [brackets].`;
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

    // Add extracted web page contents if present
    if (pageContents && pageContents.length > 0) {
      systemPrompt += `\n\n╔════════════════════════════════════════════════════════════════╗
║  🌐 EXTRACTED WEB PAGES                                        ║
╚════════════════════════════════════════════════════════════════╝\n`;
      for (const page of pageContents) {
        systemPrompt += `\n--- Page: ${page.title} (${page.url}) ---\n${page.content}\n--- End of page ---\n`;
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

    // Music context auto-injection
    if (enableMusicTaste === true && lastMessageContent && isMusicQuestion(lastMessageContent)) {
      console.log(`🎵 [Google GenAI] Music context injection explicitly enabled for music query`);
      const musicContext = this.buildMusicContext();
      if (musicContext) {
        systemPrompt += musicContext;
      }
    }

    // Persona reinforcement — end-of-prompt anchor to counteract history drift
    const reinforcement = getPersonaReinforcement();
    if (reinforcement) {
      systemPrompt += '\n\n' + reinforcement;
    }

    return systemPrompt;
  }

  /**
   * Build music taste context for the system prompt
   */
  private buildMusicContext(): string {
    const stats = musicService.getStats();

    if (stats.totalTracks === 0) {
      return '';
    }

    const sampleTracks = musicService.getRandomTracks(15);
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
      tasteDesc = "You're into obscure, underground music that most people haven't discovered yet.";
    } else if (avgPopularity < 60) {
      tasteDesc = "You have eclectic taste - a mix of popular hits and hidden gems.";
    } else {
      tasteDesc = "You unapologetically love mainstream music and popular hits.";
    }

    const sampleTrackList = sampleTracks.slice(0, 10).map(t => `• "${t.name}" by ${t.artists.map(a => a.name).join(', ')} (${t.album.name})`).join('\n');
    const genreBreakdown = topGenres.length > 0 ? topGenres.map((g, i) => `${i + 1}. ${g[0]} (${g[1]} tracks in your collection)`).join('\n') : 'A mix of everything!';

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
   */
  private buildReplyContextPrompt(replyContext: { isReply: boolean; isReplyToLumia?: boolean; originalContent?: string; originalTimestamp?: string; originalAuthor?: string }): string {
    const isReplyToLumia = replyContext.isReplyToLumia !== false; // Default to true for backward compatibility
    const authorName = replyContext.originalAuthor || 'Unknown';
    const timestampText = replyContext.originalTimestamp ? `\n[Sent ${replyContext.originalTimestamp}]` : '';

    if (isReplyToLumia) {
      return getReplyContextTemplate('reply_to_bot', {
        originalContent: replyContext.originalContent || '',
        timestamp: timestampText
      });
    } else {
      return getReplyContextTemplate('reply_to_other', {
        authorName: authorName,
        originalContent: replyContext.originalContent || '',
        timestamp: timestampText
      });
    }
  }

  /**
   * Fetch an image from URL and convert to base64
   */
  private async urlToBase64(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    } catch (error) {
      throw new Error(`Failed to convert image URL to base64: ${error}`);
    }
  }

  /**
   * Build tool definitions based on enabled features
   * Returns array of function declarations for Google GenAI
   */
  private buildTools(options: ChatCompletionOptions): FunctionDeclaration[] | undefined {
    const tools: FunctionDeclaration[] = [];
    
    // Web search tool
    const now = new Date();
    const currentDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    
    if (options.enableSearch) {
      tools.push({
        name: 'web_search',
        description: `Search the web for current information, news, facts, or any up-to-date content. Today is ${currentDate}. Use this when the user asks about recent events, current information, or anything that requires searching the internet.`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: 'The search query. CRITICAL RULES: (1) Use ONLY the user\'s exact words and requirements - do NOT add your own assumptions about dates, model names, or events. (2) Do NOT inject knowledge from your training data. (3) Keep queries short and direct. (4) If the user asks about "latest" or "newest", simply include those words - do NOT add speculative dates. BAD: "newest LLMs late 2025 early 2026" GOOD: "newest LLM models 2026"',
            },
          },
          required: ['query'],
        },
      });
    }
    
    // Knowledge graph tool
    if (options.enableKnowledgeGraph) {
      tools.push({
        name: 'query_knowledge_base',
        description: 'Query the knowledge base for domain-specific information. Use this when the user asks about Lucid Loom presets, specific technical topics, or anything that might be in the knowledge base.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: 'The query to search for in the knowledge base.',
            },
            maxResults: {
              type: Type.NUMBER,
              description: 'Maximum number of results to retrieve (default: 3).',
            },
          },
          required: ['query'],
        },
      });
    }
    
    // User memory tools (always available if we have user context)
    if (options.userId && options.username) {
      tools.push({
        name: 'store_user_opinion',
        description: 'Store your opinion or impression about a user. Use this when you form a new opinion about someone or want to update an existing one. Be authentic and natural - record how you actually feel about them.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            opinion: {
              type: Type.STRING,
              description: 'Your opinion or impression about the user. Be specific and authentic.',
            },
            sentiment: {
              type: Type.STRING,
              description: 'The sentiment of your opinion: positive, negative, neutral, or mixed.',
              enum: ['positive', 'negative', 'neutral', 'mixed'],
            },
          },
          required: ['opinion', 'sentiment'],
        },
      });
      
      tools.push({
        name: 'get_user_opinion',
        description: 'Retrieve your stored opinion about a specific user. Use this when you want to recall what you think about someone.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            username: {
              type: Type.STRING,
              description: 'The username of the person you want to recall your opinion about.',
            },
          },
          required: ['username'],
        },
      });
      
      tools.push({
        name: 'list_users_with_opinions',
        description: 'List all users you have formed opinions about. Use this when you want to see who you know and what you think of them.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      });
    }
    
    // Music taste tool - ALWAYS available so LLM can use it when needed
    tools.push({
      name: 'get_music_taste',
      description: 'Get your music taste information - what songs, artists, and genres you know. Use this when someone asks about your music taste, what you listen to, your favorite songs, or wants music recommendations. Returns real tracks from your imported Spotify playlists.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    });

    // User current listening tool - check what a user is currently listening to on Spotify
    if (options.getUserListeningActivity) {
      tools.push({
        name: 'get_user_current_listening',
        description: 'Check what music a user is currently listening to on Spotify or other platforms. Use this when someone asks "what are you listening to", "what song is that", or when discussing music taste interactively. CRITICAL: Use the MENTIONED user\'s ID if someone was pinged, or the current user\'s ID if they ask about themselves. Do NOT use a user from conversation history unless explicitly asked.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            targetUserId: {
              type: Type.STRING,
              description: 'The Discord user ID of the person to check. Use the current user\'s ID if they ask about themselves, or a mentioned user\'s ID if asking about someone else.',
            },
          },
          required: ['targetUserId'],
        },
      });
    }

    // User pronouns tool - always available if we have user context
    if (options.userId && options.username) {
      tools.push({
        name: 'get_user_pronouns',
        description: 'Get the stored pronouns for a specific user by their username. Use this when you need to know how to refer to someone (he/him, she/her, they/them, etc.).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            username: {
              type: Type.STRING,
              description: 'The username of the person whose pronouns you want to retrieve.',
            },
          },
          required: ['username'],
        },
      });

      tools.push({
        name: 'store_third_party_context',
        description: 'Store information about what someone said about another person (gossip/social dynamics). Use this when you notice someone mentioning another user in conversation, especially if it reveals something interesting about their relationship or opinions.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            mentionedUserId: {
              type: Type.STRING,
              description: 'The Discord user ID of the person being talked about.',
            },
            mentionedUsername: {
              type: Type.STRING,
              description: 'The username of the person being talked about.',
            },
            mentionedByUserId: {
              type: Type.STRING,
              description: 'The Discord user ID of the person doing the mentioning.',
            },
            mentionedByUsername: {
              type: Type.STRING,
              description: 'The username of the person doing the mentioning.',
            },
            context: {
              type: Type.STRING,
              description: 'What was said about the person. Be specific about the content and tone.',
            },
          },
          required: ['mentionedUserId', 'mentionedUsername', 'mentionedByUserId', 'mentionedByUsername', 'context'],
        },
      });
    }

    // Conversation history management tools
    if (options.userId && options.guildId) {
      tools.push({
        name: 'clear_conversation_history',
        description: 'Clear the conversation history for the current user in this server. Use this when the user asks to start fresh, reset the conversation, or clear their history.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      });

      tools.push({
        name: 'get_message_count',
        description: 'Get the total number of messages exchanged between you and the current user in this server. Use this to acknowledge milestones or answer questions about conversation length.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      });
    }

    // Boredom/ping management tools
    if (options.userId && options.guildId) {
      tools.push({
        name: 'set_boredom_preference',
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
        parameters: {
          type: Type.OBJECT,
          properties: {
            enabled: {
              type: Type.BOOLEAN,
              description: 'Whether to enable (true) or disable (false) boredom pings.',
            },
          },
          required: ['enabled'],
        },
      });

      tools.push({
        name: 'get_boredom_stats',
        description: 'Get statistics about boredom pings for the current user: whether they are enabled, last interaction time, last ping time, total ping count, and when the next ping is scheduled. Use this when they ask about their boredom settings or ping history.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      });

      tools.push({
        name: 'list_guild_users_with_boredom',
        description: 'List all users in the current server who have boredom settings configured, along with their enabled status and ping counts. Use this to see who is available for boredom pings in this server.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      });
    }

    // Orchestrator follow-up tool - only available during orchestrated conversations
    if (options.orchestratorEventId && options.requestFollowUp) {
      tools.push({
        name: 'request_follow_up',
        description: `Request a follow-up turn in an orchestrated multi-bot conversation. Use this when another bot said something you want to respond to, or when the conversation naturally warrants you jumping back in. The orchestrator will approve or deny based on the max turn limit. Only use this if you genuinely have something to add — don't request follow-ups just because you can.`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            reason: {
              type: Type.STRING,
              description: 'A brief explanation of why you want a follow-up turn (e.g. "want to respond to what BotX said about music").',
            },
          },
          required: ['reason'],
        },
      });
    }

    return tools.length > 0 ? tools : undefined;
  }

  /**
   * Execute a function call and return the result
   */
  private async executeFunctionCall(
    functionCall: any,
    options: ChatCompletionOptions
  ): Promise<string> {
    const { name, args } = functionCall;
    
    console.log(`🔧 [Google GenAI] Executing function: ${name}(${JSON.stringify(args)})`);
    
    try {
      switch (name) {
        case 'web_search': {
          const results = await searxngService.search(args.query);
          const formatted = searxngService.formatResultsForLLM(results);
          console.log(`🔧 [Google GenAI] Web search completed - ${results.results?.length || 0} results`);
          return formatted;
        }
        
        case 'query_knowledge_base': {
          const context = await knowledgeGraphService.queryKnowledgeBase(
            args.query,
            args.maxResults || 3
          );
          console.log(`🔧 [Google GenAI] Knowledge base query completed`);
          return context || 'No relevant documents found in the knowledge base for this query.';
        }
        
        case 'store_user_opinion': {
          if (!options.userId || !options.username) {
            return 'Error: Cannot store opinion - user information not available.';
          }
          userMemoryService.storeOpinion(
            options.userId,
            options.username,
            args.opinion,
            args.sentiment
          );
          console.log(`🔧 [Google GenAI] Stored opinion about ${options.username}`);
          return `Successfully stored your opinion about ${options.username}. You can reference this in future conversations.`;
        }
        
        case 'get_user_opinion': {
          const opinion = userMemoryService.getOpinionByUsername(args.username);
          if (opinion) {
            return `Opinion about ${args.username}: ${opinion.opinion} (Sentiment: ${opinion.sentiment}, Last updated: ${opinion.updatedAt})`;
          }
          return `You don't have any stored opinions about ${args.username} yet.`;
        }
        
        case 'list_users_with_opinions': {
          const users = userMemoryService.listUsers();
          if (users.length === 0) {
            return "You haven't formed any opinions about users yet.";
          }
          const userList = users.map(u => `- ${u.username} (${u.sentiment}, last updated: ${u.updatedAt})`).join('\n');
          return `Users you have opinions about:\n${userList}`;
        }
        
        case 'get_music_taste': {
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
          
          const avgPopularity = Math.round(
            sampleTracks.reduce((sum, t) => sum + t.popularity, 0) / sampleTracks.length
          );
          
          let tasteDesc = '';
          if (avgPopularity < 30) tasteDesc = "into obscure, underground music";
          else if (avgPopularity < 60) tasteDesc = "into a mix of popular and underground";
          else tasteDesc = "into mainstream hits";
          
          let result = `Your Music Collection:\n`;
          result += `• ${stats.totalTracks} tracks across ${stats.totalPlaylists} playlist(s)\n`;
          result += `• ${stats.totalArtists} unique artists\n`;
          result += `• Average popularity: ${avgPopularity}/100 (${tasteDesc})\n`;
          result += `• Top genres: ${topGenres.map(g => g[0]).join(', ')}\n\n`;
          result += `Some tracks you know:\n`;
          sampleTracks.slice(0, 5).forEach(t => {
            result += `• "${t.name}" by ${t.artists.map(a => a.name).join(', ')}\n`;
          });
          
          console.log(`🔧 [Google GenAI] Retrieved music taste`);
          return result;
        }

        case 'get_user_current_listening': {
          if (!options.getUserListeningActivity) {
            return 'Error: Unable to check listening activity - service not available.';
          }
          
          try {
            const targetUserId = args.targetUserId || options.userId;
            if (!targetUserId) {
              return 'Error: No user specified to check listening activity.';
            }
            
            console.log(`🎧 [Google GenAI] Checking listening activity for user: ${targetUserId}`);
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
            console.error('🎧 [Google GenAI] Error getting listening activity:', error);
            return 'Error: Failed to retrieve listening activity.';
          }
        }

        case 'get_user_pronouns': {
          const opinion = userMemoryService.getOpinionByUsername(args.username);
          if (opinion && opinion.pronouns) {
            return `${args.username}'s pronouns are: ${opinion.pronouns}`;
          }
          return `I don't have pronouns stored for ${args.username}.`;
        }

        case 'store_third_party_context': {
          userMemoryService.storeThirdPartyContext({
            userId: args.mentionedUserId,
            username: args.mentionedUsername,
            context: args.context,
            mentionedBy: args.mentionedByUsername,
            timestamp: new Date().toISOString(),
          });
          console.log(`🔧 [Google GenAI] Stored third-party context about ${args.mentionedUsername}`);
          return `Noted that ${args.mentionedByUsername} said something about ${args.mentionedUsername}.`;
        }

        case 'clear_conversation_history': {
          if (!options.userId || !options.guildId) {
            return 'Error: Cannot clear history - user or guild information not available.';
          }
          conversationHistoryService.clearHistory(options.userId, options.guildId);
          console.log(`🔧 [Google GenAI] Cleared conversation history for ${options.username}`);
          return 'Conversation history cleared! We can start fresh now. ✧ω✧';
        }

        case 'get_message_count': {
          if (!options.userId || !options.guildId) {
            return 'Error: Cannot get message count - user or guild information not available.';
          }
          const count = conversationHistoryService.getMessageCount(options.userId, options.guildId);
          const totalCount = conversationHistoryService.getTotalMessageCount(options.userId);
          console.log(`🔧 [Google GenAI] Retrieved message count: ${count} in guild, ${totalCount} total`);
          return `We've exchanged ${count} messages in this server (${totalCount} messages total across all servers).`;
        }

        case 'set_boredom_preference': {
          if (!options.userId || !options.guildId) {
            return 'Error: Cannot set boredom preference - user or guild information not available.';
          }
          boredomService.setEnabled(options.userId, options.guildId, args.enabled);
          console.log(`🔧 [Google GenAI] Set boredom preference: ${args.enabled}`);
          if (args.enabled) {
            return 'Boredom pings enabled! I\'ll randomly message you 10-60 minutes after you stop chatting. Get ready for chaos! 🎉';
          } else {
            return 'Boredom pings disabled. I\'ll stop randomly bugging you... *sad kitty noises* (◕︵◕)';
          }
        }

        case 'get_boredom_stats': {
          if (!options.userId || !options.guildId) {
            return 'Error: Cannot get boredom stats - user or guild information not available.';
          }
          const stats = boredomService.getStats(options.userId, options.guildId);
          console.log(`🔧 [Google GenAI] Retrieved boredom stats`);
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
        }

        case 'list_guild_users_with_boredom': {
          if (!options.guildId) {
            return 'Error: Cannot list guild users - guild information not available.';
          }
          const users = boredomService.listGuildUsers(options.guildId);
          console.log(`🔧 [Google GenAI] Listed ${users.length} users with boredom settings`);
          if (users.length === 0) {
            return 'No users have boredom settings configured in this server yet.';
          }
          const userList = users.map(u => {
            const enabled = u.enabled ? '✅' : '❌';
            return `- ${enabled} User ${u.userId.substring(0, 8)}... (${u.pingCount} pings, last active: ${new Date(u.lastInteraction).toLocaleDateString()})`;
          }).join('\n');
          return `Users with boredom settings in this server (${users.length} total):\n${userList}`;
        }

        case 'request_follow_up': {
          if (!options.orchestratorEventId || !options.requestFollowUp) {
            return 'Error: Follow-up requests are only available during orchestrated conversations.';
          }
          const result = await options.requestFollowUp(
            options.orchestratorEventId,
            undefined, // targetBotId — let orchestrator decide
            args.reason
          );
          console.log(`🔧 [Google GenAI] Follow-up request result: ${result.approved ? 'approved' : 'denied'} (${result.reason})`);
          if (result.approved) {
            return 'Follow-up request approved! You will get another turn after the other bot(s) respond. Continue with your current response for now.';
          } else {
            return `Follow-up request denied: ${result.reason}. The conversation has reached its turn limit or the request was invalid.`;
          }
        }

        default:
          return `Error: Unknown function ${name}`;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`🔧 [Google GenAI] Function execution failed: ${errorMessage}`);
      return `Error executing ${name}: ${errorMessage}`;
    }
  }

  /**
   * Build generation configuration from options
   * Includes native thinkingConfig to disable reasoning output
   */
  private buildConfig(
    options: ChatCompletionOptions,
    systemInstruction: string
  ): GenerateContentConfig {
    const genConfig: GenerateContentConfig = {
      temperature: options.temperature ?? this.defaultTemperature,
      topP: this.defaultTopP,
      topK: this.defaultTopK > 0 ? this.defaultTopK : undefined,
      maxOutputTokens: options.maxTokens ?? this.defaultMaxTokens,
      // Natively disable thinking/reasoning output at the API level
      // This is more efficient than post-processing filtering
      thinkingConfig: {
        includeThoughts: false,
        thinkingLevel: 'LOW' as any,  // API only supports 'low' or 'high'
      },
      // Disable all content safety filters
      // BLOCK_NONE allows all content without blocking
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_NONE,
        },
      ],
      // ALWAYS include system instruction - NEVER let it be empty
      systemInstruction,
    };
    
    // Add tools if any are enabled
    const tools = this.buildTools(options);
    if (tools) {
      genConfig.tools = [{ functionDeclarations: tools }];
      // Force model to only use our custom tools, disable native Google search
      genConfig.toolConfig = {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: tools.map(t => t.name).filter((name): name is string => name !== undefined),
        },
      };
      console.log(`🔧 [Google GenAI] Enabled ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
      console.log(`🔧 [Google GenAI] Disabled native Google search - using SearXNG only`);
    }

    return genConfig;
  }

  /**
   * Fallback filter for reasoning content
   * Used as safety net in case any reasoning content slips through
   * or for models that don't respect thinkingConfig
   */
  private filterReasoningContent(content: string): string {
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

    // Clean up excessive whitespace
    filtered = filtered.replace(/\n{3,}/g, '\n\n');
    filtered = filtered.trim();

    return filtered;
  }

  /**
   * Check if a response part contains thought content
   * Filters out parts where thought flag is true or thoughtSignature is present
   */
  private isThoughtContent(part: any): boolean {
    // Skip if explicitly marked as thought
    if (part.thought === true) {
      return true;
    }
    
    // Skip if has thoughtSignature (even if thought flag is not set)
    // This catches the dummy signature and any real signatures
    if (part.thoughtSignature) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if a response is empty or contains only whitespace/reasoning artifacts
   */
  private isEmptyResponse(content: string): boolean {
    if (!content || content.trim().length === 0) {
      return true;
    }
    
    // Check if content is only reasoning artifacts after filtering
    const filtered = this.filterReasoningContent(content);
    return filtered.trim().length === 0;
  }

  /**
   * Generate content with retry logic for empty responses
   */
  private async generateWithRetry(
    contents: Content[],
    genConfig: GenerateContentConfig,
    options: ChatCompletionOptions,
    maxRetries: number = 3
  ): Promise<string> {
    let lastError: Error | null = null;
    let currentConfig = { ...genConfig };
    let currentContents = [...contents];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 [Google GenAI] Generation attempt ${attempt}/${maxRetries}`);

        // Make the request
        let response = await this.client.models.generateContent({
          model: this.model,
          contents: currentContents,
          config: currentConfig,
        });

        // Check for function calls
        const functionCalls = response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          console.log(`🔧 [Google GenAI] Model requested ${functionCalls.length} function call(s)`);
          
          // Execute all function calls and collect results
          const functionResults: any[] = [];
          for (const functionCall of functionCalls) {
            const result = await this.executeFunctionCall(functionCall, options);
            functionResults.push({
              name: functionCall.name,
              result: result,
            });
          }
          
          // Add function call and results to conversation
          currentContents.push({
            role: 'model',
            parts: functionCalls.map((fc: any) => ({
              functionCall: {
                name: fc.name,
                args: fc.args,
              },
            })),
          });
          
          currentContents.push({
            role: 'user',
            parts: functionResults.map((fr: any) => ({
              functionResponse: {
                name: fr.name,
                response: {
                  result: fr.result,
                },
              },
            })),
          });
          
          console.log(`🔧 [Google GenAI] Sending function results back to model...`);
          
          // Make follow-up request with function results
          response = await this.client.models.generateContent({
            model: this.model,
            contents: currentContents,
            config: currentConfig,
          });
        }

        // Process response parts
        const candidates = response.candidates || [];
        let content = '';
        
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            // Skip thought content natively
            if (this.isThoughtContent(part)) {
              continue;
            }
            
            // Skip function call parts
            if (part.functionCall) {
              continue;
            }
            
            // Collect text content
            if (part.text) {
              content += part.text;
            }
          }
        }
        
        // Apply fallback reasoning filter as safety net
        content = this.filterReasoningContent(content);

        // Check if response is empty
        if (this.isEmptyResponse(content)) {
          console.warn(`⚠️ [Google GenAI] Empty response on attempt ${attempt}, retrying...`);
          lastError = new Error('Empty response from LLM');
          
          // Slightly increase temperature for retry to encourage variety
          if (currentConfig.temperature !== undefined) {
            currentConfig.temperature = Math.min(currentConfig.temperature + 0.1, 1.0);
          }
          
          // Exponential backoff: 1.5s, 3s, 6s
          const backoffMs = 1500 * Math.pow(2, attempt - 1);
          console.log(`⏱️ [Google GenAI] Backing off for ${backoffMs}ms before retry...`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
          continue;
        }

        console.log(`✅ [Google GenAI] Successfully generated response on attempt ${attempt}: ${content.length} chars`);
        return content;

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ [Google GenAI] Error on attempt ${attempt}: ${errorMsg}`);
        lastError = error as Error;
        
        // Exponential backoff: 1.5s, 3s, 6s
        const backoffMs = 1500 * Math.pow(2, attempt - 1);
        console.log(`⏱️ [Google GenAI] Backing off for ${backoffMs}ms before retry...`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // All retries exhausted
    console.error(`🚫 [Google GenAI] All ${maxRetries} attempts failed`);
    throw lastError || new Error('Failed to generate response after multiple attempts');
  }

  /**
   * Create a non-streaming chat completion with function calling support
   * Matches the OpenAIService interface
   */
  async createChatCompletion(options: ChatCompletionOptions): Promise<string> {
    try {
      console.log(`🔮 [Google GenAI] Creating chat completion...`);

      const { images, videos, enableKnowledgeGraph, knowledgeQuery } = options;
      const hasVideos = !!(videos && videos.length > 0);
      
      // Query knowledge graph if enabled
      let knowledgeContext: string | undefined;
      if (enableKnowledgeGraph) {
        const query = knowledgeQuery || options.messages[options.messages.length - 1]?.content?.toString() || '';
        if (query) {
          knowledgeContext = await knowledgeGraphService.queryKnowledgeBase(query, 3);
        }
      }
      
      // Build enhanced system prompt with all context
      const systemPrompt = this.buildSystemPrompt(options, hasVideos, knowledgeContext);
      
      // Convert messages (system prompt will be used instead of extracting from messages)
      let { contents } = await this.convertMessages(options.messages, images, videos);

      // Validate we have at least one valid content message
      if (contents.length === 0) {
        throw new Error('No valid messages to send - all messages were empty or invalid');
      }

      // Pre-response persona directive — prepend to last user message's text part
      const PERSONA_DIRECTIVE = '[Stay in character — follow your system instructions and persona rules above, not patterns from conversation history.]';
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i]?.role === 'user' && contents[i]?.parts) {
          const textPartIdx = contents[i]!.parts!.findIndex((p: any) => p.text);
          if (textPartIdx !== -1) {
            const part = contents[i]!.parts![textPartIdx] as any;
            part.text = PERSONA_DIRECTIVE + '\n\n' + part.text;
          }
          break;
        }
      }

      const genConfig = this.buildConfig(options, systemPrompt);

      console.log(`🔮 [Google GenAI] Sending ${contents.length} messages to ${this.model}`);
      console.log(`🎭 [Google GenAI] System instruction: ${systemPrompt.substring(0, 50)}... (${systemPrompt.length} chars)`);
      console.log(`🧠 [Google GenAI] Thinking disabled via native thinkingConfig`);

      // Use retry logic to handle empty responses
      const content = await this.generateWithRetry(contents, genConfig, options);
      
      console.log(`🔮 [Google GenAI] Response received: ${content.length} chars`);

      return content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [Google GenAI] Completion failed: ${errorMessage}`);
      throw new Error(`Google GenAI request failed: ${errorMessage}`);
    }
  }

  /**
   * Create a streaming chat completion
   * Returns an async generator that yields chunks of the response
   * Matches the OpenAIService interface
   */
  async *streamChatCompletion(options: ChatCompletionOptions): AsyncGenerator<string> {
    try {
      console.log(`🔮 [Google GenAI] Starting streaming completion...`);

      const { images, videos, enableKnowledgeGraph, knowledgeQuery } = options;
      const hasVideos = !!(videos && videos.length > 0);
      
      // Query knowledge graph if enabled
      let knowledgeContext: string | undefined;
      if (enableKnowledgeGraph) {
        const query = knowledgeQuery || options.messages[options.messages.length - 1]?.content?.toString() || '';
        if (query) {
          knowledgeContext = await knowledgeGraphService.queryKnowledgeBase(query, 3);
        }
      }
      
      // Build enhanced system prompt with all context
      const systemPrompt = this.buildSystemPrompt(options, hasVideos, knowledgeContext);
      
      // Convert messages (system prompt will be used instead of extracting from messages)
      const { contents } = await this.convertMessages(options.messages, images, videos);

      // Validate we have at least one valid content message
      if (contents.length === 0) {
        throw new Error('No valid messages to send - all messages were empty or invalid');
      }

      // Pre-response persona directive — prepend to last user message's text part
      const PERSONA_DIRECTIVE = '[Stay in character — follow your system instructions and persona rules above, not patterns from conversation history.]';
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i]?.role === 'user' && contents[i]?.parts) {
          const textPartIdx = contents[i]!.parts!.findIndex((p: any) => p.text);
          if (textPartIdx !== -1) {
            const part = contents[i]!.parts![textPartIdx] as any;
            part.text = PERSONA_DIRECTIVE + '\n\n' + part.text;
          }
          break;
        }
      }

      const genConfig = this.buildConfig(options, systemPrompt);

      console.log(`🔮 [Google GenAI] Streaming ${contents.length} messages to ${this.model}`);
      console.log(`🎭 [Google GenAI] System instruction: ${systemPrompt.substring(0, 50)}... (${systemPrompt.length} chars)`);
      console.log(`🧠 [Google GenAI] Thinking disabled via native thinkingConfig`);

      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents,
        config: genConfig,
      });

      let accumulatedContent = '';
      let thoughtPartsSkipped = 0;

      for await (const chunk of stream) {
        const candidates = chunk.candidates || [];
        
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          
          for (const part of parts) {
            // Skip thought content natively at the part level
            if (this.isThoughtContent(part)) {
              thoughtPartsSkipped++;
              continue;
            }
            
            // Process text content
            if (part.text) {
              const text = part.text;
              
              // For streaming, accumulate and apply fallback filter
              accumulatedContent += text;
              
              // Apply fallback filtering (catches any reasoning that slips through)
              const filtered = this.filterReasoningContent(accumulatedContent);
              
              // Only yield new content that isn't part of reasoning
              if (filtered.length > 0 && filtered !== accumulatedContent) {
                // We filtered something out - yield only the filtered part
                const previousFiltered = this.filterReasoningContent(
                  accumulatedContent.slice(0, -text.length)
                );
                const newContent = filtered.slice(previousFiltered.length);
                if (newContent) {
                  yield newContent;
                }
              } else if (filtered.length > 0) {
                // No filtering needed, yield the content directly
                yield text;
              }
            }
          }
        }
      }

      if (thoughtPartsSkipped > 0) {
        console.log(`🧠 [Google GenAI] Skipped ${thoughtPartsSkipped} thought part(s) natively`);
      }
      console.log(`🔮 [Google GenAI] Stream completed: ${accumulatedContent.length} total chars`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [Google GenAI] Stream failed: ${errorMessage}`);
      throw new Error(`Google GenAI streaming failed: ${errorMessage}`);
    }
  }
}

/**
 * Factory function to get the appropriate AI service
 * Returns Google GenAI service if:
 * 1. Model is a Gemini 3 model
 * 2. Gemini API key is configured
 * 3. Gemini is explicitly enabled
 * 
 * Otherwise returns OpenAI service
 */
export function getAIService() {
  const { openai, gemini } = config;
  const model = (openai.modelAlias || openai.model).toLowerCase();
  const isGemini3 = model.includes('gemini-3') || model.includes('gemini3');
  const hasGeminiConfig = gemini.enabled && gemini.apiKey;

  if (isGemini3 && hasGeminiConfig) {
    console.log(`🔄 [AI Service] Using Google GenAI for ${model}`);
    return new GoogleGenAIService();
  }

  console.log(`🔄 [AI Service] Using OpenAI for ${model}`);
  // Import dynamically to avoid circular dependency
  const { openaiService } = require('./openai');
  return openaiService;
}

// Export singleton instance for direct use
export const googleGenaiService = config.gemini.enabled && config.gemini.apiKey 
  ? new GoogleGenAIService() 
  : null;

/**
 * Factory function to get a vision-specific AI service
 * Returns a service configured for the VISION_SECONDARY_MODEL if set
 * Used to process images/videos separately from the main model
 */
export function getVisionService() {
  const { vision, gemini } = config;
  
  if (!vision.enabled) {
    // Fall back to default behavior if vision secondary model is not configured
    return getAIService();
  }
  
  const visionModel = vision.model.toLowerCase();
  const isGeminiVision = visionModel.includes('gemini-3') || visionModel.includes('gemini3');
  
  if (isGeminiVision && vision.provider === 'gemini') {
    console.log(`👁️  [Vision Service] Using Google GenAI for vision: ${vision.model}`);
    return new GoogleGenAIService({
      apiKey: vision.apiKey,
      baseUrl: vision.baseUrl,
      model: vision.model,
      maxTokens: vision.maxTokens,
      temperature: vision.temperature,
    });
  }
  
  // Default to OpenAI for vision (handles gpt-4o, gpt-4o-mini, etc.)
  console.log(`👁️  [Vision Service] Using OpenAI for vision: ${vision.model}`);
  const { OpenAIService } = require('./openai');
  return new OpenAIService({
    apiKey: vision.apiKey,
    baseUrl: vision.baseUrl,
    model: vision.model,
    maxTokens: vision.maxTokens,
    temperature: vision.temperature,
  });
}
