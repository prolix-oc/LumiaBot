// Orchestrator types for LumiaBot integration

export interface BotPresence {
  botId: string;
  botName: string;
  isOnline: boolean;
}

export interface MessageContext {
  previousMessages: ContextMessage[];
  conversationId: string;
  turnCount: number;
  maxTurns: number;
  isBanter: boolean;
  respondingBotId?: string;
  // Spatial awareness: other bots in the same guild
  nearbyBots?: BotPresence[];
}

export interface ContextMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: Date;
  isBot: boolean;
}

export interface BotRegistrationPayload {
  botId: string;
  name: string;
  token: string;
  guilds: string[];
  metadata?: Record<string, any>;
}

export interface HeartbeatPayload {
  botId: string;
  timestamp: Date;
  guilds?: string[];
  status: 'online' | 'idle' | 'dnd';
}

export interface MentionPayload {
  eventId: string;
  messageId: string;
  channelId: string;
  guildId: string;
  authorId: string;
  authorName: string;
  content: string;
  mentionedBotIds: string[];
  timestamp: Date;
  triggerKeywords?: string[]; // Which trigger keywords were matched (optional)
}

export interface ResponseRequestPayload {
  turnId: string;
  eventId: string;
  botId: string;
  context: MessageContext;
  timeoutAt: Date;
  originalMessageId?: string;
  channelId?: string;
  guildId?: string;
}

export interface ResponseCompletePayload {
  turnId: string;
  botId: string;
  responseContent: string;
  nextBotId?: string;
}

export interface FollowUpRequestPayload {
  eventId: string;
  botId: string;
  targetBotId?: string;
  reason?: string;
}

export interface FollowUpAckPayload {
  eventId: string;
  botId: string;
  approved: boolean;
  reason: string;
  turnId?: string;
  queuePosition?: number;
}

export interface BanterInvitePayload {
  sessionId: string;
  inviterBotId: string;
  inviteeBotIds: string[];
  channelId: string;
  guildId: string;
  topic?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: Record<string, any>;
}

export type WebSocketMessage =
  | { type: 'register'; payload: BotRegistrationPayload }
  | { type: 'register_ack'; payload: { success: boolean; botId: string; registeredAt: Date } }
  | { type: 'heartbeat'; payload: HeartbeatPayload }
  | { type: 'heartbeat_ack'; payload: { timestamp: Date; serverTime: number } }
  | { type: 'mention'; payload: MentionPayload }
  | { type: 'mention_ack'; payload: { eventId: string; turnCount: number; coordinated: boolean } }
  | { type: 'response_request'; payload: ResponseRequestPayload }
  | { type: 'response_complete'; payload: ResponseCompletePayload }
  | { type: 'response_ack'; payload: { turnId: string; status: string; nextBotId?: string } }
  | { type: 'request_follow_up'; payload: FollowUpRequestPayload }
  | { type: 'follow_up_ack'; payload: FollowUpAckPayload }
  | { type: 'banter_invite'; payload: BanterInvitePayload }
  | { type: 'error'; payload: ErrorPayload };

export interface LumiaBotConfig {
  orchestratorUrl: string;
  apiKey: string;
  botId: string;
  botName: string;
  token: string;
  guilds: string[];
  metadata?: Record<string, any>;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
}

export type ResponseHandler = (context: MessageContext, eventId: string) => Promise<string>;

// Callback for typing indicator - called when bot should start/stop typing
export type TypingCallback = (channelId: string, guildId: string, isTyping: boolean) => void;
