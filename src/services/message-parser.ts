import { userMemoryService, type ExtractedMention } from './user-memory';

// Patterns for detecting pronoun declarations
const PRONOUN_PATTERNS = [
  // Direct pronoun statements
  /(?:i\s+(?:go\s+by|use|prefer)\s+)(she\/her|he\/him|they\/them|she\/they|he\/they|it\/its|xe\/xem|ze\/zir|ey\/em)/i,
  /(?:my\s+pronouns?\s+(?:are|is)\s+)(she\/her|he\/him|they\/them|she\/they|he\/they|it\/its|xe\/xem|ze\/zir|ey\/em)/i,
  /(?:call\s+me\s+)(she\/her|he\/him|they\/them|she\/they|he\/they|it\/its|xe\/xem|ze\/zir|ey\/em)/i,
  // Less formal patterns
  /(?:i'm\s+)(she\/her|he\/him|they\/them|she\/they|he\/they|it\/its)/i,
  /(?:pronouns?:?\s*)(she\/her|he\/him|they\/them|she\/they|he\/they|it\/its|xe\/xem|ze\/zir|ey\/em)/i,
];

// Patterns for extracting third-person references
const THIRD_PERSON_PATTERNS = [
  // "she thinks you're cool" / "he said that..." / "they mentioned..."
  /\b(she|he|they|it)\s+(?:thinks?|said|mentioned|told|believes?|feels?|knows?)/i,
  // "@user is a great person" / "@user always..."
  /(?:^|\s)(\w+)\s+(?:is|was|has|always|never|really|actually)\s+/i,
];

export interface ParsedMessage {
  pronouns: string | null;
  mentions: ExtractedMention[];
  hasMentions: boolean;
}

/**
 * Extract pronouns from message content
 */
export function extractPronouns(content: string): string | null {
  for (const pattern of PRONOUN_PATTERNS) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const pronouns = match[1].toLowerCase();
      console.log(`📝 [PARSER] Detected pronouns: ${pronouns}`);
      return pronouns;
    }
  }
  return null;
}

/**
 * Extract mentions and surrounding context
 */
export function extractMentionsWithContext(
  content: string, 
  mentionedUsers: Map<string, string>,
  authorUsername: string
): ExtractedMention[] {
  const mentions: ExtractedMention[] = [];
  const timestamp = new Date().toISOString();
  
  // Find Discord mention patterns: <@USER_ID> or <@!USER_ID>
  const mentionPattern = /<@!?(\d+)>/g;
  let match: RegExpExecArray | null;
  
  while ((match = mentionPattern.exec(content)) !== null) {
    const userId = match[1];
    if (!userId) continue;
    
    const username = mentionedUsers.get(userId);
    
    if (!username) {
      console.log(`📝 [PARSER] Mentioned user ${userId} not in provided map`);
      continue;
    }
    
    // Extract context around the mention (sentence containing the mention)
    const mentionIndex = match.index;
    const context = extractSentenceContext(content, mentionIndex);
    
    // Clean the mention from the context for storage
    const cleanContext = context.replace(/<@!?\d+>/g, username);
    
    mentions.push({
      userId: userId,
      username: username,
      context: cleanContext,
      mentionedBy: authorUsername,
      timestamp: timestamp,
    });
    
    console.log(`📝 [PARSER] Extracted mention context for ${username}: "${cleanContext.substring(0, 50)}..."`);
  }
  
  return mentions;
}

/**
 * Extract the sentence or phrase containing a specific index
 */
function extractSentenceContext(content: string, index: number): string {
  // Find sentence boundaries (period, exclamation, question mark, or newline)
  const sentenceEnders = /[.!?\n]/;
  
  // Look backwards for start of sentence
  let start = index;
  while (start > 0 && !sentenceEnders.test(content[start - 1] || '')) {
    start--;
  }
  
  // Look forwards for end of sentence
  let end = index;
  while (end < content.length && !sentenceEnders.test(content[end] || '')) {
    end++;
  }
  
  // Include the sentence terminator
  if (end < content.length) {
    end++;
  }
  
  // Clean up whitespace
  let context = content.substring(start, end).trim();
  
  // If context is too short, try to get more context (previous sentence)
  if (context.length < 20 && start > 0) {
    const prevContext = extractSentenceContext(content.substring(0, start), start - 1);
    context = prevContext + ' ' + context;
  }
  
  return context.trim();
}

/**
 * Check if a message is talking about someone using third-person pronouns
 */
export function detectThirdPersonReference(content: string): boolean {
  for (const pattern of THIRD_PERSON_PATTERNS) {
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a complete message and extract all relevant information
 */
export function parseMessage(
  content: string,
  mentionedUsers: Map<string, string>,
  authorUsername: string
): ParsedMessage {
  console.log(`📝 [PARSER] Parsing message from ${authorUsername}`);
  
  // Extract pronouns
  const pronouns = extractPronouns(content);
  
  // Extract mentions with context
  const mentions = extractMentionsWithContext(content, mentionedUsers, authorUsername);
  
  const result: ParsedMessage = {
    pronouns: pronouns,
    mentions: mentions,
    hasMentions: mentions.length > 0,
  };
  
  console.log(`📝 [PARSER] Parsed: pronouns=${pronouns || 'none'}, mentions=${mentions.length}`);
  
  return result;
}

/**
 * Store extracted information from message parsing
 */
export function storeParsedInformation(
  authorId: string,
  authorUsername: string,
  parsed: ParsedMessage
): void {
  // Store author's pronouns if detected
  if (parsed.pronouns) {
    userMemoryService.storePronouns(authorId, authorUsername, parsed.pronouns);
  }
  
  // Store third-party context for mentioned users
  for (const mention of parsed.mentions) {
    // Skip if the mention is just mentioning themselves
    if (mention.userId === authorId) {
      continue;
    }
    
    userMemoryService.storeThirdPartyContext(mention);
  }
}
