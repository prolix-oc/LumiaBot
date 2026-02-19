import { getAIService, getVisionService } from './google-genai';
import { parseMessage, storeParsedInformation } from './message-parser';
import { conversationHistoryService } from './conversation-history';
import { getTriggerKeywords, getErrorMessage } from './prompts';
import { config } from '../utils/config';
import type { MusicActivity } from './user-activity';

// Keywords that trigger the bot (case insensitive)
// Loaded dynamically from prompt_storage/config/triggers.json
let TRIGGER_KEYWORDS: string[] = [];
let SEARCH_INTENT_PATTERNS: string[] = [];
let KNOWLEDGE_INTENT_PATTERNS: string[] = [];

// Initialize trigger keywords
function initializeTriggers(): void {
  const triggers = getTriggerKeywords();
  TRIGGER_KEYWORDS = triggers.botMention;
  SEARCH_INTENT_PATTERNS = triggers.searchIntent;
  KNOWLEDGE_INTENT_PATTERNS = triggers.knowledgeIntent;
}

// Load triggers on module initialization
initializeTriggers();

/**
 * Check if a message should trigger the bot response
 * @param content - The message content
 * @param botId - The bot's user ID
 * @param botMention - The bot's mention string
 * @returns boolean indicating if bot should respond
 */
export function shouldTriggerBot(content: string, botId: string): boolean {
  const lowerContent = content.toLowerCase().trim();

  // Check if bot is mentioned
  const mentionPattern = new RegExp(`<@!?${botId}>`);
  if (mentionPattern.test(content)) {
    return true;
  }

  // Check for trigger keywords (only match whole words/phrases)
  for (const keyword of TRIGGER_KEYWORDS) {
    // Escape special regex characters in keyword
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Create pattern that matches the keyword as a whole word/phrase
    const pattern = new RegExp(`\\b${escapedKeyword}\\b`, 'i');
    if (pattern.test(lowerContent)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract all trigger keywords found in the message content
 * @param content - The message content
 * @returns Array of matched trigger keywords
 */
export function extractTriggerKeywords(content: string): string[] {
  const lowerContent = content.toLowerCase().trim();
  const matched: string[] = [];

  for (const keyword of TRIGGER_KEYWORDS) {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedKeyword}\\b`, 'i');
    if (pattern.test(lowerContent)) {
      matched.push(keyword);
    }
  }

  return matched;
}

/**
 * Detect if the user is asking for web search based on message content
 * Uses heuristics to determine search intent
 * @param content - The message content
 * @returns boolean indicating if web search should be enabled
 */
export function detectSearchIntent(content: string): boolean {
  const lowerContent = content.toLowerCase().trim();
  
  for (const pattern of SEARCH_INTENT_PATTERNS) {
    // Create regex to match the pattern as a word or phrase
    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedPattern}\\b`, 'i');
    
    if (regex.test(lowerContent)) {
      console.log(`🔍 [HEURISTIC] Search intent detected: "${pattern}"`);
      return true;
    }
  }
  
  return false;
}

/**
 * Detect if the user is asking about domain-specific knowledge
 * Uses heuristics to determine knowledge graph query intent
 * @param content - The message content
 * @returns boolean indicating if knowledge graph should be queried
 */
export function detectKnowledgeIntent(content: string): boolean {
  const lowerContent = content.toLowerCase().trim();
  
  for (const pattern of KNOWLEDGE_INTENT_PATTERNS) {
    // Create regex to match the pattern as a word or phrase
    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedPattern}\\b`, 'i');
    
    if (regex.test(lowerContent)) {
      console.log(`📚 [HEURISTIC] Knowledge intent detected: "${pattern}"`);
      return true;
    }
  }
  
  return false;
}

/**
 * Extract the message content without the bot mention
 * @param content - The message content
 * @param botId - The bot's user ID
 * @returns The cleaned message content
 */
export function extractMessageContent(content: string, botId: string): string {
  let cleaned = content;
  
  // Remove bot mentions
  const mentionPattern = new RegExp(`<@!?${botId}>`, 'g');
  cleaned = cleaned.replace(mentionPattern, '').trim();
  
  // Remove trigger keywords from the beginning of the message
  const lowerCleaned = cleaned.toLowerCase();
  for (const keyword of TRIGGER_KEYWORDS) {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedKeyword}[,!]?\\s*`, 'i');
    if (pattern.test(lowerCleaned)) {
      cleaned = cleaned.replace(pattern, '').trim();
      break; // Only remove the first matching keyword
    }
  }
  
  return cleaned;
}

