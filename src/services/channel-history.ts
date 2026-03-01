import type { Message, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel } from 'discord.js';
import { config } from '../utils/config';
import type { ChatMessage } from './openai';
import type { ContextMessage } from './orchestrator/types';

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
   * Convert channel messages into ChatMessage[] turns for the LLM.
   * - Messages from the current bot become assistant role
   * - All other messages (users + other bots) become user role with [displayName]: prefix
   * - Consecutive same-role messages are merged to avoid API errors
   */
  convertToTurns(messages: ChannelMessage[], currentBotId?: string): ChatMessage[] {
    if (messages.length === 0) {
      return [];
    }

    // First pass: assign roles and build display names
    const rawTurns: { role: 'user' | 'assistant'; content: string }[] = messages.map(msg => {
      const isCurrentBot = msg.isBot && msg.authorId === currentBotId;

      if (isCurrentBot) {
        return { role: 'assistant' as const, content: msg.content };
      }

      // For other bots, strip "Lumia" branding to prevent identity confusion
      let displayName = msg.authorUsername;
      if (msg.isBot && msg.authorId !== currentBotId) {
        displayName = displayName.replace(/\s*Lumia\s*/gi, '').trim() || 'Other Bot';
      }

      return { role: 'user' as const, content: `[${displayName}]: ${msg.content}` };
    });

    // Second pass: merge consecutive same-role messages
    const merged: ChatMessage[] = [];
    for (const turn of rawTurns) {
      const last = merged[merged.length - 1];
      if (last && last.role === turn.role && typeof last.content === 'string') {
        last.content += '\n' + turn.content;
      } else {
        merged.push({ role: turn.role, content: turn.content });
      }
    }

    return merged;
  }

  /**
   * Convert orchestrator ContextMessage[] into ChatMessage[] turns.
   * Maps ContextMessage fields to ChannelMessage and delegates to convertToTurns().
   */
  convertOrchestratorToTurns(messages: ContextMessage[], currentBotId?: string): ChatMessage[] {
    const channelMessages: ChannelMessage[] = messages.map(m => ({
      id: m.id,
      authorId: m.authorId,
      authorUsername: m.authorName,
      content: m.content,
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
      isBot: m.isBot,
    }));

    return this.convertToTurns(channelMessages, currentBotId);
  }
}

// Singleton instance - uses CHANNEL_MAX_HISTORY from environment
export const channelHistoryService = new ChannelHistoryService();
