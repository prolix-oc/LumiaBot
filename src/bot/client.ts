import { Client, Collection, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel, GuildMember } from 'discord.js';
import { config } from '../utils/config';
import { shouldTriggerBot, extractMessageContent, handleMessage, extractTriggerKeywords } from '../services/message-handler';
import { boredomService, getRandomBoredomMessage } from '../services/boredom';
import { channelHistoryService } from '../services/channel-history';
import { getErrorMessage } from '../services/prompts';
import { userActivityService } from '../services/user-activity';
import type { ChatInputCommandInteraction } from 'discord.js';
import { LumiaBotIntegration } from '../services/orchestrator';
import type { MessageContext } from '../services/orchestrator/types';

export interface Command {
  data: {
    name: string;
    description: string;
    toJSON: () => unknown;
  };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
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

export class DiscordBot {
  public client: Client;
  public commands: Collection<string, Command>;
  private typingIntervals: Map<string, Timer>; // channelId -> timer
  private orchestrator?: LumiaBotIntegration;
  private orchestratorQueue: Map<string, { message: Message; replyContext: any; imageUrls: string[]; videoUrls: { url: string; mimeType?: string }[]; textAttachments: { name: string; content: string }[] }>; // eventId -> message info

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
    this.setupEventHandlers();
    this.setupOrchestrator();
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
      reconnectIntervalMs: config.orchestrator.reconnectIntervalMs,
      maxReconnectAttempts: config.orchestrator.maxReconnectAttempts,
    });

    // Set up response handler for orchestrator
    this.orchestrator.setResponseHandler(async (context: MessageContext, eventId: string) => {
      return this.handleOrchestratorResponse(context, eventId);
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
  private async handleOrchestratorResponse(context: MessageContext, eventId: string): Promise<string> {
    console.log('[Orchestrator] Generating response for event', {
      eventId,
      turnCount: context.turnCount,
      maxTurns: context.maxTurns,
      isBanter: context.isBanter,
    });

    // Look up the original message from the queue but DON'T delete it —
    // follow-up turns reuse the same eventId and need the Discord message object
    // to call message.reply(). The queue entry is cleaned up when the orchestrator
    // session ends (via responseReadyCallback) or on bot restart.
    const queuedInfo = this.orchestratorQueue.get(eventId);
    if (!queuedInfo) {
      console.error(`[Orchestrator] No queued message found for event ${eventId}`);
      return '';
    }

    const { message, replyContext, imageUrls, videoUrls, textAttachments } = queuedInfo;

    // Get the last message from context
    const lastMessage = context.previousMessages[context.previousMessages.length - 1];
    if (!lastMessage) {
      console.error('[Orchestrator] No last message in context');
      return '';
    }

    try {
      // Extract mentioned users from the original Discord message.
      // In orchestrator mode the message content contains raw <@id> patterns;
      // resolving them here gives the AI system prompt the "USERS MENTIONED"
      // section and enables user-related tools (opinions, pronouns, etc.).
      const mentionedUsers = new Map<string, string>();
      if (message.mentions.users.size > 0) {
        message.mentions.users.forEach((user) => {
          mentionedUsers.set(user.id, user.username);
          console.log(`👥 [Orchestrator] User mentioned: ${user.username} (${user.id})`);
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
                  mentionedUsers.set(userId, member.user.username);
                  console.log(`👥 [Orchestrator] Resolved mention from context: ${member.user.username} (${userId})`);
                }
              } catch {
                // Silently skip unresolvable mentions
              }
            }
          }
        }
      }

      // Build conversation history from context
      const channelHistory = context.previousMessages
        .filter(m => m.id !== lastMessage.id) // Exclude the current message
        .map(m => `${m.isBot ? 'Bot' : 'User'} ${m.authorName}: ${m.content}`)
        .join('\n');

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

      // Generate response using the existing message handler
      const response = await handleMessage({
        content: lastMessage.content,
        imageUrls,
        videoUrls,
        textAttachments,
        userId: lastMessage.authorId,
        username: lastMessage.authorName,
        guildId: message.guildId || 'dm',
        mentionedUsers,
        replyContext: replyContext ? {
          isReply: replyContext.isReply,
          originalContent: replyContext.originalContent,
          originalTimestamp: replyContext.originalTimestamp,
        } : undefined,
        channelHistory: channelHistory || undefined,
        getUserListeningActivity,
        // Orchestrator follow-up support: allow the LLM to request another turn
        orchestratorEventId: eventId,
        requestFollowUp: this.orchestrator
          ? (evtId, targetBotId, reason) => this.orchestrator!.requestFollowUp(evtId, targetBotId, reason)
          : undefined,
      });

      // Send the response directly to Discord
      if (response.text && response.text.trim()) {
        console.log(`[Orchestrator] Sending response to Discord for event ${eventId}`);
        await message.reply({
          content: response.text,
          failIfNotExists: false,
        });
      }

      return response.text;
    } catch (error) {
      console.error('[Orchestrator] Failed to generate or send response:', error);
      return '';
    }
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
          
          console.log(`💬 [CLIENT] Reply detected to ${isReplyToLumia ? 'Lumia' : referencedMessage.author.username}: "${referencedMessage.content.slice(0, 100)}..."`);
          
          // Extract embedded content from referenced message
          const embeddedImages: string[] = [];
          const embeddedVideos: { url: string; mimeType?: string }[] = [];
          
          if (referencedMessage.attachments.size > 0) {
            referencedMessage.attachments.forEach((attachment) => {
              if (attachment.contentType?.startsWith('image/gif')) {
                embeddedVideos.push({
                  url: attachment.url,
                  mimeType: attachment.contentType,
                });
                console.log(`🎬 [CLIENT] Referenced GIF: ${attachment.name}`);
              } else if (attachment.contentType?.startsWith('image/')) {
                embeddedImages.push(attachment.url);
                console.log(`🖼️  [CLIENT] Referenced image: ${attachment.name}`);
              } else if (attachment.contentType?.startsWith('video/')) {
                embeddedVideos.push({
                  url: attachment.url,
                  mimeType: attachment.contentType,
                });
                console.log(`🎥 [CLIENT] Referenced video: ${attachment.name}`);
              }
            });
          }
          
          replyContext = {
            isReply: true,
            isReplyToLumia,
            originalContent: referencedMessage.content,
            originalTimestamp: formatTimeAgo(referencedMessage.createdAt),
            originalAuthor: referencedMessage.author.username,
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

      if (shouldTrigger) {
        // Check if orchestrator should handle this mention
        if (this.shouldUseOrchestrator(message)) {
          await this.handleOrchestratedMention(message, replyContext);
          return;
        }

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
        
        // Don't respond if there's no actual content after removing triggers (only for explicit triggers)
        if (hasTrigger && !cleanedContent.trim()) {
          // Check if channel is still available (bot may have been kicked)
          if (!message.channel) {
            console.warn('⚠️ [CLIENT] Cannot reply - channel no longer available (bot may have been kicked)');
            return;
          }
          await message.reply('You summoned me but forgot to say what you wanted! How can I help you?');
          return;
        }

        try {
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

          // Add embedded content from reply context
          if (replyContext?.embeddedContent) {
            imageUrls.push(...replyContext.embeddedContent.images);
            videoUrls.push(...replyContext.embeddedContent.videos);
          }

          // Extract mentioned users for context parsing
          const mentionedUsers = new Map<string, string>();
          if (message.mentions.users.size > 0) {
            message.mentions.users.forEach((user) => {
              mentionedUsers.set(user.id, user.username);
              console.log(`👥 [CLIENT] User mentioned: ${user.username} (${user.id})`);
            });
          }

          // Fetch recent channel history for context
          let channelHistory: string | undefined;
          if (canType) {
            try {
              const channelMessages = await channelHistoryService.fetchChannelHistory(message.channel as TextChannel | ThreadChannel | NewsChannel | VoiceChannel | StageChannel | DMChannel, message.id);
              channelHistory = channelHistoryService.formatHistoryForPrompt(channelMessages, message.author.id, this.client.user?.id, message.author.username);
              if (channelHistory) {
                console.log(`📜 [CLIENT] Added channel history context (${channelMessages.length} messages)`);
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

          // Generate response (search intent detected automatically via heuristics)
          const response = await handleMessage({
            content: cleanedContent,
            imageUrls,
            videoUrls,
            textAttachments,
            userId: message.author.id,
            username: message.author.username,
            guildId: message.guildId || 'dm',
            mentionedUsers,
            replyContext: replyContext ? {
              isReply: replyContext.isReply,
              originalContent: replyContext.originalContent,
              originalTimestamp: replyContext.originalTimestamp,
            } : undefined,
            boredomAction,
            channelHistory,
            getUserListeningActivity,
          });

          // Clear typing indicator before sending response
          this.stopTyping(message.channelId);
          
          // Discord has a 2000 character limit for messages
          const truncatedResponse = response.text.length > 1950 
            ? response.text.slice(0, 1950) + '... (message truncated)' 
            : response.text;

          // Check if channel is still available before sending (bot may have been kicked)
          if (!message.channel) {
            console.warn('⚠️ [CLIENT] Cannot send message - channel no longer available (bot may have been kicked)');
            return;
          }

          // Send the text response
          // Use failIfNotExists: false to handle cases where the message being replied to
          // is a forwarded message or has been deleted
          let sentMessage;
          try {
            sentMessage = await message.reply({
              content: truncatedResponse,
              failIfNotExists: false,
            });
          } catch (replyError) {
            // If reply fails (e.g., unknown message reference), send as regular message
            console.warn('⚠️ [CLIENT] Reply failed, sending as regular message:', replyError);
            const { TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel } = await import('discord.js');
            if (message.channel instanceof TextChannel ||
                message.channel instanceof ThreadChannel ||
                message.channel instanceof NewsChannel ||
                message.channel instanceof VoiceChannel ||
                message.channel instanceof StageChannel ||
                message.channel instanceof DMChannel) {
              sentMessage = await message.channel.send({
                content: `${message.author} ${truncatedResponse}`,
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
        }
      }
    });
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
    replyContext: any
  ): Promise<void> {
    if (!this.orchestrator) return;

    console.log(`🎭 [Orchestrator] Handling orchestrated mention - NOTIFYING ONLY`);

    const eventId = `evt-${message.id}`;
    const botId = this.client.user?.id;

    // Get all mentioned bots from the message
    const mentionedBots = message.mentions.users.filter(user => user.bot);
    const mentionedBotIds = mentionedBots.map(user => user.id);

    // Add this bot to the list if not already present
    if (botId && !mentionedBotIds.includes(botId)) {
      mentionedBotIds.push(botId);
    }

    // Note: The orchestrator will check its registry to find which bots are registered
    // We only send bots that are @mentioned or triggered by keywords
    // The orchestrator handles coordination with registered bots only

    // Extract trigger keywords that matched for this bot
    const triggerKeywords = extractTriggerKeywords(message.content);

    // Extract modal content (images, videos, text files) from the message
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
      content: message.content,
      mentionedBotIds,
      timestamp: message.createdAt,
      triggerKeywords: triggerKeywords.length > 0 ? triggerKeywords : undefined,
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
