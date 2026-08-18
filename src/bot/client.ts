import { AttachmentBuilder, Client, Collection, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel, GuildMember, StickerFormatType, userMention, type Channel } from 'discord.js';
import { config } from '../utils/config';
import { shouldTriggerBot, extractMessageContent, handleMessage, extractTriggerKeywords } from '../services/message-handler';
import { boredomService, getRandomBoredomMessage } from '../services/boredom';
import { channelHistoryService } from '../services/channel-history';
import { getBotCouncilProfile, getErrorMessage, getTriggerKeywords } from '../services/prompts';
import { userActivityService } from '../services/user-activity';
import { userMemoryService } from '../services/user-memory';
import { pageExtractorService } from '../services/page-extractor';
import { knowledgeGraphService } from '../services/knowledge-graph';
import { formatDiscordResponseText } from '../utils/discord-markdown';
import type { ChatInputCommandInteraction } from 'discord.js';
import { LumiaBotIntegration } from '../services/orchestrator';
import { orchestratorTurnJournal } from '../services/orchestrator/turn-journal';
import type { MessageContext, ReplyContext, MediaAttachment, TextAttachment, ResponseRequestPayload, CollectiveKnowledgeResultPayload } from '../services/orchestrator/types';
import type { ResolvedUserMention, ResolveUserMention } from '../services/user-mention-resolver';
import type { GeneratedImageAttachment } from '../services/swarmui';

