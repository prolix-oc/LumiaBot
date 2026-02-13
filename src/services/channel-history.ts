import type { Message, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel } from 'discord.js';
import { config } from '../utils/config';

export interface ChannelMessage {
  id: string;
  authorId: string;
  authorUsername: string;
  content: string;
  timestamp: Date;
  isBot: boolean;
}

export class ChannelHistoryService {
  private readonly maxMessages: number;
  private readonly maxMessageLength: number;

  constructor() {
    this.maxMessages = config.channel.maxHistoryLength;
    this.maxMessageLength = 200; // Truncate long messages
  }

  /**
   * Fetch recent messages from a Discord channel
   * Returns messages in chronological order (oldest first)
   */
  async fetchChannelHistory(
    channel: TextChannel | ThreadChannel | NewsChannel | VoiceChannel | StageChannel | DMChannel,
    beforeMessageId?: string
  ): Promise<ChannelMessage[]> {
    try {
      const fetchOptions: { limit: number; before?: string } = {
        limit: this.maxMessages + 5, // Fetch a few extra to account for filtering
      };

      if (beforeMessageId) {
        fetchOptions.before = beforeMessageId;
      }

      console.log(`📜 [CHANNEL] Fetching last ${this.maxMessages} messages from channel ${channel.id}`);
      
      const messages = await channel.messages.fetch(fetchOptions);
      
      // Convert to array and filter/process
      const processedMessages: ChannelMessage[] = [];
      
      messages.forEach((message: Message) => {
        // Skip the current message (if we're fetching before a specific message)
        if (beforeMessageId && message.id === beforeMessageId) {
          return;
        }

        // Skip empty messages
        if (!message.content.trim() && message.attachments.size === 0) {
          return;
        }

        // Build content including attachment info
        let content = message.content;
        if (message.attachments.size > 0) {
          const attachmentInfo = message.attachments.map(att => {
            if (att.contentType?.startsWith('image/')) return '[image]';
            if (att.contentType?.startsWith('video/')) return '[video]';
            return '[file]';
          }).join(' ');
          content = content ? `${content} ${attachmentInfo}` : attachmentInfo;
        }

        // Truncate very long messages
        if (content.length > this.maxMessageLength) {
          content = content.substring(0, this.maxMessageLength) + '...';
        }

        processedMessages.push({
          id: message.id,
          authorId: message.author.id,
          authorUsername: message.author.username,
          content: content,
          timestamp: message.createdAt,
          isBot: message.author.bot,
        });
      });

      // Reverse to get chronological order (oldest first)
      processedMessages.reverse();

      // Take only the last maxMessages
      const result = processedMessages.slice(-this.maxMessages);

      console.log(`📜 [CHANNEL] Retrieved ${result.length} messages from channel history`);
      return result;

    } catch (error) {
      console.error('📜 [CHANNEL] Failed to fetch channel history:', error);
      return [];
    }
  }

  /**
   * Format channel history for inclusion in system prompt
   * Renames other bots to prevent confusion (strips "Lumia" from other bot names)
   */
  formatHistoryForPrompt(messages: ChannelMessage[], currentUserId: string, currentBotId?: string): string {
    if (messages.length === 0) {
      return '';
    }

    const formatted = messages.map(msg => {
      const isCurrentUser = msg.authorId === currentUserId;
      const isCurrentBot = msg.isBot && msg.authorId === currentBotId;
      const isOtherBot = msg.isBot && msg.authorId !== currentBotId;
      
      let prefix: string;
      if (isCurrentBot) {
        prefix = 'You (Lumia):';
      } else if (isOtherBot) {
        // Rename other bots to strip "Lumia" and prevent confusion
        // "Ditsy Slime Girl Lumia" becomes "Ditsy Slime Girl", "Lumia" becomes "Other Bot"
        let otherBotName = msg.authorUsername.replace(/\s*Lumia\s*/gi, '').trim();
        if (!otherBotName || otherBotName.toLowerCase() === 'lumia') {
          otherBotName = 'Other Bot';
        }
        prefix = `${otherBotName}:`;
      } else if (isCurrentUser) {
        prefix = 'Current User:';
      } else {
        prefix = `${msg.authorUsername}:`;
      }

      return `${prefix} ${msg.content}`;
    }).join('\n');

    return `
## Recent Channel Conversation Context

Here's what has been happening in this channel recently:

${formatted}

Remember: You're participating in an ongoing conversation. Reference the context naturally when relevant, but don't force it!
`;
  }
}

// Singleton instance - uses CHANNEL_MAX_HISTORY from environment
export const channelHistoryService = new ChannelHistoryService();