export interface MessageHandlerOptions {
  content: string;
  enableSearch?: boolean;
  enableKnowledgeGraph?: boolean;
  imageUrls?: string[];
  videoUrls?: { url: string; mimeType?: string }[]; // Video attachments for Gemini 3 models
  textAttachments?: { name: string; content: string }[]; // Text file attachments
  userId?: string;
  username?: string;
  guildId: string;
  mentionedUsers?: Map<string, string>; // userId -> username mapping for users mentioned in current message
  replyContext?: { // Context when user is replying to Lumia's message
    isReply: boolean;
    originalContent?: string;
    originalTimestamp?: string;
  };
  boredomAction?: 'opted-in' | 'opted-out'; // If user just changed their boredom settings
  channelHistory?: string; // Recent channel conversation context
  getUserListeningActivity?: (userId: string) => Promise<MusicActivity | null>;
  // Orchestrator follow-up support
  orchestratorEventId?: string;
  requestFollowUp?: (eventId: string, targetBotId?: string, reason?: string) => Promise<{ approved: boolean; reason: string }>;
}

export interface MessageHandlerResponse {
  text: string;
  reactions: string[];
}

/**
 * Extract reactions from AI response
 * Looks for [REACT: emoji] tags in the response
 */
function extractReactions(response: string): { text: string; reactions: string[] } {
  const reactions: string[] = [];
  
  // Match [REACT: emoji] or [REACT:emoji] patterns
  const reactPattern = /\[REACT:\s*([^\]]+)\]/gi;
  let match;
  
  while ((match = reactPattern.exec(response)) !== null) {
    if (match[1]) {
      const emoji = match[1].trim();
      if (emoji) {
        reactions.push(emoji);
      }
    }
  }
  
  // Remove the reaction tags from the text
  const text = response.replace(reactPattern, '').trim();
  
  // Clean up any extra whitespace left behind
  const cleanedText = text.replace(/\n{3,}/g, '\n\n').trim();
  
  return { text: cleanedText, reactions };
}

/**
 * Process vision content (images/videos) using a secondary vision model
 * Returns a description that can be fed into the main text model
 */
