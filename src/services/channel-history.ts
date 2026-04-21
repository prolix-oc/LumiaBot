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

type TurnFormat = 'default' | 'orchestrator';

interface PromptTurn {
  role: 'user' | 'assistant';
  content: string;
  speakerKey: string;
}

export class ChannelHistoryService {
  private readonly maxMessages: number;
  private readonly maxMessageLength: number;

  constructor() {
    this.maxMessages = config.channel.maxHistoryLength;
    this.maxMessageLength = 200; // Truncate long messages
  }

  private escapeAttribute(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private buildPromptTurn(message: ChannelMessage, currentBotId?: string, format: TurnFormat = 'default'): PromptTurn {
    const isCurrentBot = message.isBot && message.authorId === currentBotId;

    if (isCurrentBot) {
      return {
        role: 'assistant',
        content: message.content,
        speakerKey: `assistant:${message.authorId}`,
      };
    }

    if (format === 'orchestrator') {
      const tagName = message.isBot ? 'orchestrator-bot-message' : 'orchestrator-user-message';
      const speaker = this.escapeAttribute(message.authorUsername || (message.isBot ? 'Unknown Bot' : 'Unknown User'));

      return {
        role: 'user',
        content: `<${tagName} speaker="${speaker}" authorId="${message.authorId}">\n${message.content}\n</${tagName}>`,
        speakerKey: `user:${message.isBot ? 'bot' : 'human'}:${message.authorId}`,
      };
    }

    let displayName = message.authorUsername;
    if (message.isBot && message.authorId !== currentBotId) {
      displayName = displayName.replace(/\s*Lumia\s*/gi, '').trim() || 'Other Bot';
    }

    return {
      role: 'user',
      content: `[${displayName}]: ${message.content}`,
      speakerKey: `user:${message.isBot ? 'bot' : 'human'}:${message.authorId}`,
    };
  }

  private mergePromptTurns(turns: PromptTurn[]): ChatMessage[] {
    const merged: Array<ChatMessage & { speakerKey: string }> = [];

    for (const turn of turns) {
      const last = merged[merged.length - 1];
      if (last && last.role === turn.role && last.speakerKey === turn.speakerKey && typeof last.content === 'string') {
        last.content += '\n\n' + turn.content;
      } else {
        merged.push({ role: turn.role, content: turn.content, speakerKey: turn.speakerKey });
      }
    }

    return merged.map(({ speakerKey: _speakerKey, ...message }) => message);
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
        if (!message.content.trim() && message.attachments.size === 0 && message.stickers.size === 0) {
          return;
        }

        // Build content including attachment and sticker info
        let content = message.content;
        const annotations: string[] = [];
        if (message.attachments.size > 0) {
          annotations.push(...message.attachments.map(att => {
            if (att.contentType?.startsWith('image/')) return '[image]';
            if (att.contentType?.startsWith('video/')) return '[video]';
            return '[file]';
          }));
        }
        if (message.stickers.size > 0) {
          annotations.push(...message.stickers.map(s => `[sticker: ${s.name}]`));
        }
        if (annotations.length > 0) {
          const annotationInfo = annotations.join(' ');
          content = content ? `${content} ${annotationInfo}` : annotationInfo;
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

    const rawTurns = messages.map((message) => this.buildPromptTurn(message, currentBotId, 'default'));
    return this.mergePromptTurns(rawTurns);
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

    const rawTurns = channelMessages.map((message) => this.buildPromptTurn(message, currentBotId, 'orchestrator'));
    return this.mergePromptTurns(rawTurns);
  }

  convertMessageToTurn(
    message: Pick<ChannelMessage, 'id' | 'authorId' | 'authorUsername' | 'content' | 'timestamp' | 'isBot'>,
    currentBotId?: string,
    format: TurnFormat = 'default'
  ): ChatMessage {
    const channelMessage: ChannelMessage = {
      id: message.id,
      authorId: message.authorId,
      authorUsername: message.authorUsername,
      content: message.content,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      isBot: message.isBot,
    };

    const { role, content } = this.buildPromptTurn(channelMessage, currentBotId, format);
    return { role, content };
  }

  convertOrchestratorMessageToTurn(message: ContextMessage, currentBotId?: string): ChatMessage {
    const { role, content } = this.buildPromptTurn({
      id: message.id,
      authorId: message.authorId,
      authorUsername: message.authorName,
      content: message.content,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      isBot: message.isBot,
    }, currentBotId, 'orchestrator');
    return { role, content };
  }
}

// Singleton instance - uses CHANNEL_MAX_HISTORY from environment
export const channelHistoryService = new ChannelHistoryService();