export interface Command {
  data: {
    name: string;
    description: string;
    toJSON: () => unknown;
  };
  ownerOnly?: boolean;
  ownerOnlySubcommands?: readonly string[];
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

interface OrchestratorQueuedInfo {
  message: Message;
  replyContext?: ReplyContext;
  imageUrls: string[];
  videoUrls: MediaAttachment[];
  textAttachments: TextAttachment[];
}

/**
 * Categorize stickers on a Discord message for the AI pipeline.
 * PNG/APNG stickers go to image inputs (APNG only renders frame 1 in vision models, but
 * the sticker name covers the animation intent). GIF stickers go to the video pipeline
 * so they hit the same GIF→WebM conversion path as regular GIF attachments. Lottie
 * stickers are JSON vector animations — nothing rasterizes them server-side, so we fall
 * back to a text hint using the sticker name. Every sticker also contributes a name hint
 * so the bot has context even when the media can't be ingested.
 */
function extractStickerMedia(
  message: Message,
  logPrefix: string,
): {
  imageUrls: string[];
  videoUrls: { url: string; mimeType?: string }[];
  stickerHints: string[];
} {
  const imageUrls: string[] = [];
  const videoUrls: { url: string; mimeType?: string }[] = [];
  const stickerHints: string[] = [];

  if (message.stickers.size === 0) {
    return { imageUrls, videoUrls, stickerHints };
  }

  for (const sticker of message.stickers.values()) {
    const name = sticker.name || 'unnamed';
    switch (sticker.format) {
      case StickerFormatType.GIF:
        videoUrls.push({ url: sticker.url, mimeType: 'image/gif' });
        stickerHints.push(`[Animated sticker: ${name}]`);
        console.log(`🎬 [${logPrefix}] GIF sticker: ${name} (${sticker.url})`);
        break;
      case StickerFormatType.APNG:
        imageUrls.push(sticker.url);
        stickerHints.push(`[Animated sticker: ${name}]`);
        console.log(`🖼️  [${logPrefix}] APNG sticker: ${name} (${sticker.url})`);
        break;
      case StickerFormatType.PNG:
        imageUrls.push(sticker.url);
        stickerHints.push(`[Sticker: ${name}]`);
        console.log(`🖼️  [${logPrefix}] PNG sticker: ${name} (${sticker.url})`);
        break;
      case StickerFormatType.Lottie:
        stickerHints.push(`[Lottie sticker: ${name}]`);
        console.log(`✨ [${logPrefix}] Lottie sticker (name-only, no raster): ${name}`);
        break;
      default:
        stickerHints.push(`[Sticker: ${name}]`);
        console.log(`❓ [${logPrefix}] Unknown sticker format (${sticker.format}): ${name}`);
    }
  }

  return { imageUrls, videoUrls, stickerHints };
}

/**
 * Extract custom emoji CDN URLs from message content so the AI model can see them.
 * Custom emojis appear as <:name:id> (static) or <a:name:id> (animated).
 */
function extractCustomEmojiUrls(content: string, logPrefix: string): string[] {
  const emojiRegex = /<(a?):(\w+):(\d+)>/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = emojiRegex.exec(content)) !== null) {
    const animated = match[1] === 'a';
    const name = match[2];
    const id = match[3];
    const ext = animated ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=96&quality=lossless`;
    urls.push(url);
    console.log(`😀 [${logPrefix}] Custom emoji: :${name}: (${url})`);
  }

  return urls;
}

// Patterns for detecting boredom opt-in/opt-out intent
// OPT-IN MODEL: Users are disabled by default and must EXPLICITLY request boredom pings
// These patterns are STRICT - they require explicit mentions of wanting pings when bored
const BOREDOM_OPT_OUT_PATTERNS = [
  /\b(?:don't|stop|quit|no\s+more)\s+(?:ping|bother|annoy|message)\s+me\b/i,
  /\b(?:leave\s+me\s+alone|go\s+away|shut\s+up)\b/i,
  /\b(?:disable|turn\s+off)\s+(?:boredom|ping)s?\b/i,
  /\bopt\s*out\s+(?:of\s+)?(?:boredom|ping)s?\b/i,
];

// STRICT OPT-IN PATTERNS - Must explicitly mention "when you're bored" or similar
const BOREDOM_OPT_IN_PATTERNS = [
  // Must include "when you're bored" or equivalent
  /\b(?:ping|message|@|at)\s+me\s+when\s+(?:you(?:'re?|are)\s+)?bored\b/i,
  /\b(?:let\s+me\s+know|tell\s+me|reach\s+out|talk\s+to\s+me)\s+when\s+(?:you(?:'re?|are)\s+)?bored\b/i,
  /\bkeep\s+me\s+company\s+when\s+(?:you(?:'re?|are)\s+)?bored\b/i,
  // Explicit opt-in commands
  /\b(?:enable|turn\s+on)\s+(?:boredom\s+)?pings?\b/i,
  /\bopt\s*in\s+(?:to\s+)?(?:boredom|ping)s?\b/i,
];

/**
 * Detect if user wants to opt out of boredom pings
 */
function detectBoredomOptOut(content: string): boolean {
  for (const pattern of BOREDOM_OPT_OUT_PATTERNS) {
    if (pattern.test(content)) {
      console.log(`😴 [BOREDOM] Opt-out pattern matched: ${pattern.source}`);
      return true;
    }
  }
  return false;
}

/**
 * Detect if user wants to opt in to boredom pings
 */
function detectBoredomOptIn(content: string): boolean {
  for (const pattern of BOREDOM_OPT_IN_PATTERNS) {
    if (pattern.test(content)) {
      console.log(`😴 [BOREDOM] Opt-in pattern matched: ${pattern.source}`);
      return true;
    }
  }
  return false;
}

/**
 * Format time ago from a date
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

function isReplyReferenceFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: number | string;
    message?: string;
    rawError?: { code?: number | string; message?: string };
  };

  const code = typeof candidate.code === 'number'
    ? candidate.code
    : typeof candidate.rawError?.code === 'number'
      ? candidate.rawError.code
      : undefined;

  const message = `${candidate.message || ''} ${candidate.rawError?.message || ''}`;

  return code === 10008 || message.includes('Unknown Message');
}

function getMessageAuthorDisplayName(message: Message): string {
  return message.member?.displayName || message.author.displayName || message.author.username;
}

function getMentionedUserDisplayMap(message: Message): Map<string, string> {
  const mentionedUsers = new Map<string, string>();

  if (message.mentions.members && message.mentions.members.size > 0) {
    message.mentions.members.forEach((member) => {
      mentionedUsers.set(member.id, member.displayName || member.user.displayName || member.user.username);
    });
  }

  message.mentions.users.forEach((user) => {
    if (!mentionedUsers.has(user.id)) {
      mentionedUsers.set(user.id, user.displayName || user.username);
    }
  });

  return mentionedUsers;
}

function buildAllowedMentions(userIds: Iterable<string>) {
  return {
    parse: [],
    users: Array.from(new Set(userIds)),
    repliedUser: false,
  };
}

function buildDiscordImageFiles(attachments: GeneratedImageAttachment[]): AttachmentBuilder[] {
  return attachments.map((attachment) => new AttachmentBuilder(attachment.data, {
    name: attachment.name,
  }));
}

function isDiscordNsfwChannel(channel: Message['channel'] | Channel | null | undefined): boolean {
  if (!channel) {
    return false;
  }

  if ('nsfw' in channel && channel.nsfw === true) {
    return true;
  }

  if (channel instanceof ThreadChannel && channel.parent && 'nsfw' in channel.parent) {
    return channel.parent.nsfw === true;
  }

  return false;
}

function canUserRequestNsfwImages(channel: Message['channel'], userId?: string): boolean {
  // NSFW image generation always requires an NSFW-marked channel.
  if (!isDiscordNsfwChannel(channel)) {
    return false;
  }

  // When the bot is globally locked to NSFW channels, the channel gate alone is
  // sufficient — every responder is already in an age-restricted space, so any
  // user may request NSFW image generation (no owner check needed).
  if (config.bot.nsfwOnly) {
    return true;
  }

  // Otherwise, NSFW image generation stays owner-only.
  return !!userId && userId === config.bot.ownerId;
}

export class DiscordBot {
  public client: Client;
  public commands: Collection<string, Command>;
  private typingIntervals: Map<string, Timer>; // channelId -> timer
  private orchestrator?: LumiaBotIntegration;
  private orchestratorQueue: Map<string, OrchestratorQueuedInfo>; // eventId -> message info
  private channelProcessingQueue: Map<string, Promise<void>>; // per-channel sequential processing
  private processedMessageIds: Set<string>; // duplicate event guard
  private processedMessageTimers: Map<string, Timer>; // TTL cleanup for processedMessageIds
  private repliedMessageIds: Set<string>; // cross-path guard: prevents double replies regardless of trigger path
  private activeGenerationKeys: Set<string>; // in-flight generation guard
  private recentGenerationKeys: Set<string>; // short TTL generation guard

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
      ],
    });

    this.commands = new Collection();
    this.typingIntervals = new Map();
    this.orchestratorQueue = new Map();
    this.channelProcessingQueue = new Map();
    this.processedMessageIds = new Set();
    this.processedMessageTimers = new Map();
    this.repliedMessageIds = new Set();
    this.activeGenerationKeys = new Set();
    this.recentGenerationKeys = new Set();
    this.setupEventHandlers();
    this.setupOrchestrator();
  }

  private buildOrchestratorContextNote(context: MessageContext): string | undefined {
    const lines: string[] = [];
    const councilName = context.councilFamilyName || config.orchestrator.councilName || config.orchestrator.familyName;

    if (councilName) {
      lines.push(`You are participating in the ${councilName} council. Cooperate with other council members as distinct bots with complementary perspectives, not necessarily as family or siblings.`);
    }

    if (context.sessionMode) {
      lines.push(`Session mode: ${context.sessionMode}.`);
    }

    if (context.sessionPhase) {
      lines.push(`Session phase: ${context.sessionPhase}.`);
    }

    lines.push(`You are on turn ${context.turnCount + 1} of up to ${context.maxTurns}.`);

    if (context.replyingToBotName) {
      lines.push(`You are directly replying to ${context.replyingToBotName}.`);
      lines.push(`Treat this as bot-to-bot dialogue first: address ${context.replyingToBotName}'s point before circling back to any human.`);
    }

    if (context.nearbyBots && context.nearbyBots.length > 0) {
      const botNames = context.nearbyBots.filter((bot) => bot.isOnline).map((bot) => bot.botName);
      if (botNames.length > 0) {
        lines.push(`${councilName ? `Other active ${councilName} council members nearby` : 'Other active bots nearby'}: ${botNames.join(', ')}.`);
      }

      const profileLines = context.nearbyBots
        .filter((bot) => bot.isOnline && bot.councilProfile)
        .map((bot) => `${bot.botName}: ${bot.councilProfile}`);
      if (profileLines.length > 0) {
        lines.push(`Council member profiles for appearance and address context:\n${profileLines.join('\n\n')}`);
      }
    }

    if (context.sessionSummary) {
      lines.push(`Session summary: ${context.sessionSummary}`);
    }

    if (context.shouldWrapUp) {
      lines.push('The orchestrator thinks this exchange is approaching a natural ending, so wrap cleanly unless there is a strong new hook.');
    }

    lines.push(`Do not repeat or closely paraphrase an earlier ${councilName || 'bot'} message. Add a fresh angle, disagreement, synthesis, or question.`);

    if (context.scratchpad) {
      lines.push(`Your scratchpad: turnsTaken=${context.scratchpad.turnsTaken}, suppressedResponses=${context.scratchpad.suppressedResponses}, unansweredQuestionsSeen=${context.scratchpad.unansweredQuestionsSeen}, noveltyPressure=${context.scratchpad.noveltyPressure.toFixed(2)}.`);
      if (context.scratchpad.privateNotes.length > 0) {
        lines.push(`Private notes: ${context.scratchpad.privateNotes.join(' ')}`);
      }
      if (context.scratchpad.lastNoveltyReasons.length > 0) {
        lines.push(`Novelty check: ${context.scratchpad.lastNoveltyReasons.join('; ')}.`);
      }
      if (context.scratchpad.lastImpulseReasons.length > 0) {
        lines.push(`Why you were in the running to speak: ${context.scratchpad.lastImpulseReasons.join('; ')}.`);
      }
    }

    if (context.recentImpulses && context.recentImpulses.length > 0) {
      const impulseSummary = context.recentImpulses
        .slice(0, 3)
        .map((impulse) => `${impulse.botName}=${impulse.score.toFixed(2)}${impulse.reasons.length > 0 ? ` (${impulse.reasons.join(', ')})` : ''}`)
        .join(' | ');
      lines.push(`Latest impulse ranking: ${impulseSummary}`);
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private buildUserMentionResolver(
    message: Message,
    allowedMentionUserIds: Set<string>,
  ): ResolveUserMention | undefined {
    const guild = message.guild;
    if (!guild) {
      return undefined;
    }

    const addResult = (
      results: ResolvedUserMention[],
      seen: Set<string>,
      member: GuildMember,
      source: ResolvedUserMention['source'],
      matchScore?: number,
    ) => {
      if (seen.has(member.id)) return;

      seen.add(member.id);
      allowedMentionUserIds.add(member.id);
      results.push({
        userId: member.id,
        username: member.user.username,
        displayName: member.displayName || member.user.displayName || member.user.username,
        mention: userMention(member.id),
        source,
        matchScore,
      });
    };

    return async (query: string, maxResults: number = 5) => {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) {
        return [];
      }

      const limit = Math.max(1, Math.min(maxResults || 5, 10));
      const results: ResolvedUserMention[] = [];
      const seen = new Set<string>();

      if (message.mentions.members) {
        message.mentions.members.forEach((member) => {
          const displayName = member.displayName.toLowerCase();
          const username = member.user.username.toLowerCase();
          if (displayName.includes(normalizedQuery) || username.includes(normalizedQuery)) {
            addResult(results, seen, member, 'current-message');
          }
        });
      }

      const memoryMatches = userMemoryService.searchUsers(query, limit);
      for (const match of memoryMatches) {
        if (results.length >= limit) break;
        try {
          const member = await guild.members.fetch(match.userId);
          addResult(results, seen, member, 'memory', match.matchScore);
        } catch {
          // The bot may remember users who are no longer in this guild.
        }
      }

      if (results.length < limit) {
        try {
          const guildMatches = await guild.members.fetch({ query, limit });
          guildMatches.forEach((member) => {
            if (results.length < limit) {
              addResult(results, seen, member, 'guild-search');
            }
          });
        } catch (error) {
          console.warn(`👥 [CLIENT] Guild member search failed for "${query}":`, error);
        }
      }

      return results;
    };
  }

  private normalizeOrchestratorResponse(text: string): string {
    return text
      .toLowerCase()
      .replace(/<[^>]+>/g, ' ')
      .replace(/[`*_~>#]/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isDuplicateOrchestratorResponse(text: string, context: MessageContext): boolean {
    const normalized = this.normalizeOrchestratorResponse(text);
    if (!normalized) {
      return false;
    }

    return context.previousMessages.some((message) => {
      if (!message.isBot) {
        return false;
      }

      return this.normalizeOrchestratorResponse(message.content) === normalized;
    });
  }

  private formatCollectiveKnowledgeResult(result: CollectiveKnowledgeResultPayload): string {
    if (result.queriedBotIds.length === 0) {
      return 'Collective knowledge is unavailable because neither the orchestrator knowledge graph nor any other connected bots were available to query.';
    }

    if (result.results.length === 0) {
      return `No matching collective knowledge was returned from the orchestrator-backed pool for "${result.query}". Queried sources: ${result.queriedBotIds.join(', ')}. Responded sources: ${result.respondedBotIds.join(', ') || 'none'}.`;
    }

    const sections = result.results.map((entry, index) => {
      const matchedKeywords = entry.matchedKeywords.length > 0 ? entry.matchedKeywords.join(', ') : 'none';
      const urlLine = entry.url ? `\nURL: ${entry.url}` : '';
      return `${index + 1}. ${entry.title}\nSource bot: ${entry.sourceBotName} (${entry.sourceBotId})\nTopic: ${entry.topic}\nType: ${entry.type}\nMatched keywords: ${matchedKeywords}\nRelevance: ${entry.relevanceScore.toFixed(2)}${urlLine}\nPreview: ${entry.preview}\nExcerpt: ${entry.excerpt}`;
    });

    return `<collective-knowledge>
Results returned from the orchestrator knowledge graph and other connected bots via the orchestrator.
Original query: ${result.query}
Queried sources: ${result.queriedBotIds.join(', ')}
Responded sources: ${result.respondedBotIds.join(', ') || 'none'}

${sections.join('\n\n')}
</collective-knowledge>`;
  }

  private canUseCollectiveKnowledge(): boolean {
    return !!this.orchestrator
      && this.orchestrator.isConnectedToOrchestrator();
  }

  private buildCollectiveKnowledgeRequester(eventId: string, turnId: string, guildId?: string): ((query: string, maxResults?: number) => Promise<string>) | undefined {
    const orchestrator = this.orchestrator;
    if (!this.canUseCollectiveKnowledge() || !orchestrator) {
      return undefined;
    }

    return async (query: string, maxResults?: number) => this.formatCollectiveKnowledgeResult(
      await orchestrator.requestCollectiveKnowledge(eventId, turnId, query, maxResults, guildId)
    );
  }

  /**
   * Setup orchestrator integration if enabled
   */
  private setupOrchestrator(): void {
    if (!config.orchestrator.enabled) {
      console.log('[Orchestrator] Integration disabled');
      return;
    }

    console.log('[Orchestrator] Initializing integration...');

    this.orchestrator = new LumiaBotIntegration({
      orchestratorUrl: config.orchestrator.url,
      apiKey: config.orchestrator.apiKey,
      botId: config.orchestrator.botId,
      botName: config.orchestrator.botName,
      token: config.discord.token,
      guilds: [],
      metadata: {
        triggerKeywords: getTriggerKeywords().botMention,
        botFamilyName: config.bot.familyName || undefined,
        councilName: config.orchestrator.councilName || undefined,
        councilFamilyName: config.orchestrator.councilName || undefined,
        participatesInCouncil: config.orchestrator.councilParticipant,
        councilProfile: getBotCouncilProfile() || undefined,
      },
      reconnectIntervalMs: config.orchestrator.reconnectIntervalMs,
      maxReconnectAttempts: config.orchestrator.maxReconnectAttempts,
    });

    // Set up response handler for orchestrator
    this.orchestrator.setResponseHandler(async (payload: ResponseRequestPayload) => {
      return this.handleOrchestratorResponse(payload);
    });

    this.orchestrator.setCollectiveKnowledgeHandler(async (payload) => {
      return knowledgeGraphService.findCollectiveKnowledgeCandidates(payload.query, payload.maxResults);
    });

    // Set up callback for when orchestrator says we should respond.
    // Note: Response is now sent directly in handleOrchestratorResponse.
    // We do NOT delete the queue entry here because follow-up turns may
    // reuse the same eventId and need the original Discord message object.
    // Queue entries are cleaned up by the periodic stale-entry sweep below.
    this.orchestrator.setResponseReadyCallback((eventId: string, response: string) => {
      console.log(`[Orchestrator] Response ready callback for event ${eventId} (response length: ${response.length})`);
    });

    // Periodically clean up stale orchestrator queue entries (older than 5 minutes).
    // This prevents memory leaks from events that never completed or had no follow-ups.
    setInterval(() => {
      const staleThreshold = Date.now() - 5 * 60 * 1000;
      for (const [eventId, info] of this.orchestratorQueue.entries()) {
        if (info.message.createdTimestamp < staleThreshold) {
          this.orchestratorQueue.delete(eventId);
          console.log(`[Orchestrator] Cleaned up stale queue entry for event ${eventId}`);
        }
      }
    }, 60_000);

    // Set up typing callback for orchestrated responses
    this.orchestrator.setTypingCallback((channelId: string, guildId: string, isTyping: boolean) => {
      this.handleOrchestratorTyping(channelId, guildId, isTyping);
    });

    // Set up onConnect callback to send guilds when connected
    this.orchestrator.setOnConnect(() => {
      console.log('[Orchestrator] Connection established, sending guilds...');
      this.updateOrchestratorGuilds();
    });

    // Connect to orchestrator
    this.orchestrator.connect().then(() => {
      console.log('[Orchestrator] Connected successfully');
    }).catch((error) => {
      console.error('[Orchestrator] Failed to connect:', error);
      console.log('[Orchestrator] Continuing without orchestration...');
    });
  }

  /**
   * Handle orchestrator response request - generates actual response and sends it
   */
  private async handleOrchestratorResponse(payload: ResponseRequestPayload): Promise<string> {
    const { context, eventId, turnId } = payload;
    console.log('[Orchestrator] Generating response for event', {
      eventId,
      turnId,
      turnCount: context.turnCount,
      maxTurns: context.maxTurns,
      isBanter: context.isBanter,
    });

    const queuedInfo = await this.resolveOrchestratorQueuedInfo(payload);
    if (!queuedInfo) {
      console.error(`[Orchestrator] No queued or reconstructable message found for event ${eventId}`);
      return '';
    }

    const { message, replyContext, imageUrls, videoUrls, textAttachments } = queuedInfo;

    // NSFW-only mode: never generate an orchestrated response outside an NSFW channel,
    // even if the orchestrator grants this bot a turn (e.g. via a banter session).
    if (config.bot.nsfwOnly && !isDiscordNsfwChannel(message.channel)) {
      console.log(`🔞 [Orchestrator] NSFW-only mode: declining turn in non-NSFW channel ${message.channelId}`);
      return '';
    }

    const instanceId = this.orchestrator?.getInstanceId() ?? 'unknown';
    const generationKey = !context.replyToMessageId ? `root:${message.id}` : undefined;

    const journalTurn = orchestratorTurnJournal.getTurn(turnId);
    if (journalTurn?.responseText) {
      if (journalTurn.state === 'discord_sent' || journalTurn.state === 'completion_sent' || journalTurn.state === 'acknowledged') {
        console.log(`[Orchestrator] Reusing cached response for turn ${turnId} without regenerating`);
        return journalTurn.responseText;
      }

      if (journalTurn.state === 'generated') {
        console.log(`[Orchestrator] Replaying cached generated response for turn ${turnId}`);
        const replayedMessage = await this.sendOrchestratorResponseToDiscord(
          message,
          context,
          journalTurn.responseText,
          eventId,
          turnId,
          getMentionedUserDisplayMap(message).keys(),
        );
        if (!replayedMessage) {
          orchestratorTurnJournal.markGenerated(turnId, eventId, instanceId, '', payload);
          return '';
        }
        return journalTurn.responseText;
      }
    }

    if (generationKey && !this.beginGeneration(generationKey)) {
      console.warn(`⚠️ [Orchestrator] Suppressing duplicate generation for message ${message.id} (event ${eventId}, turn ${turnId})`);
      return '';
    }

    // Get the last message from context
    const lastMessage = context.previousMessages[context.previousMessages.length - 1];
    if (!lastMessage) {
      console.error('[Orchestrator] No last message in context');
      return '';
    }

    try {
      orchestratorTurnJournal.markGenerating(turnId, eventId, instanceId, payload);

      const isBotAuthoredTurn = lastMessage.isBot;
      const allowNsfwImageGeneration = canUserRequestNsfwImages(
        message.channel,
        isBotAuthoredTurn ? undefined : lastMessage.authorId,
      );
      if (allowNsfwImageGeneration) {
        console.log(`🔞 [Orchestrator] NSFW image generation enabled in NSFW channel ${message.channelId}`);
      }

      // Extract mentioned users from the original Discord message.
      // In orchestrator mode the message content contains raw <@id> patterns;
      // resolving them here gives the AI system prompt the "USERS MENTIONED"
      // section and enables user-related tools (opinions, pronouns, etc.).
      const mentionedUsers = getMentionedUserDisplayMap(message);
      const allowedMentionUserIds = new Set<string>(mentionedUsers.keys());
      const resolveUserMention = this.buildUserMentionResolver(message, allowedMentionUserIds);
      if (mentionedUsers.size > 0) {
        mentionedUsers.forEach((name, id) => {
          console.log(`👥 [Orchestrator] User mentioned: ${name} (${id})`);
        });
      }

      // Also scan previousMessages for <@id> patterns that we can resolve
      // from the guild member cache (e.g. if another bot mentioned a user).
      if (message.guild) {
        const mentionPattern = /<@!?(\d+)>/g;
        for (const prevMsg of context.previousMessages) {
          let match: RegExpExecArray | null;
          while ((match = mentionPattern.exec(prevMsg.content)) !== null) {
            const userId = match[1];
            if (userId && !mentionedUsers.has(userId)) {
              try {
                const member = message.guild.members.cache.get(userId);
                if (member) {
                  mentionedUsers.set(userId, member.displayName || member.user.displayName || member.user.username);
                  allowedMentionUserIds.add(userId);
                  console.log(`👥 [Orchestrator] Resolved mention from context: ${member.displayName} (${userId})`);
                }
              } catch {
                // Silently skip unresolvable mentions
              }
            }
          }
        }
      }

      // Convert orchestrator context messages into chat turns
      const historyMessages = context.previousMessages.filter(m => m.id !== lastMessage.id);
      let orchestratorTurns = channelHistoryService.convertOrchestratorToTurns(
        historyMessages,
        config.orchestrator.botId
      );

      const orchestratorContextNote = this.buildOrchestratorContextNote(context);
      const requestCollectiveKnowledge = this.buildCollectiveKnowledgeRequester(eventId, turnId, message.guildId || undefined);

      // Create a working getUserListeningActivity callback using the guild
      // from the original Discord message, matching the non-orchestrator path.
      const getUserListeningActivity = async (targetUserId: string) => {
        try {
          if (!message.guild) return null;
          const member = await message.guild.members.fetch({
            user: targetUserId,
            withPresences: true,
          });
          if (!member) return null;
          return userActivityService.getMusicActivity(member);
        } catch (error) {
          console.error(`[Orchestrator] Failed to get listening activity for ${targetUserId}:`, error);
          return null;
        }
      };

      // Extract web page content from URLs in orchestrator message
      const orchestratorPageContents = config.pageExtraction.enabled
        ? await pageExtractorService.extractPagesFromMessage(lastMessage.content)
        : [];

      // In orchestrator mode, if another bot just spoke, strongly frame this as a reply to that bot.
      const effectiveReplyContext = context.replyingToBotName
        ? {
            isReply: true,
            isReplyToLumia: false,
            originalContent: historyMessages.length > 0 ? historyMessages[historyMessages.length - 1]!.content : undefined,
            originalAuthor: context.replyingToBotName,
          }
        : replyContext
          ? {
              isReply: replyContext.isReply,
              isReplyToLumia: replyContext.isReplyToLumia,
              originalContent: replyContext.originalContent,
              originalTimestamp: replyContext.originalTimestamp,
              originalAuthor: replyContext.originalAuthor,
            }
          : undefined;

      // Generate response using the existing message handler
      let response = await handleMessage({
        content: lastMessage.content,
        imageUrls,
        videoUrls,
        textAttachments,
        pageContents: orchestratorPageContents.length > 0 ? orchestratorPageContents : undefined,
        userId: isBotAuthoredTurn ? undefined : lastMessage.authorId,
        username: isBotAuthoredTurn ? undefined : lastMessage.authorName,
        guildId: message.guildId || 'dm',
        mentionedUsers,
        replyContext: effectiveReplyContext,
        channelMessages: orchestratorTurns.length > 0 ? orchestratorTurns : undefined,
        orchestratorContextNote,
        currentMessageSpeaker: {
          authorId: lastMessage.authorId,
          authorName: lastMessage.authorName,
          isBot: lastMessage.isBot,
          format: 'orchestrator',
          currentBotId: this.client.user?.id,
        },
        getUserListeningActivity,
        resolveUserMention,
        allowNsfwImageGeneration,
        // Orchestrator follow-up support: allow the LLM to request another turn
        orchestratorEventId: eventId,
        orchestratorTurnId: turnId,
        requestFollowUp: this.orchestrator
          ? (evtId, currentTurnId, targetBotId, reason) => this.orchestrator!.requestFollowUp(evtId, currentTurnId, targetBotId, reason)
          : undefined,
        requestCollectiveKnowledge,
      });

      if (response.text && this.isDuplicateOrchestratorResponse(response.text, context)) {
        console.warn(`[Orchestrator] Duplicate-looking response detected for turn ${turnId}; retrying with anti-repeat note`);

        response = await handleMessage({
          content: lastMessage.content,
          imageUrls,
          videoUrls,
          textAttachments,
          pageContents: orchestratorPageContents.length > 0 ? orchestratorPageContents : undefined,
          userId: isBotAuthoredTurn ? undefined : lastMessage.authorId,
          username: isBotAuthoredTurn ? undefined : lastMessage.authorName,
          guildId: message.guildId || 'dm',
          mentionedUsers,
          replyContext: effectiveReplyContext,
          channelMessages: orchestratorTurns.length > 0 ? orchestratorTurns : undefined,
          orchestratorContextNote: `${orchestratorContextNote || ''}\nYour previous draft matched an earlier ${(config.orchestrator.familyName || config.bot.familyName || 'bot')} response too closely. Reply in a meaningfully different way, grounded in the live chat context, without repeating earlier wording or explaining that you cannot respond.`.trim(),
          currentMessageSpeaker: {
            authorId: lastMessage.authorId,
            authorName: lastMessage.authorName,
            isBot: lastMessage.isBot,
            format: 'orchestrator',
            currentBotId: this.client.user?.id,
          },
          getUserListeningActivity,
          resolveUserMention,
          allowNsfwImageGeneration,
          orchestratorEventId: eventId,
          orchestratorTurnId: turnId,
          requestFollowUp: this.orchestrator
            ? (evtId, currentTurnId, targetBotId, reason) => this.orchestrator!.requestFollowUp(evtId, currentTurnId, targetBotId, reason)
            : undefined,
          requestCollectiveKnowledge,
        });
      }

      if (response.text && this.isDuplicateOrchestratorResponse(response.text, context)) {
        console.warn(`[Orchestrator] Suppressing repeated response for turn ${turnId} after retry`);
        response.text = '';
      }

      orchestratorTurnJournal.markGenerated(turnId, eventId, instanceId, response.text, payload);

      // Send the response directly to Discord
      if ((response.text && response.text.trim()) || response.attachments.length > 0) {
        const sentMessage = await this.sendOrchestratorResponseToDiscord(message, context, response.text, eventId, turnId, allowedMentionUserIds, response.attachments);
        if (!sentMessage) {
          orchestratorTurnJournal.markGenerated(turnId, eventId, instanceId, '', payload);
          return '';
        }
      }

      return response.text;
    } catch (error) {
      console.error('[Orchestrator] Failed to generate or send response:', error);
      orchestratorTurnJournal.markFailed(turnId, eventId, instanceId, error instanceof Error ? error.message : String(error), payload);
      return '';
    } finally {
      if (generationKey) {
        this.endGeneration(generationKey);
      }
    }
  }

  private async resolveOrchestratorQueuedInfo(payload: ResponseRequestPayload): Promise<OrchestratorQueuedInfo | undefined> {
    const queuedInfo = this.orchestratorQueue.get(payload.eventId);
    if (queuedInfo) {
      return queuedInfo;
    }

    if (!payload.eventSnapshot) {
      return undefined;
    }

    const message = await this.fetchOrchestratorMessageFromSnapshot(payload.eventSnapshot);
    if (!message) {
      return undefined;
    }

    return {
      message,
      replyContext: payload.eventSnapshot.replyContext,
      imageUrls: payload.eventSnapshot.imageUrls || [],
      videoUrls: payload.eventSnapshot.videoUrls || [],
      textAttachments: payload.eventSnapshot.textAttachments || [],
    };
  }

  private async fetchOrchestratorMessageFromSnapshot(snapshot: NonNullable<ResponseRequestPayload['eventSnapshot']>): Promise<Message | null> {
    try {
      const channel = await this.client.channels.fetch(snapshot.channelId);
      if (!channel || !('messages' in channel)) {
        console.warn(`[Orchestrator] Cannot reconstruct message ${snapshot.messageId} - channel missing message manager`);
        return null;
      }

      const fetchedMessage = await channel.messages.fetch(snapshot.messageId);
      return fetchedMessage;
    } catch (error) {
      console.error(`[Orchestrator] Failed to reconstruct message ${snapshot.messageId}:`, error);
      return null;
    }
  }

  private async sendOrchestratorResponseToDiscord(
    message: Message,
    context: MessageContext,
    responseText: string,
    eventId: string,
    turnId: string,
    allowedMentionUserIds: Iterable<string> = [],
    attachments: GeneratedImageAttachment[] = [],
  ): Promise<Message | null> {
    if (!context.replyToMessageId && this.hasAlreadyReplied(message.id)) {
      console.warn(`⚠️ [Orchestrator] Suppressing duplicate reply for message ${message.id} (orchestrator path blocked by cross-path guard)`);
      return null;
    }

    console.log(`[Orchestrator] Sending response to Discord for event ${eventId}, turn ${turnId}`);

    const formattedResponseText = formatDiscordResponseText(responseText);
    const allowedMentions = buildAllowedMentions(allowedMentionUserIds);
    const files = buildDiscordImageFiles(attachments);

    let sentMessage;
    if (context.replyToMessageId && 'send' in message.channel) {
      sentMessage = await message.channel.send({
        content: formattedResponseText || undefined,
        allowedMentions,
        files,
        reply: { messageReference: context.replyToMessageId, failIfNotExists: false },
      });
    } else {
      sentMessage = await message.reply({
        content: formattedResponseText || undefined,
        allowedMentions,
        files,
        failIfNotExists: false,
      });
    }

    if (sentMessage && this.orchestrator) {
      console.log(`[Orchestrator] Sent Discord reply for turn ${turnId}: ${sentMessage.id}`);
      this.orchestrator.setResponseMessageId(turnId, sentMessage.id);
      orchestratorTurnJournal.markDiscordSent(
        turnId,
        eventId,
        this.orchestrator.getInstanceId(),
        responseText,
        sentMessage.id,
      );
    }

    return sentMessage;
  }

  /**
   * Check if orchestrator is active and should handle this mention
   */
  private shouldUseOrchestrator(message: Message): boolean {
    if (!this.orchestrator?.isConnectedToOrchestrator()) {
      return false;
    }

    const botId = this.client.user?.id;
    if (!botId) return false;

    // Check if multiple bots are @mentioned
    const mentionedBots = message.mentions.users.filter(user => user.bot);

    // If multiple bots are @mentioned, use orchestrator
    if (mentionedBots.size > 1) {
      return true;
    }

    // If this bot is the only @mentioned bot, handle directly.
    // The user explicitly targeted this bot, so orchestrator coordination
    // is unnecessary and can cause double replies via race conditions
    // (another keyword-triggered bot could create a banter session).
    if (mentionedBots.size === 1 && mentionedBots.has(botId)) {
      return false;
    }

    // Check for trigger keywords
    const triggerKeywords = extractTriggerKeywords(message.content);
    const hasTriggerWords = triggerKeywords.length > 0;

    // If this bot is triggered by keywords AND there are other bots in the guild,
    // use orchestrator to coordinate (in case other bots also have trigger words)
    if (hasTriggerWords && message.guild) {
      // Count other bots in the guild (excluding self)
      const otherBots = message.guild.members.cache.filter(
        member => member.user.bot && member.user.id !== botId
      );

      // If there are other bots in the guild, use orchestrator
      // The orchestrator will determine if they should respond
      if (otherBots.size > 0) {
        console.log(`🎭 [Orchestrator] Trigger words detected with ${otherBots.size} other bots in guild, using orchestrator`);
        return true;
      }
    }

    // If it's a reply to a message with bot mentions, use orchestrator
    if (message.reference && mentionedBots.size > 0) {
      return true;
    }

    return false;
  }

  /**
   * Cross-path reply guard: returns true if we've already replied to this message.
   * Prevents double replies regardless of which trigger path (direct/orchestrator) runs.
   */
  private hasAlreadyReplied(messageId: string): boolean {
    if (this.repliedMessageIds.has(messageId)) {
      return true;
    }
    this.repliedMessageIds.add(messageId);
    // Auto-cleanup after 2 minutes
    setTimeout(() => this.repliedMessageIds.delete(messageId), 120_000);
    return false;
  }

  private beginGeneration(key: string): boolean {
    if (this.activeGenerationKeys.has(key) || this.recentGenerationKeys.has(key)) {
      return false;
    }

    this.activeGenerationKeys.add(key);
    this.recentGenerationKeys.add(key);
    setTimeout(() => this.recentGenerationKeys.delete(key), 120_000);
    return true;
  }

  private endGeneration(key: string): void {
    this.activeGenerationKeys.delete(key);
  }

  /**
   * Start typing indicator for a specific channel
   * Each channel gets its own independent typing indicator
   */
  private startTyping(channel: TextChannel | ThreadChannel | NewsChannel | VoiceChannel | StageChannel | DMChannel): Timer {
    const channelId = channel.id;
    
    // Clear any existing typing interval for this channel
    this.stopTyping(channelId);
    
    // Send initial typing indicator
    channel.sendTyping().catch(() => {});
    
    // Set up interval to keep typing indicator alive (every 8 seconds)
    const interval = setInterval(async () => {
      try {
        await channel.sendTyping();
      } catch {
        // Channel might be deleted or bot lost permissions - stop typing
        this.stopTyping(channelId);
      }
    }, 8000);
    
    this.typingIntervals.set(channelId, interval);
    console.log(`⌨️ [TYPING] Started typing indicator in channel ${channelId} (${this.typingIntervals.size} active)`);
    
    return interval;
  }

  /**
   * Stop typing indicator for a specific channel
   */
  private stopTyping(channelId: string): void {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
      console.log(`⌨️ [TYPING] Stopped typing indicator in channel ${channelId} (${this.typingIntervals.size} active)`);
    }
  }

  /**
   * Stop all typing indicators (useful for shutdown)
   */
  private stopAllTyping(): void {
    for (const [channelId, interval] of this.typingIntervals) {
      clearInterval(interval);
      console.log(`⌨️ [TYPING] Stopped typing indicator in channel ${channelId}`);
    }
    this.typingIntervals.clear();
  }

  /**
   * Handle typing indicator for orchestrated responses
   * Called by the orchestrator when it's this bot's turn to respond
   */
  private async handleOrchestratorTyping(channelId: string, guildId: string, isTyping: boolean): Promise<void> {
    console.log(`⌨️ [Orchestrator-Typing] handleOrchestratorTyping called:`, {
      channelId,
      guildId,
      isTyping,
      clientReady: this.client.isReady(),
    });
    
    try {
      if (isTyping) {
        console.log(`⌨️ [Orchestrator-Typing] Attempting to fetch channel ${channelId}`);
        
        // Fetch the channel
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) {
          console.warn(`[Orchestrator-Typing] Channel ${channelId} not found for typing`);
          return;
        }
        
        console.log(`⌨️ [Orchestrator-Typing] Channel found: ${channel.constructor.name}`);

        // Check if it's a text-based channel
        if (
          channel instanceof TextChannel ||
          channel instanceof ThreadChannel ||
          channel instanceof NewsChannel ||
          channel instanceof VoiceChannel ||
          channel instanceof StageChannel ||
          channel instanceof DMChannel
        ) {
          this.startTyping(channel);
          console.log(`⌨️ [Orchestrator-Typing] ✅ Started typing in channel ${channelId}`);
        } else {
          console.warn(`[Orchestrator-Typing] Channel ${channelId} is not text-based (${channel.constructor.name})`);
        }
      } else {
        // Stop typing
        this.stopTyping(channelId);
        console.log(`⌨️ [Orchestrator-Typing] ✅ Stopped typing in channel ${channelId}`);
      }
    } catch (error) {
      console.error(`[Orchestrator-Typing] Failed to handle typing indicator:`, error);
    }
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    });

    // Handle process shutdown to clean up timers
    process.on('SIGINT', () => {
      console.log('\n🛑 [CLIENT] Shutting down...');
      boredomService.cleanup();
      this.destroy().then(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 [CLIENT] Shutting down...');
      boredomService.cleanup();
      this.destroy().then(() => process.exit(0));
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const command = this.commands.get(interaction.commandName);

      if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
      }

      try {
        // NSFW-only mode: commands are usable only in channels marked NSFW.
        if (config.bot.nsfwOnly && !isDiscordNsfwChannel(interaction.channel)) {
          await interaction.reply({
            content: 'I can only be used in age-restricted (NSFW) channels.',
            ephemeral: true,
          });
          return;
        }

        const subcommand = interaction.options.getSubcommand(false);
        const ownerOnly = command.ownerOnly ||
          (subcommand !== null && command.ownerOnlySubcommands?.includes(subcommand));

        if (ownerOnly && interaction.user.id !== config.bot.ownerId) {
          await interaction.reply({
            content: 'This command is only available to the bot owner.',
            ephemeral: true,
          });
          return;
        }

        await command.execute(interaction);
      } catch (error) {
        console.error(error);
        const errorMessage = {
          content: 'There was an error while executing this command!',
          ephemeral: true,
        };

        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorMessage);
        } else {
          await interaction.reply(errorMessage);
        }
      }
    });

    // Handle message mentions and keyword triggers
    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore messages from bots (including self)
      if (message.author.bot) return;

      // Ignore webhook messages (they don't have author.bot=true but have webhookId)
      if (message.webhookId) {
        console.log(`🤖 [CLIENT] Ignoring webhook message from: ${message.author.username}`);
        return;
      }

      // Ignore empty messages
      if (!message.content.trim()) return;

      // Duplicate event guard — Discord may deliver the same event twice
      if (this.processedMessageIds.has(message.id)) return;
      this.processedMessageIds.add(message.id);
      // Auto-cleanup after 60s to prevent unbounded growth
      const cleanupTimer = setTimeout(() => {
        this.processedMessageIds.delete(message.id);
        this.processedMessageTimers.delete(message.id);
      }, 60_000);
      this.processedMessageTimers.set(message.id, cleanupTimer);

      const botId = this.client.user?.id;
      if (!botId) return;

      // Check if this message is a reply to someone
      let replyContext: { 
        isReply: boolean; 
        isReplyToLumia: boolean;
        originalContent?: string; 
        originalTimestamp?: string;
        originalAuthor?: string;
        embeddedContent?: {
          images: string[];
          videos: { url: string; mimeType?: string }[];
        };
      } | undefined;

      if (message.reference && message.reference.messageId) {
        try {
          // Check if this is a forwarded message (type 1) vs a regular reply (type 0)
          const isForward = message.reference.type === 1;
          
          if (isForward) {
            console.log(`📨 [CLIENT] Forwarded message detected - fetching reference with caution`);
          }
          
          // Fetch the referenced message
          const referencedMessage = await message.fetchReference();
          
          // Check if the referenced message is from Lumia (the bot)
          const isReplyToLumia = referencedMessage.author.id === botId;
          
          const referencedAuthorName = getMessageAuthorDisplayName(referencedMessage);
          console.log(`💬 [CLIENT] Reply detected to ${isReplyToLumia ? 'Lumia' : referencedAuthorName}: "${referencedMessage.content.slice(0, 100)}..."`);
          
          // Extract embedded content from referenced message
          const embeddedImages: string[] = [];
          const embeddedVideos: { url: string; mimeType?: string }[] = [];
          
          // Extract attachments from referenced message
          if (referencedMessage.attachments.size > 0) {
            referencedMessage.attachments.forEach((attachment) => {
              if (attachment.contentType?.startsWith('image/gif')) {
                embeddedVideos.push({
                  url: attachment.url,
                  mimeType: attachment.contentType,
                });
                console.log(`🎬 [CLIENT] Referenced GIF attachment: ${attachment.name}`);
              } else if (attachment.contentType?.startsWith('image/')) {
                embeddedImages.push(attachment.url);
                console.log(`🖼️  [CLIENT] Referenced image attachment: ${attachment.name}`);
              } else if (attachment.contentType?.startsWith('video/')) {
                embeddedVideos.push({
                  url: attachment.url,
                  mimeType: attachment.contentType,
                });
                console.log(`🎥 [CLIENT] Referenced video attachment: ${attachment.name}`);
              }
            });
          }

          // Extract embeds from referenced message (Tenor GIFs, link previews, video embeds, etc.)
          if (referencedMessage.embeds.length > 0) {
            for (const embed of referencedMessage.embeds) {
              const embedType = embed.data?.type;

              // GIFV embeds (Tenor, Giphy, etc.)
              if (embedType === 'gifv' && embed.video?.url) {
                embeddedVideos.push({
                  url: embed.video.url,
                  mimeType: 'image/gif',
                });
                console.log(`🎬 [CLIENT] Referenced GIFV embed: ${embed.url || embed.video.url}`);
              }
              // Video embeds (YouTube, etc.)
              else if (embedType === 'video' && embed.video?.url) {
                embeddedVideos.push({
                  url: embed.video.proxyURL || embed.video.url,
                  mimeType: 'video/mp4',
                });
                console.log(`🎥 [CLIENT] Referenced video embed: ${embed.url || embed.video.url}`);
              }
              // Image embeds
              else if (embedType === 'image' && embed.image?.url) {
                embeddedImages.push(embed.image.proxyURL || embed.image.url);
                console.log(`🖼️  [CLIENT] Referenced image embed: ${embed.image.url}`);
              }
              // Rich embeds with images or thumbnails (link previews, etc.)
              else if (embedType === 'rich' || embedType === 'article' || embedType === 'link') {
                if (embed.image?.url) {
                  embeddedImages.push(embed.image.proxyURL || embed.image.url);
                  console.log(`🖼️  [CLIENT] Referenced rich embed image: ${embed.image.url}`);
                }
                if (embed.thumbnail?.url) {
                  embeddedImages.push(embed.thumbnail.proxyURL || embed.thumbnail.url);
                  console.log(`🖼️  [CLIENT] Referenced rich embed thumbnail: ${embed.thumbnail.url}`);
                }
              }
            }
          }
          
          // Extract stickers from the referenced message
          const referencedStickerMedia = extractStickerMedia(referencedMessage, 'CLIENT');
          embeddedImages.push(...referencedStickerMedia.imageUrls);
          embeddedVideos.push(...referencedStickerMedia.videoUrls);

          // Extract custom emoji images from the referenced message
          embeddedImages.push(...extractCustomEmojiUrls(referencedMessage.content, 'CLIENT'));


          const originalContentWithStickers = referencedStickerMedia.stickerHints.length > 0
            ? (referencedMessage.content
                ? `${referencedMessage.content} ${referencedStickerMedia.stickerHints.join(' ')}`
                : referencedStickerMedia.stickerHints.join(' '))
            : referencedMessage.content;

          replyContext = {
            isReply: true,
            isReplyToLumia,
            originalContent: originalContentWithStickers,
            originalTimestamp: formatTimeAgo(referencedMessage.createdAt),
            originalAuthor: referencedAuthorName,
            embeddedContent: {
              images: embeddedImages,
              videos: embeddedVideos,
            },
          };
        } catch (error: any) {
          // Handle specific error cases
          if (error.code === 10008 || error.message?.includes('Unknown Message')) {
            console.warn(`⚠️ [CLIENT] Referenced message not found (deleted or inaccessible): ${message.reference.messageId}`);
          } else if (error.code === 50001 || error.message?.includes('Missing Access')) {
            console.warn(`⚠️ [CLIENT] No access to referenced message in channel: ${message.reference.channelId}`);
          } else {
            console.error('❌ [CLIENT] Failed to fetch referenced message:', error);
          }
          // Continue without reply context if we can't fetch it
        }
      }

      // Check if message should trigger the bot
      const hasTrigger = shouldTriggerBot(message.content, botId);
      const isReplyToLumia = replyContext?.isReplyToLumia === true;
      
      // Trigger if: has keyword/mention OR is reply to Lumia OR is reply with mention
      const shouldTrigger = hasTrigger || isReplyToLumia || (replyContext?.isReply && hasTrigger);
      
      let boredomAction: 'opted-in' | 'opted-out' | undefined;

      // NSFW-only mode: the bot may only respond in channels marked NSFW.
      // Reuses the same age-gating used for NSFW image generation, so DMs and
      // non-NSFW channels are silently ignored regardless of trigger.
      if (shouldTrigger && config.bot.nsfwOnly && !isDiscordNsfwChannel(message.channel)) {
        console.log(`🔞 [CLIENT] NSFW-only mode: ignoring trigger in non-NSFW channel ${message.channelId}`);
        return;
      }

      if (shouldTrigger) {
        // Check if orchestrator should handle this mention
        if (this.shouldUseOrchestrator(message)) {
          await this.handleOrchestratedMention(message, replyContext);
          return;
        }

        // Per-channel queue: serialize message processing within each channel
        // so the bot's reply to message A is visible in channel history for message B.
        // Different channels remain fully parallel.
        const channelId = message.channelId;
        const previousTask = this.channelProcessingQueue.get(channelId) ?? Promise.resolve();

        const currentTask = previousTask
          .catch(() => {}) // don't let a previous failure break the chain
          .then(() => this.processTriggeredMessage(message, botId, hasTrigger, replyContext, boredomAction));

        this.channelProcessingQueue.set(channelId, currentTask);

        // Clean up the map entry once this task settles, but only if it's still the latest
        currentTask.finally(() => {
          if (this.channelProcessingQueue.get(channelId) === currentTask) {
            this.channelProcessingQueue.delete(channelId);
          }
        });
      }
    });
  }

  /**
   * Process a triggered message (extracted for per-channel queuing)
   */
  private async processTriggeredMessage(
    message: Message,
    botId: string,
    hasTrigger: boolean,
    replyContext: {
      isReply: boolean;
      isReplyToLumia: boolean;
      originalContent?: string;
      originalTimestamp?: string;
      originalAuthor?: string;
      embeddedContent?: {
        images: string[];
        videos: { url: string; mimeType?: string }[];
      };
    } | undefined,
    boredomAction: 'opted-in' | 'opted-out' | undefined,
  ): Promise<void> {
    const generationKey = `root:${message.id}`;

    // Check for boredom opt-in/opt-out intent (but let LLM respond naturally)
    if (detectBoredomOptOut(message.content)) {
      const guildId = message.guildId || 'dm';
      boredomService.optOut(message.author.id, guildId);
      boredomAction = 'opted-out';
      console.log(`😴 [BOREDOM] User opted out - letting LLM respond naturally`);
    } else if (detectBoredomOptIn(message.content)) {
      const guildId = message.guildId || 'dm';
      boredomService.optIn(message.author.id, guildId);
      boredomAction = 'opted-in';
      console.log(`😴 [BOREDOM] User opted in - letting LLM respond naturally`);
    }

    // Check if channel supports typing indicator
    const canType = (
      message.channel instanceof TextChannel ||
      message.channel instanceof ThreadChannel ||
      message.channel instanceof NewsChannel ||
      message.channel instanceof VoiceChannel ||
      message.channel instanceof StageChannel ||
      message.channel instanceof DMChannel
    );

    // Start typing indicator for this specific channel
    if (canType) {
      this.startTyping(message.channel);
    }

    // Extract the actual message content (remove triggers if present)
    const cleanedContent = hasTrigger ? extractMessageContent(message.content, botId) : message.content;

    // Categorize any stickers up front so the content guard can count them as "content"
    // and the media arrays below can absorb them alongside regular attachments.
    const stickerMedia = extractStickerMedia(message, 'CLIENT');
    const contentWithStickers = stickerMedia.stickerHints.length > 0
      ? (cleanedContent.trim()
          ? `${cleanedContent} ${stickerMedia.stickerHints.join(' ')}`
          : stickerMedia.stickerHints.join(' '))
      : cleanedContent;

    // Don't respond if there's no actual content after removing triggers (only for explicit triggers)
    if (hasTrigger && !cleanedContent.trim() && stickerMedia.stickerHints.length === 0) {
      // Check if channel is still available (bot may have been kicked)
      if (!message.channel) {
        console.warn('⚠️ [CLIENT] Cannot reply - channel no longer available (bot may have been kicked)');
        return;
      }
      await message.reply('You summoned me but forgot to say what you wanted! How can I help you?');
      return;
    }

    try {
      if (!this.beginGeneration(generationKey)) {
        console.warn(`⚠️ [CLIENT] Suppressing duplicate generation for message ${message.id}`);
        this.stopTyping(message.channelId);
        return;
      }

      // Extract image and video URLs from attachments
      const imageUrls: string[] = [];
      const videoUrls: { url: string; mimeType?: string }[] = [];
      const textAttachments: { name: string; content: string }[] = [];

      if (message.attachments.size > 0) {
        for (const attachment of message.attachments.values()) {
          if (attachment.contentType?.startsWith('image/gif')) {
            videoUrls.push({
              url: attachment.url,
              mimeType: attachment.contentType,
            });
            console.log(`🎬 [CLIENT] GIF found in message (will convert to WebM): ${attachment.name} (${attachment.contentType})`);
          } else if (attachment.contentType?.startsWith('image/')) {
            imageUrls.push(attachment.url);
            console.log(`🖼️  [CLIENT] Image found in message: ${attachment.name} (${attachment.contentType})`);
          } else if (attachment.contentType?.startsWith('video/')) {
            videoUrls.push({
              url: attachment.url,
              mimeType: attachment.contentType,
            });
            console.log(`🎥 [CLIENT] Video found in message: ${attachment.name} (${attachment.contentType})`);
          } else if (attachment.contentType?.startsWith('text/') ||
                    attachment.name.match(/\.(txt|md|json|csv|log|xml|yaml|yml|js|ts|jsx|tsx|py|rb|java|c|cpp|h|hpp|cs|go|rs|php|html|css|scss|sass|less|sql)$/i)) {
            // Text file detected - check size and read content
            const maxSizeBytes = config.attachments.maxTextFileSizeKB * 1024;

            // Check file size before downloading
            if (attachment.size > maxSizeBytes) {
              console.log(`📄 [CLIENT] Text file too large: ${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB > ${config.attachments.maxTextFileSizeKB}KB limit)`);
              textAttachments.push({
                name: attachment.name,
                content: `[File too large: ${(attachment.size / 1024).toFixed(1)}KB. Maximum size is ${config.attachments.maxTextFileSizeKB}KB]`,
              });
              continue;
            }

            try {
              console.log(`📄 [CLIENT] Text file detected: ${attachment.name} (${attachment.contentType || 'unknown type'}, ${(attachment.size / 1024).toFixed(1)}KB)`);
              const response = await fetch(attachment.url);
              if (response.ok) {
                const textContent = await response.text();
                // Limit text content to prevent token overflow
                const maxChars = maxSizeBytes;
                const truncatedContent = textContent.length > maxChars
                  ? textContent.substring(0, maxChars) + '\n... [content truncated]'
                  : textContent;
                textAttachments.push({
                  name: attachment.name,
                  content: truncatedContent,
                });
                console.log(`📄 [CLIENT] Read text file: ${attachment.name} (${truncatedContent.length} chars)`);
              } else {
                console.warn(`⚠️ [CLIENT] Failed to fetch text file ${attachment.name}: ${response.status}`);
              }
            } catch (error) {
              console.error(`❌ [CLIENT] Error reading text file ${attachment.name}:`, error);
            }
          }
        }
      }

      // Merge sticker-derived media into the main arrays so downstream handling is identical.
      imageUrls.push(...stickerMedia.imageUrls);
      videoUrls.push(...stickerMedia.videoUrls);

      // Extract custom emoji images from message content so the model can see them.
      imageUrls.push(...extractCustomEmojiUrls(message.content, 'CLIENT'));

      // Identify URLs that will be scraped for page content, so we can skip their embed images
      const scrapedUrls = config.pageExtraction.enabled
        ? pageExtractorService.extractUrls(cleanedContent)
        : [];

      // Helper: check if an embed's source URL matches any URL we're scraping
      const isFromScrapedLink = (embedUrl: string | null): boolean => {
        if (!embedUrl || scrapedUrls.length === 0) return false;
        return scrapedUrls.some(scraped =>
          embedUrl === scraped || embedUrl.startsWith(scraped) || scraped.startsWith(embedUrl)
        );
      };

      // Extract embeds from current message (forwarded messages, etc.)
      if (message.embeds.length > 0) {
        for (const embed of message.embeds) {
          const embedType = embed.data?.type;
          const isScrapedLink = isFromScrapedLink(embed.url);

          if (isScrapedLink) {
            console.log(`🌐 [CLIENT] Skipping embed for scraped URL: ${embed.url} (type: ${embedType})`);
            continue;
          }

          if (embedType === 'gifv' && embed.video?.url) {
            videoUrls.push({ url: embed.video.url, mimeType: 'image/gif' });
            console.log(`🎬 [CLIENT] GIFV embed in message: ${embed.url || embed.video.url}`);
          } else if (embedType === 'video' && embed.video?.url) {
            videoUrls.push({ url: embed.video.proxyURL || embed.video.url, mimeType: 'video/mp4' });
            console.log(`🎥 [CLIENT] Video embed in message: ${embed.url || embed.video.url}`);
          } else if (embedType === 'image' && embed.image?.url) {
            imageUrls.push(embed.image.proxyURL || embed.image.url);
            console.log(`🖼️  [CLIENT] Image embed in message: ${embed.image.url}`);
          } else if (embedType === 'rich' || embedType === 'article' || embedType === 'link') {
            if (embed.image?.url) {
              imageUrls.push(embed.image.proxyURL || embed.image.url);
              console.log(`🖼️  [CLIENT] Rich embed image in message: ${embed.image.url}`);
            }
            if (embed.thumbnail?.url) {
              imageUrls.push(embed.thumbnail.proxyURL || embed.thumbnail.url);
              console.log(`🖼️  [CLIENT] Rich embed thumbnail in message: ${embed.thumbnail.url}`);
            }
          }
        }
      }

      // Add embedded content from reply context
      if (replyContext?.embeddedContent) {
        imageUrls.push(...replyContext.embeddedContent.images);
        videoUrls.push(...replyContext.embeddedContent.videos);
      }

      // Extract mentioned users for context parsing, using guild display names when available.
      const mentionedUsers = getMentionedUserDisplayMap(message);
      const allowedMentionUserIds = new Set<string>(mentionedUsers.keys());
      const resolveUserMention = this.buildUserMentionResolver(message, allowedMentionUserIds);
      const authorDisplayName = getMessageAuthorDisplayName(message);
      if (mentionedUsers.size > 0) {
        mentionedUsers.forEach((name, id) => {
          console.log(`👥 [CLIENT] User mentioned: ${name} (${id})`);
        });
      }

      // Fetch recent channel history and convert to chat turns
      let channelTurns: import('../services/openai').ChatMessage[] | undefined;
      if (canType) {
        try {
          const channelMessages = await channelHistoryService.fetchChannelHistory(message.channel as TextChannel | ThreadChannel | NewsChannel | VoiceChannel | StageChannel | DMChannel, message.id);
          if (channelMessages.length > 0) {
            channelTurns = channelHistoryService.convertToTurns(channelMessages, this.client.user?.id);
            console.log(`📜 [CLIENT] Converted ${channelMessages.length} channel messages to ${channelTurns.length} chat turns`);
          }
        } catch (error) {
          console.warn('📜 [CLIENT] Failed to fetch channel history:', error);
        }
      }

      // Create callback to check user's listening activity
      const getUserListeningActivity = async (targetUserId: string) => {
        try {
          // Only check if we're in a guild
          if (!message.guild) {
            return null;
          }

          // Fetch the member from the guild
          const member = await message.guild.members.fetch({
            user: targetUserId,
            withPresences: true
          });

          if (!member) {
            return null;
          }

          // Get their listening activity
          return userActivityService.getMusicActivity(member);
        } catch (error) {
          console.error(`❌ [CLIENT] Failed to get listening activity for ${targetUserId}:`, error);
          return null;
        }
      };

      // Extract web page content from URLs in message
      const pageContents = config.pageExtraction.enabled
        ? await pageExtractorService.extractPagesFromMessage(cleanedContent)
        : [];

      const requestCollectiveKnowledge = this.buildCollectiveKnowledgeRequester(
        `direct-${message.id}`,
        `direct-${message.id}`,
        message.guildId || undefined,
      );
      const allowNsfwImageGeneration = canUserRequestNsfwImages(message.channel, message.author.id);
      if (allowNsfwImageGeneration) {
        console.log(`🔞 [CLIENT] NSFW image generation enabled in NSFW channel ${message.channelId}`);
      }

      // Generate response with tool availability attached for model-directed use
      const response = await handleMessage({
        content: contentWithStickers,
        imageUrls,
        videoUrls,
        textAttachments,
        pageContents: pageContents.length > 0 ? pageContents : undefined,
        userId: message.author.id,
        username: authorDisplayName,
        guildId: message.guildId || 'dm',
        mentionedUsers,
        replyContext: replyContext ? {
          isReply: replyContext.isReply,
          isReplyToLumia: replyContext.isReplyToLumia,
          originalContent: replyContext.originalContent,
          originalTimestamp: replyContext.originalTimestamp,
          originalAuthor: replyContext.originalAuthor,
        } : undefined,
        boredomAction,
        channelMessages: channelTurns,
        getUserListeningActivity,
        resolveUserMention,
        allowNsfwImageGeneration,
        requestCollectiveKnowledge,
      });

      // Clear typing indicator before sending response
      this.stopTyping(message.channelId);

      // Cross-path reply guard: prevent double replies if the orchestrator path
      // also processed this message (or any other duplicate trigger).
      if (this.hasAlreadyReplied(message.id)) {
        console.warn(`⚠️ [CLIENT] Suppressing duplicate reply for message ${message.id} (direct path blocked by cross-path guard)`);
        return;
      }

      // Discord has a 2000 character limit for messages; escape before truncating
      // because inserted Markdown backslashes count toward that limit.
      const formattedResponse = formatDiscordResponseText(response.text);
      const allowedMentions = buildAllowedMentions(allowedMentionUserIds);

      // Check if channel is still available before sending (bot may have been kicked)
      if (!message.channel) {
        console.warn('⚠️ [CLIENT] Cannot send message - channel no longer available (bot may have been kicked)');
        return;
      }

      // Send the text response and any generated image attachments
      // Use failIfNotExists: false to handle cases where the message being replied to
      // is a forwarded message or has been deleted
      let sentMessage;
      const files = buildDiscordImageFiles(response.attachments);
      try {
        sentMessage = await message.reply({
          content: formattedResponse || undefined,
          allowedMentions,
          files,
          failIfNotExists: false,
        });
      } catch (replyError) {
        // Only fall back when the reply target is genuinely unavailable.
        // For generic failures, rethrow so we don't risk posting the same reply twice.
        if (!isReplyReferenceFailure(replyError)) {
          throw replyError;
        }

        console.warn('⚠️ [CLIENT] Reply target unavailable, sending as regular message:', replyError);
        if (message.channel instanceof TextChannel ||
            message.channel instanceof ThreadChannel ||
            message.channel instanceof NewsChannel ||
            message.channel instanceof VoiceChannel ||
            message.channel instanceof StageChannel ||
            message.channel instanceof DMChannel) {
          sentMessage = await message.channel.send({
            content: formattedResponse ? `${message.author} ${formattedResponse}` : `${message.author}`,
            allowedMentions: buildAllowedMentions([...allowedMentionUserIds, message.author.id]),
            files,
          });
        } else {
          throw replyError;
        }
      }

      // Add reactions if any were specified
      if (response.reactions.length > 0) {
        for (const emoji of response.reactions) {
          try {
            await message.react(emoji);
            console.log(`😀 [CLIENT] Added reaction: ${emoji}`);
          } catch (reactError) {
            console.error(`❌ [CLIENT] Failed to add reaction "${emoji}":`, reactError);
          }
        }
      }

      // Record this interaction for boredom system
      const guildId = message.guildId || 'dm';
      const channelId = message.channelId;

      boredomService.recordInteraction(
        message.author.id,
        guildId,
        message.author.username,
        channelId,
        (userId, guildId, username, channelId) => {
          // This callback is called when boredom timer fires
          this.sendBoredomPing(userId, guildId, channelId);
        }
      );

    } catch (error) {
      // Clear typing indicator on error too
      this.stopTyping(message.channelId);
      console.error('Message response error:', error);
      // Check if channel is still available before trying to send error message
      if (!message.channel) {
        console.warn('⚠️ [CLIENT] Cannot send error message - channel no longer available (bot may have been kicked)');
        return;
      }
      try {
        await message.reply(getErrorMessage('generic_error'));
      } catch (replyError) {
        console.error('❌ [CLIENT] Failed to send error reply:', replyError);
      }
    } finally {
      this.endGeneration(generationKey);
    }
  }

  /**
   * Send a boredom ping to a user
   */
  private async sendBoredomPing(userId: string, guildId: string, channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.log(`😴 [BOREDOM] Channel ${channelId} not found or not text-based`);
        return;
      }

      // NSFW-only mode: never proactively ping outside an NSFW channel.
      if (config.bot.nsfwOnly && !isDiscordNsfwChannel(channel)) {
        console.log(`🔞 [BOREDOM] NSFW-only mode: skipping ping in non-NSFW channel ${channelId}`);
        return;
      }

      const message = getRandomBoredomMessage(userId);
      await (channel as TextChannel).send(message);
      console.log(`😴 [BOREDOM] Sent boredom ping to ${userId} in channel ${channelId}`);
    } catch (error) {
      console.error(`❌ [BOREDOM] Failed to send boredom ping:`, error);
    }
  }

  /**
   * Handle an orchestrated mention
   */
  private async handleOrchestratedMention(
    message: Message,
    replyContext?: ReplyContext
  ): Promise<void> {
    if (!this.orchestrator) return;

    console.log(`🎭 [Orchestrator] Handling orchestrated mention - NOTIFYING ONLY`);

    const eventId = `evt-${message.id}`;
    const botId = this.client.user?.id;

    // Determine which bot IDs to include in the orchestrator mention.
    // If this bot is directly @mentioned, include all @mentioned bots (multi-bot coordination).
    // If this bot is only triggered by keywords, include only itself — don't drag
    // @mentioned bots into a banter session they may already be handling directly.
    const mentionedBots = message.mentions.users.filter(user => user.bot);
    const isSelfMentioned = botId ? mentionedBots.has(botId) : false;
    let mentionedBotIds: string[];

    if (isSelfMentioned) {
      // Bot was @mentioned — include all mentioned bots for coordination
      mentionedBotIds = mentionedBots.map(user => user.id);
    } else {
      // Bot was triggered by keywords only — only include itself
      mentionedBotIds = botId ? [botId] : [];
    }

    // Extract trigger keywords that matched for this bot
    const triggerKeywords = extractTriggerKeywords(message.content);

    // Extract modal content (images, videos, text files) from the message
    const imageUrls: string[] = [];
    const videoUrls: MediaAttachment[] = [];
    const textAttachments: TextAttachment[] = [];

    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/gif')) {
          videoUrls.push({
            url: attachment.url,
            mimeType: attachment.contentType,
          });
          console.log(`🎬 [Orchestrator] GIF found in message (will convert to WebM): ${attachment.name} (${attachment.contentType})`);
        } else if (attachment.contentType?.startsWith('image/')) {
          imageUrls.push(attachment.url);
          console.log(`🖼️  [Orchestrator] Image found in message: ${attachment.name} (${attachment.contentType})`);
        } else if (attachment.contentType?.startsWith('video/')) {
          videoUrls.push({
            url: attachment.url,
            mimeType: attachment.contentType,
          });
          console.log(`🎥 [Orchestrator] Video found in message: ${attachment.name} (${attachment.contentType})`);
        } else if (attachment.contentType?.startsWith('text/') || 
                  attachment.name.match(/\.(txt|md|json|csv|log|xml|yaml|yml|js|ts|jsx|tsx|py|rb|java|c|cpp|h|hpp|cs|go|rs|php|html|css|scss|sass|less|sql)$/i)) {
          // Text file detected - check size and read content
          const maxSizeBytes = config.attachments.maxTextFileSizeKB * 1024;
          
          // Check file size before downloading
          if (attachment.size > maxSizeBytes) {
            console.log(`📄 [Orchestrator] Text file too large: ${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB > ${config.attachments.maxTextFileSizeKB}KB limit)`);
            textAttachments.push({
              name: attachment.name,
              content: `[File too large: ${(attachment.size / 1024).toFixed(1)}KB. Maximum size is ${config.attachments.maxTextFileSizeKB}KB]`,
            });
            continue;
          }
          
          try {
            console.log(`📄 [Orchestrator] Text file detected: ${attachment.name} (${attachment.contentType || 'unknown type'}, ${(attachment.size / 1024).toFixed(1)}KB)`);
            const response = await fetch(attachment.url);
            if (response.ok) {
              const textContent = await response.text();
              // Limit text content to prevent token overflow
              const maxChars = maxSizeBytes;
              const truncatedContent = textContent.length > maxChars 
                ? textContent.substring(0, maxChars) + '\n... [content truncated]' 
                : textContent;
              textAttachments.push({
                name: attachment.name,
                content: truncatedContent,
              });
              console.log(`📄 [Orchestrator] Read text file: ${attachment.name} (${truncatedContent.length} chars)`);
            } else {
              console.warn(`⚠️ [Orchestrator] Failed to fetch text file ${attachment.name}: ${response.status}`);
            }
          } catch (error) {
            console.error(`❌ [Orchestrator] Error reading text file ${attachment.name}:`, error);
          }
        }
      }
    }

    // Extract embeds from current message (Tenor GIFs, link previews, etc.)
    if (message.embeds.length > 0) {
      for (const embed of message.embeds) {
        const embedType = embed.data?.type;

        if (embedType === 'gifv' && embed.video?.url) {
          videoUrls.push({ url: embed.video.url, mimeType: 'image/gif' });
          console.log(`🎬 [Orchestrator] GIFV embed in message: ${embed.url || embed.video.url}`);
        } else if (embedType === 'video' && embed.video?.url) {
          videoUrls.push({ url: embed.video.proxyURL || embed.video.url, mimeType: 'video/mp4' });
          console.log(`🎥 [Orchestrator] Video embed in message: ${embed.url || embed.video.url}`);
        } else if (embedType === 'image' && embed.image?.url) {
          imageUrls.push(embed.image.proxyURL || embed.image.url);
          console.log(`🖼️  [Orchestrator] Image embed in message: ${embed.image.url}`);
        } else if (embedType === 'rich' || embedType === 'article' || embedType === 'link') {
          if (embed.image?.url) {
            imageUrls.push(embed.image.proxyURL || embed.image.url);
            console.log(`🖼️  [Orchestrator] Rich embed image in message: ${embed.image.url}`);
          }
          if (embed.thumbnail?.url) {
            imageUrls.push(embed.thumbnail.proxyURL || embed.thumbnail.url);
            console.log(`🖼️  [Orchestrator] Rich embed thumbnail in message: ${embed.thumbnail.url}`);
          }
        }
      }
    }

    // Merge stickers on the triggering message into the media arrays and content.
    const stickerMedia = extractStickerMedia(message, 'Orchestrator');
    imageUrls.push(...stickerMedia.imageUrls);
    videoUrls.push(...stickerMedia.videoUrls);

    // Extract custom emoji images from message content so the model can see them.
    imageUrls.push(...extractCustomEmojiUrls(message.content, 'Orchestrator'));

    const notifyContent = stickerMedia.stickerHints.length > 0
      ? (message.content
          ? `${message.content} ${stickerMedia.stickerHints.join(' ')}`
          : stickerMedia.stickerHints.join(' '))
      : message.content;

    // Add embedded content from reply context
    if (replyContext?.embeddedContent) {
      imageUrls.push(...replyContext.embeddedContent.images);
      videoUrls.push(...replyContext.embeddedContent.videos);
    }

    // Store the message info and modal content so we can reply when orchestrator asks us to
    this.orchestratorQueue!.set(eventId, {
      message,
      replyContext,
      imageUrls,
      videoUrls,
      textAttachments,
    });

    // Notify orchestrator about the mention (fire and forget)
    this.orchestrator.notifyMention({
      eventId,
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId || 'dm',
      authorId: message.author.id,
      authorName: message.author.username,
      content: notifyContent,
      mentionedBotIds,
      timestamp: message.createdAt,
      triggerKeywords: triggerKeywords.length > 0 ? triggerKeywords : undefined,
      replyContext,
      imageUrls,
      videoUrls,
      textAttachments,
    });

    console.log(`🎭 [Orchestrator] Mention notification sent, returning immediately`);
    // Return immediately - don't wait for orchestrator
    // The orchestrator will send response_request when it's this bot's turn
  }

  async login(): Promise<void> {
    await this.client.login(config.discord.token);
  }

  async destroy(): Promise<void> {
    this.stopAllTyping();
    boredomService.cleanup();
    if (this.orchestrator) {
      this.orchestrator.disconnect();
    }
    await this.client.destroy();
  }

  /**
   * Update orchestrator with current guilds (call this after bot is ready)
   */
  updateOrchestratorGuilds(): void {
    if (this.orchestrator) {
      const guilds = Array.from(this.client.guilds.cache.keys());
      const status = this.orchestrator.getConnectionStatus();
      
      console.log(`[Orchestrator] Updating guilds: ${guilds.length} guilds (connected: ${status.isConnected})`);
      
      // Use forceGuildUpdate to ensure it gets sent even if not connected yet
      this.orchestrator.forceGuildUpdate(guilds);
    }
  }

  /**
   * Get orchestrator connection status
   */
  getOrchestratorStatus(): { isConnected: boolean; hasPendingGuildUpdate: boolean; pendingGuildCount: number } | null {
    if (!this.orchestrator) return null;
    return this.orchestrator.getConnectionStatus();
  }
}

export const bot = new DiscordBot();