async function processVisionContent(
  content: string,
  imageUrls?: string[],
  videoUrls?: { url: string; mimeType?: string }[]
): Promise<string> {
  if (!config.vision.enabled) {
    return content;
  }
  
  const hasImages = imageUrls && imageUrls.length > 0;
  const hasVideos = videoUrls && videoUrls.length > 0;
  
  if (!hasImages && !hasVideos) {
    return content;
  }
  
  console.log(`👁️  [Vision] Processing ${hasImages ? imageUrls!.length : 0} image(s) and ${hasVideos ? videoUrls!.length : 0} video(s) with secondary model...`);
  
  try {
    const visionService = getVisionService();
    const visionPrompt = `${config.vision.promptPrefix}\n\nUser message: "${content}"`;
    
    // Create a minimal conversation for vision processing
    const visionMessages = [
      {
        role: 'user' as const,
        content: visionPrompt,
      },
    ];
    
    const visionDescription = await visionService.createChatCompletion({
      messages: visionMessages,
      images: imageUrls,
      videos: videoUrls,
      maxTokens: config.vision.maxTokens,
      temperature: config.vision.temperature,
    });
    
    console.log(`👁️  [Vision] Description received (${visionDescription.length} chars)`);
    
    // Combine the original content with the vision description
    const combinedContent = `[Vision Analysis]: ${visionDescription}\n\n[Original User Message]: ${content}`;
    
    return combinedContent;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ [Vision] Failed to process vision content: ${errorMessage}`);
    // Fall back to original content if vision processing fails
    return content;
  }
}

/**
 * Handle a message that triggered the bot
 * @param options - Message handling options
 * @returns The bot's response with potential reactions
 */
export async function handleMessage(options: MessageHandlerOptions): Promise<MessageHandlerResponse> {
  const { content, enableSearch, enableKnowledgeGraph, imageUrls, videoUrls, textAttachments, userId, username, guildId, mentionedUsers, replyContext, boredomAction, channelHistory, getUserListeningActivity, orchestratorEventId, requestFollowUp } = options;

  try {
    // Parse message for pronouns and mentions BEFORE processing
    if (userId && username) {
      const userMap = mentionedUsers || new Map<string, string>();
      const parsed = parseMessage(content, userMap, username);

      // Store extracted information
      storeParsedInformation(userId, username, parsed);

      if (parsed.pronouns) {
        console.log(`📝 [HANDLER] Stored pronouns for ${username}: ${parsed.pronouns}`);
      }

      if (parsed.hasMentions) {
        console.log(`📝 [HANDLER] Stored ${parsed.mentions.length} third-party reference(s)`);
      }
    }

    // If search not explicitly provided, detect using heuristics
    const shouldSearch = enableSearch !== undefined ? enableSearch : detectSearchIntent(content);
    // If knowledge graph not explicitly provided, detect using heuristics
    const shouldQueryKnowledge = enableKnowledgeGraph !== undefined ? enableKnowledgeGraph : detectKnowledgeIntent(content);

    if (shouldSearch) {
      console.log(`🔍 [HANDLER] Web search will be enabled for this message`);
    } else {
      console.log(`🔍 [HANDLER] Web search will NOT be enabled (no search intent detected)`);
    }

    if (shouldQueryKnowledge) {
      console.log(`📚 [HANDLER] Knowledge graph will be queried for this message`);
    } else {
      console.log(`📚 [HANDLER] Knowledge graph will NOT be queried (no knowledge intent detected)`);
    }

    // Log if multimodal (images or videos)
    if (imageUrls && imageUrls.length > 0) {
      console.log(`🖼️  [HANDLER] Multimodal request with ${imageUrls.length} image(s)`);
    }
    if (videoUrls && videoUrls.length > 0) {
      console.log(`🎥 [HANDLER] Video content detected: ${videoUrls.length} video(s)`);
    }

    // Log user info for memory
    if (userId && username) {
      console.log(`💭 [HANDLER] User context: ${username} (${userId})`);
    }

    // Determine if this is a vision request
    const hasImages = imageUrls && imageUrls.length > 0;
    const hasVideos = videoUrls && videoUrls.length > 0;
    const isVisionRequest = hasImages || hasVideos;
    
    // Process vision content if secondary model is configured
    let processedContent = content;
    let processedImages = imageUrls;
    let processedVideos = videoUrls;
    
    if (isVisionRequest && config.vision.enabled) {
      processedContent = await processVisionContent(content, imageUrls, videoUrls);
      // Don't pass images/videos to main model since vision model already processed them
      processedImages = undefined;
      processedVideos = undefined;
    }

    // Add user message to conversation history (use processed content if vision was used)
    if (userId && username) {
      conversationHistoryService.addMessage(userId, guildId, username, 'user', processedContent);
    }

    // Get conversation history for context
    const conversationHistory = userId 
      ? conversationHistoryService.getHistory(userId, guildId)
      : [];

    const aiService = getAIService();
    const response = await aiService.createChatCompletion({
      messages: conversationHistory,
      enableSearch: shouldSearch,
      enableKnowledgeGraph: shouldQueryKnowledge,
      knowledgeQuery: processedContent, // Use processed content for knowledge query
      images: processedImages, // Only pass images if not using vision secondary model
      videos: processedVideos, // Only pass videos if not using vision secondary model
      textAttachments,
      userId,
      username,
      guildId,
      mentionedUsers,
      replyContext,
      boredomAction,
      channelHistory,
      getUserListeningActivity,
      orchestratorEventId,
      requestFollowUp,
    });

    // Extract reactions from the response
    const { text, reactions } = extractReactions(response);
    
    if (reactions.length > 0) {
      console.log(`😀 [HANDLER] Extracted ${reactions.length} reaction(s): ${reactions.join(', ')}`);
    }

    // Store assistant response (without reaction tags) in conversation history
    if (userId && username) {
      conversationHistoryService.addMessage(userId, guildId, username, 'assistant', text);
    }

    return { text, reactions };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ [HANDLER] ${errorMessage}`);
    
    // Provide more specific error messages using dynamic templates
    if (errorMessage.includes('Failed to generate response after multiple attempts') || 
        errorMessage.includes('Failed to generate response')) {
      return {
        text: getErrorMessage('multiple_attempts_failure'),
        reactions: []
      };
    } else if (errorMessage.includes('Empty response')) {
      return {
        text: getErrorMessage('empty_response'),
        reactions: []
      };
    }
    
    return {
      text: getErrorMessage('generic_error'),
      reactions: []
    };
  }
}