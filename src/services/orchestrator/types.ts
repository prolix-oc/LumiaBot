// Orchestrator types for LumiaBot integration

export interface BotPresence {
  botId: string;
  botName: string;
  isOnline: boolean;
  councilName?: string;
  councilProfile?: string;
}

export interface CollectiveKnowledgeCandidate {
  id: number;
  title: string;
  topic: string;
  type: 'document' | 'link' | 'snippet';
  url?: string;
  relevanceScore: number;
  matchedKeywords: string[];
  preview: string;
  excerpt: string;
}

export interface CollectiveKnowledgeResult extends CollectiveKnowledgeCandidate {
  sourceBotId: string;
  sourceBotName: string;
}

export interface MediaAttachment {
  url: string;
  mimeType?: string;
}

export interface TextAttachment {
  name: string;
  content: string;
}

export interface ReplyContext {
  isReply: boolean;
  isReplyToLumia: boolean;
  originalContent?: string;
  originalTimestamp?: string;
  originalAuthor?: string;
  embeddedContent?: {
    images: string[];
    videos: MediaAttachment[];
  };
}

export interface BotScratchpad {
  botId: string;
  botName: string;
  turnsTaken: number;
  lastSpokeTurn: number;
  lastSpokeAt?: Date;
  lastSeenTurn: number;
  lastSeenMessageId?: string;
  wasDirectlyAddressed: boolean;
  unansweredQuestionsSeen: number;
  suppressedResponses: number;
  noveltyPressure: number;
  lastImpulseScore: number;
  lastImpulseReasons: string[];
  lastNoveltyReasons: string[];
  privateNotes: string[];
}

export interface BotImpulse {
  botId: string;
  botName: string;
  score: number;
  noveltyScore?: number;
  reasons: string[];
}

export interface MessageContext {
  previousMessages: ContextMessage[];
  conversationId: string;
  turnCount: number;
  maxTurns: number;
  isBanter: boolean;
  councilFamilyName?: string;
  sessionId?: string;
  sessionMode?: 'coordinated' | 'banter';
  sessionPhase?: 'opening' | 'active' | 'cooldown' | 'closing';
  sessionSummary?: string;
  shouldWrapUp?: boolean;
  scratchpad?: BotScratchpad;
  recentImpulses?: BotImpulse[];
  respondingBotId?: string;
  // Who this bot is replying to (for natural conversational context)
  replyingToBotId?: string;
  replyingToBotName?: string;
  // Discord message ID to reply to (for threading bot responses)
  replyToMessageId?: string;
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
  instanceId?: string;
  guilds: string[];
  metadata?: Record<string, any>;
}

export interface HeartbeatPayload {
  botId: string;
  instanceId?: string;
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
  replyContext?: ReplyContext;
  imageUrls?: string[];
  videoUrls?: MediaAttachment[];
  textAttachments?: TextAttachment[];
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
  replyToMessageId?: string;
  eventSnapshot?: MentionPayload;
  deliveryAttempt?: number;
  leaseId?: string;
  leaseExpiresAt?: Date;
}

export interface TurnClaimPayload {
  turnId: string;
  eventId: string;
  botId: string;
  instanceId: string;
  leaseId: string;
}

export interface TurnLeaseRenewedPayload {
  turnId: string;
  eventId: string;
  botId: string;
  instanceId: string;
  leaseId: string;
}

export interface ResponseCompletePayload {
  turnId: string;
  botId: string;
  responseContent: string;
  responseMessageId?: string; // Discord message ID of the bot's response
  nextBotId?: string;
}

export interface FollowUpRequestPayload {
  eventId: string;
  turnId: string;
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

export interface CollectiveKnowledgeQueryPayload {
  queryId: string;
  eventId: string;
  turnId: string;
  botId: string;
  query: string;
  maxResults?: number;
  guildId?: string;
}

export interface CollectiveKnowledgeLookupRequestPayload {
  queryId: string;
  eventId: string;
  turnId: string;
  requestingBotId: string;
  query: string;
  maxResults: number;
  guildId?: string;
}

export interface CollectiveKnowledgeLookupResponsePayload {
  queryId: string;
  eventId: string;
  turnId: string;
  botId: string;
  botName: string;
  results: CollectiveKnowledgeCandidate[];
}

export interface CollectiveKnowledgeResultPayload {
  queryId: string;
  eventId: string;
  turnId: string;
  botId: string;
  query: string;
  results: CollectiveKnowledgeResult[];
  queriedBotIds: string[];
  respondedBotIds: string[];
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
  | { type: 'turn_claimed'; payload: TurnClaimPayload }
  | { type: 'turn_lease_renewed'; payload: TurnLeaseRenewedPayload }
  | { type: 'response_complete'; payload: ResponseCompletePayload }
  | { type: 'response_ack'; payload: { turnId: string; status: string; nextBotId?: string } }
  | { type: 'response_ack_received'; payload: { turnId: string; botId: string; receivedAt: Date } }
  | { type: 'request_follow_up'; payload: FollowUpRequestPayload }
  | { type: 'follow_up_ack'; payload: FollowUpAckPayload }
  | { type: 'banter_invite'; payload: BanterInvitePayload }
  | { type: 'collective_knowledge_query'; payload: CollectiveKnowledgeQueryPayload }
  | { type: 'collective_knowledge_request'; payload: CollectiveKnowledgeLookupRequestPayload }
  | { type: 'collective_knowledge_response'; payload: CollectiveKnowledgeLookupResponsePayload }
  | { type: 'collective_knowledge_result'; payload: CollectiveKnowledgeResultPayload }
  | { type: 'error'; payload: ErrorPayload };

export interface LumiaBotConfig {
  orchestratorUrl: string;
  apiKey: string;
  botId: string;
  botName: string;
  token: string;
  instanceId?: string;
  guilds: string[];
  metadata?: Record<string, any>;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
}

export type ResponseHandler = (payload: ResponseRequestPayload) => Promise<string>;

// Callback for typing indicator - called when bot should start/stop typing
export type TypingCallback = (channelId: string, guildId: string, isTyping: boolean) => void;
