import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  MessageContext,
  WebSocketMessage,
  BotRegistrationPayload,
  HeartbeatPayload,
  MentionPayload,
  ResponseCompletePayload,
  ResponseRequestPayload,
  FollowUpRequestPayload,
  FollowUpAckPayload,
  TurnClaimPayload,
  TurnLeaseRenewedPayload,
  ErrorPayload,
  LumiaBotConfig,
  ResponseHandler,
  TypingCallback,
  CollectiveKnowledgeQueryPayload,
  CollectiveKnowledgeLookupRequestPayload,
  CollectiveKnowledgeLookupResponsePayload,
  CollectiveKnowledgeResultPayload,
  CollectiveKnowledgeCandidate,
} from './types';
import { orchestratorTurnJournal } from './turn-journal';

export class LumiaBotIntegration {
  private ws: WebSocket | null = null;
  private config: Required<LumiaBotConfig>;
  private instanceId: string;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private responseHandler: ResponseHandler | null = null;
  private pendingResponse: ((response: string) => void) | null = null;
  private pendingGuildUpdate: string[] | null = null;
  private guildUpdateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private onConnectCallback: (() => void) | null = null;
  private responseReadyCallback: ((eventId: string, response: string) => void) | null = null;
  private typingCallback: TypingCallback | null = null;
  private pendingFollowUps: Map<string, { eventId: string; resolve: (result: FollowUpAckPayload) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
  private pendingCollectiveKnowledgeQueries: Map<string, { resolve: (result: CollectiveKnowledgeResultPayload) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
  private completedFollowUps: Map<string, { payload: FollowUpAckPayload; completedAt: number }> = new Map();
  private responseMessageIds: Map<string, string> = new Map(); // turnId -> Discord message ID
  private leaseRenewalTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private inFlightTurns: Set<string> = new Set();
  private completedTurns: Map<string, { eventId: string; responseContent: string; responseMessageId?: string; completedAt: number }> = new Map();
  private collectiveKnowledgeHandler: ((payload: CollectiveKnowledgeLookupRequestPayload) => Promise<CollectiveKnowledgeCandidate[]>) | null = null;

  constructor(config: LumiaBotConfig) {
    this.config = {
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 10,
      metadata: {},
      instanceId: config.instanceId || randomUUID(),
      ...config,
    };
    this.instanceId = this.config.instanceId;

    setInterval(() => {
      const staleThreshold = Date.now() - 10 * 60 * 1000;

      for (const [turnId, completed] of this.completedTurns.entries()) {
        if (completed.completedAt < staleThreshold) {
          this.completedTurns.delete(turnId);
        }
      }

      for (const [turnId, completed] of this.completedFollowUps.entries()) {
        if (completed.completedAt < staleThreshold) {
          this.completedFollowUps.delete(turnId);
        }
      }
    }, 60_000);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        console.log('[Orchestrator] Already connected');
        resolve();
        return;
      }

      const wsUrl = `${this.config.orchestratorUrl.replace(/^http/, 'ws')}`;
      console.log(`[Orchestrator] Connecting to ${wsUrl}`);

      try {
        this.ws = new WebSocket(wsUrl, {
          headers: {
            'X-API-Key': this.config.apiKey,
          },
        });

        this.ws.on('open', () => {
          console.log('[Orchestrator] Connected successfully');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.register();
          this.startHeartbeat();
          
          // Call onConnect callback if set
          if (this.onConnectCallback) {
            console.log('[Orchestrator] Calling onConnect callback');
            this.onConnectCallback();
          }
          
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            console.error('[Orchestrator] Failed to parse message:', error);
          }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[Orchestrator] Connection closed: ${code} - ${reason.toString()}`);
          this.handleDisconnect();
        });

        this.ws.on('error', (error: Error) => {
          console.error('[Orchestrator] WebSocket error:', error);
          reject(error);
        });

        // Connection timeout
        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Connection timeout'));
          }
        }, 10000);
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    console.log('[Orchestrator] Disconnecting...');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    for (const timer of this.leaseRenewalTimers.values()) {
      clearInterval(timer);
    }
    this.leaseRenewalTimers.clear();

    for (const pending of this.pendingCollectiveKnowledgeQueries.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCollectiveKnowledgeQueries.clear();

    this.isConnected = false;
    this.reconnectAttempts = 0;
  }

  setResponseHandler(handler: ResponseHandler): void {
    this.responseHandler = handler;
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback;
  }

  updateGuilds(guilds: string[]): void {
    // Store guilds for retry if not connected
    this.pendingGuildUpdate = guilds;
    
    if (!this.isConnected || !this.ws) {
      console.log(`[Orchestrator] Guild update queued (${guilds.length} guilds) - not connected yet`);
      this.scheduleGuildUpdateRetry();
      return;
    }

    this.sendGuildUpdate(guilds);
  }

  private sendGuildUpdate(guilds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[Orchestrator] Cannot send guild update - WebSocket not open');
      this.scheduleGuildUpdateRetry();
      return;
    }

    const payload: HeartbeatPayload = {
      botId: this.config.botId,
      timestamp: new Date(),
      instanceId: this.instanceId,
      guilds,
      status: 'online',
    };

    this.sendMessage({
      type: 'heartbeat',
      payload,
    });

    console.log(`[Orchestrator] Sent guild update: ${guilds.length} guilds`);
    this.pendingGuildUpdate = null;
    
    if (this.guildUpdateRetryTimer) {
      clearTimeout(this.guildUpdateRetryTimer);
      this.guildUpdateRetryTimer = null;
    }
  }

  private scheduleGuildUpdateRetry(): void {
    if (this.guildUpdateRetryTimer) {
      return; // Already scheduled
    }

    this.guildUpdateRetryTimer = setTimeout(() => {
      this.guildUpdateRetryTimer = null;
      if (this.pendingGuildUpdate && this.isConnected) {
        console.log('[Orchestrator] Retrying pending guild update...');
        this.sendGuildUpdate(this.pendingGuildUpdate);
      } else if (this.pendingGuildUpdate) {
        this.scheduleGuildUpdateRetry();
      }
    }, 5000);
  }

  notifyMention(payload: Omit<MentionPayload, 'mentionedBotIds'> & { mentionedBotIds?: string[] }): void {
    if (!this.isConnected || !this.ws) {
      return;
    }

    const fullPayload: MentionPayload = {
      ...payload,
      mentionedBotIds: payload.mentionedBotIds || [this.config.botId],
    };

    this.sendMessage({
      type: 'mention',
      payload: fullPayload,
    });
  }

  private register(): void {
    if (!this.ws) return;

    const payload: BotRegistrationPayload = {
      botId: this.config.botId,
      name: this.config.botName,
      token: this.config.token,
      instanceId: this.instanceId,
      guilds: this.config.guilds,
      metadata: this.config.metadata,
    };

    this.sendMessage({
      type: 'register',
      payload,
    });

    console.log(`[Orchestrator] Registering bot: ${this.config.botName} (${this.config.botId})`);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (!this.isConnected || !this.ws) return;

      const payload: HeartbeatPayload = {
        botId: this.config.botId,
        timestamp: new Date(),
        instanceId: this.instanceId,
        status: 'online',
      };

      this.sendMessage({
        type: 'heartbeat',
        payload,
      });
    }, 30000);
  }

  private handleMessage(message: WebSocketMessage): void {
    switch (message.type) {
      case 'register_ack':
        console.log('[Orchestrator] Registration acknowledged');
        // Send any pending guild update now that we're registered
        if (this.pendingGuildUpdate) {
          console.log('[Orchestrator] Sending pending guild update after registration');
          this.sendGuildUpdate(this.pendingGuildUpdate);
        }
        break;
      case 'heartbeat_ack':
        break;
      case 'mention':
        // This is a mention event from another bot - we need to coordinate
        // This is handled by the client calling notifyMention, not received here
        break;
      case 'mention_ack':
        // Acknowledgement that our mention was received
        console.log(`[Orchestrator] Mention acknowledged: ${(message.payload as any).eventId}`);
        break;
      case 'response_request':
        this.handleResponseRequest(message.payload as ResponseRequestPayload);
        break;
      case 'response_complete':
        // We receive this when another bot completes their response
        console.log('[Orchestrator] Response complete notification received');
        break;
      case 'response_ack':
        // Acknowledgement that our response was received
        this.handleResponseAck(message.payload as { turnId: string; status: string; nextBotId?: string });
        break;
      case 'follow_up_ack':
        this.handleFollowUpAck(message.payload as FollowUpAckPayload);
        break;
      case 'banter_invite':
        console.log('[Orchestrator] Received banter invite');
        break;
      case 'collective_knowledge_request':
        void this.handleCollectiveKnowledgeRequest(message.payload as CollectiveKnowledgeLookupRequestPayload);
        break;
      case 'collective_knowledge_result':
        this.handleCollectiveKnowledgeResult(message.payload as CollectiveKnowledgeResultPayload);
        break;
      case 'error':
        console.error('[Orchestrator] Error:', (message.payload as ErrorPayload).message);
        break;
      default:
        console.warn(`[Orchestrator] Unknown message type: ${(message as any).type}`);
    }
  }

  private async handleResponseRequest(payload: ResponseRequestPayload): Promise<void> {
    console.log(`[Orchestrator] Received response request for turn ${payload.turnId}, event: ${payload.eventId}`, {
      channelId: payload.channelId,
      guildId: payload.guildId,
      hasContext: !!payload.context,
      previousMessages: payload.context?.previousMessages?.length || 0,
      timeoutAt: payload.timeoutAt,
      alreadyInFlight: this.inFlightTurns.has(payload.turnId),
      alreadyCompleted: this.completedTurns.has(payload.turnId),
    });

    const completedTurn = this.completedTurns.get(payload.turnId);
    if (completedTurn) {
      console.warn(`[Orchestrator] Duplicate response_request for completed turn ${payload.turnId} - replaying cached completion`);
      this.sendResponseComplete(payload.turnId, completedTurn.responseContent, completedTurn.responseMessageId);
      return;
    }

    if (this.inFlightTurns.has(payload.turnId)) {
      console.warn(`[Orchestrator] Duplicate response_request for in-flight turn ${payload.turnId} - ignoring replay`);
      return;
    }

    const timeoutAt = new Date(payload.timeoutAt).getTime();
    if (!Number.isNaN(timeoutAt) && timeoutAt < Date.now()) {
      console.warn(`[Orchestrator] Ignoring stale response_request for turn ${payload.turnId} - timeout already elapsed`);
      this.sendResponseComplete(payload.turnId, '');
      return;
    }

    if (!this.responseHandler) {
      console.warn('[Orchestrator] No response handler set');
      this.sendResponseComplete(payload.turnId, '');
      return;
    }

    // ALWAYS start typing indicator if channel/guild info is available
    if (this.typingCallback && payload.channelId && payload.guildId) {
      console.log(`⌨️ [Orchestrator] STARTING typing indicator for channel ${payload.channelId}`);
      this.typingCallback(payload.channelId, payload.guildId, true);
    } else {
      console.warn(`[Orchestrator] Cannot start typing - missing info:`, {
        hasTypingCallback: !!this.typingCallback,
        hasChannelId: !!payload.channelId,
        hasGuildId: !!payload.guildId,
      });
    }

    this.inFlightTurns.add(payload.turnId);

    try {
      console.log(`[Orchestrator] Calling response handler with eventId ${payload.eventId}, turnId ${payload.turnId}...`);
      
      // Call the response handler to generate the response
      const replayableTurn = orchestratorTurnJournal.getTurn(payload.turnId);
      if (replayableTurn?.state === 'completion_sent' || replayableTurn?.state === 'acknowledged' || replayableTurn?.state === 'discord_sent') {
        console.warn(`[Orchestrator] Duplicate response_request for persisted turn ${payload.turnId} - replaying journaled completion`);
        if (this.typingCallback && payload.channelId && payload.guildId) {
          this.typingCallback(payload.channelId, payload.guildId, false);
        }
        this.sendResponseComplete(
          payload.turnId,
          replayableTurn.responseText || '',
          replayableTurn.responseMessageId,
          payload,
        );
        return;
      }

      orchestratorTurnJournal.markReceived(payload, this.instanceId);
      orchestratorTurnJournal.markClaimed(payload.turnId, payload.eventId, this.instanceId, payload);
      this.sendTurnClaimed(payload);
      this.startLeaseRenewal(payload);

      const response = await this.responseHandler(payload);
      
      console.log(`[Orchestrator] Response handler completed, got response of ${response.length} chars`);
      
      // ALWAYS stop typing indicator
      if (this.typingCallback && payload.channelId && payload.guildId) {
        console.log(`⌨️ [Orchestrator] STOPPING typing indicator for channel ${payload.channelId}`);
        this.typingCallback(payload.channelId, payload.guildId, false);
      }
      
      // Retrieve the Discord message ID set by client.ts after sending to Discord
      const discordMessageId = this.responseMessageIds.get(payload.turnId);
      if (discordMessageId) {
        this.responseMessageIds.delete(payload.turnId);
      }

      const journalTurn = orchestratorTurnJournal.getTurn(payload.turnId);
      const resolvedResponse = journalTurn?.responseText ?? response;
      const resolvedMessageId = journalTurn?.responseMessageId ?? discordMessageId;

      this.completedTurns.set(payload.turnId, {
        eventId: payload.eventId,
        responseContent: resolvedResponse,
        responseMessageId: resolvedMessageId,
        completedAt: Date.now(),
      });

      // Send the response back to the orchestrator
      this.sendResponseComplete(payload.turnId, resolvedResponse, resolvedMessageId, payload);

      // Notify client that response is ready
      if (this.responseReadyCallback) {
        console.log(`[Orchestrator] Notifying client that response is ready for event ${payload.eventId}`);
        this.responseReadyCallback(payload.eventId, resolvedResponse);
      }
    } catch (error) {
      console.error('[Orchestrator] Response handler failed:', error);
      orchestratorTurnJournal.markFailed(
        payload.turnId,
        payload.eventId,
        this.instanceId,
        error instanceof Error ? error.message : String(error),
        payload,
      );
      
      // ALWAYS stop typing indicator on error
      if (this.typingCallback && payload.channelId && payload.guildId) {
        console.log(`⌨️ [Orchestrator] STOPPING typing indicator (error) for channel ${payload.channelId}`);
        this.typingCallback(payload.channelId, payload.guildId, false);
      }
      
      this.sendResponseComplete(payload.turnId, '');
      
      // Notify with empty response to prevent hanging
      if (this.responseReadyCallback) {
        this.responseReadyCallback(payload.eventId, '');
      }
    } finally {
      this.stopLeaseRenewal(payload.turnId);
      this.inFlightTurns.delete(payload.turnId);
    }
  }

  setResponseReadyCallback(callback: (eventId: string, response: string) => void): void {
    this.responseReadyCallback = callback;
  }

  setTypingCallback(callback: TypingCallback): void {
    this.typingCallback = callback;
  }

  setCollectiveKnowledgeHandler(handler: (payload: CollectiveKnowledgeLookupRequestPayload) => Promise<CollectiveKnowledgeCandidate[]>): void {
    this.collectiveKnowledgeHandler = handler;
  }

  setResponseMessageId(turnId: string, messageId: string): void {
    this.responseMessageIds.set(turnId, messageId);
  }

  requestCollectiveKnowledge(eventId: string, turnId: string, query: string, maxResults: number = 5, guildId?: string): Promise<CollectiveKnowledgeResultPayload> {
    return new Promise((resolve) => {
      const queryId = randomUUID();

      if (!this.isConnected || !this.ws) {
        resolve({
          queryId,
          eventId,
          turnId,
          botId: this.config.botId,
          query,
          results: [],
          queriedBotIds: [],
          respondedBotIds: [],
        });
        return;
      }

      const payload: CollectiveKnowledgeQueryPayload = {
        queryId,
        eventId,
        turnId,
        botId: this.config.botId,
        query,
        maxResults,
        guildId,
      };

      const timeout = setTimeout(() => {
        this.pendingCollectiveKnowledgeQueries.delete(queryId);
        resolve({
          queryId,
          eventId,
          turnId,
          botId: this.config.botId,
          query,
          results: [],
          queriedBotIds: [],
          respondedBotIds: [],
        });
      }, 10000);

      this.pendingCollectiveKnowledgeQueries.set(queryId, { resolve, timeout });
      this.sendMessage({
        type: 'collective_knowledge_query',
        payload,
      });

      console.log(`[Orchestrator] Sent collective knowledge query ${queryId} for turn ${turnId}`, {
        eventId,
        query,
        maxResults,
      });
    });
  }

  private async handleCollectiveKnowledgeRequest(payload: CollectiveKnowledgeLookupRequestPayload): Promise<void> {
    let results: CollectiveKnowledgeCandidate[] = [];

    if (this.collectiveKnowledgeHandler) {
      try {
        results = await this.collectiveKnowledgeHandler(payload);
      } catch (error) {
        console.error('[Orchestrator] Collective knowledge handler failed:', error);
      }
    }

    const responsePayload: CollectiveKnowledgeLookupResponsePayload = {
      queryId: payload.queryId,
      eventId: payload.eventId,
      turnId: payload.turnId,
      botId: this.config.botId,
      botName: this.config.botName,
      results,
    };

    this.sendMessage({
      type: 'collective_knowledge_response',
      payload: responsePayload,
    });
  }

  private handleCollectiveKnowledgeResult(payload: CollectiveKnowledgeResultPayload): void {
    const pending = this.pendingCollectiveKnowledgeQueries.get(payload.queryId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCollectiveKnowledgeQueries.delete(payload.queryId);
    pending.resolve(payload);
  }

  private sendResponseComplete(turnId: string, responseContent: string, responseMessageId?: string, requestPayload?: ResponseRequestPayload): void {
    const completionPayload: ResponseCompletePayload = {
      turnId,
      botId: this.config.botId,
      responseContent,
      responseMessageId,
    };

    this.sendMessage({
      type: 'response_complete',
      payload: completionPayload,
    });

    const eventId = requestPayload?.eventId || this.completedTurns.get(turnId)?.eventId;
    if (eventId) {
      orchestratorTurnJournal.markCompletionSent(turnId, eventId, this.instanceId, responseContent, responseMessageId, requestPayload);
    }
  }

  /**
   * Request a follow-up turn from the orchestrator.
   * Returns a promise that resolves with the ack payload (approved/denied).
   * Called by the LLM tool execution when the model wants to reply to another bot.
   */
  requestFollowUp(eventId: string, turnId: string, targetBotId?: string, reason?: string): Promise<FollowUpAckPayload> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.ws) {
        resolve({
          eventId,
          botId: this.config.botId,
          approved: false,
          reason: 'not_connected',
        });
        return;
      }

      const completed = this.completedFollowUps.get(turnId)?.payload;
      if (completed) {
        console.log(`[Orchestrator] Reusing completed follow-up request for turn ${turnId}: ${completed.reason}`);
        resolve(completed);
        return;
      }

      const pending = this.pendingFollowUps.get(turnId);
      if (pending) {
        console.log(`[Orchestrator] Follow-up request already pending for turn ${turnId}, waiting for existing ack`);
        const originalResolve = pending.resolve;
        pending.resolve = (result) => {
          originalResolve(result);
          resolve(result);
        };
        return;
      }

      const payload: FollowUpRequestPayload = {
        eventId,
        turnId,
        botId: this.config.botId,
        targetBotId,
        reason,
      };

      // Set up a timeout to avoid hanging forever
      const timeout = setTimeout(() => {
        this.pendingFollowUps.delete(turnId);
        const timeoutPayload: FollowUpAckPayload = {
          eventId,
          botId: this.config.botId,
          approved: false,
          reason: 'timeout',
          turnId,
        };
        resolve(timeoutPayload);
      }, 10000);

      this.pendingFollowUps.set(turnId, { eventId, resolve, timeout });

      this.sendMessage({
        type: 'request_follow_up',
        payload,
      });

      console.log(`[Orchestrator] Sent follow-up request for event ${eventId}, turn ${turnId}`, {
        targetBotId,
        reason,
      });
    });
  }

  private handleFollowUpAck(payload: FollowUpAckPayload): void {
    console.log(`[Orchestrator] Follow-up ${payload.approved ? 'approved' : 'denied'} for event ${payload.eventId}: ${payload.reason}`, {
      turnId: payload.turnId,
      queuePosition: payload.queuePosition,
    });

    const followUpKey = payload.turnId || Array.from(this.pendingFollowUps.entries())
      .find(([, pending]) => pending.eventId === payload.eventId)?.[0];

    if (!followUpKey) {
      if (payload.turnId) {
        this.completedFollowUps.set(payload.turnId, {
          payload,
          completedAt: Date.now(),
        });
        console.log(`[Orchestrator] Stored late follow-up ack for turn ${payload.turnId}`);
      }
      return;
    }

    const pending = this.pendingFollowUps.get(followUpKey);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingFollowUps.delete(followUpKey);
      const resolvedPayload: FollowUpAckPayload = {
        ...payload,
        turnId: payload.turnId || followUpKey,
      };
      this.completedFollowUps.set(followUpKey, {
        payload: resolvedPayload,
        completedAt: Date.now(),
      });
      pending.resolve(resolvedPayload);
    }
  }

  private handleResponseAck(payload: { turnId: string; status: string; nextBotId?: string }): void {
    console.log(`[Orchestrator] Response acknowledged: ${payload.turnId} (${payload.status})`, {
      nextBotId: payload.nextBotId,
    });

    orchestratorTurnJournal.markAcknowledged(payload.turnId);

    this.sendMessage({
      type: 'response_ack_received',
      payload: {
        turnId: payload.turnId,
        botId: this.config.botId,
        receivedAt: new Date(),
      },
    });
  }

  private sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendTurnClaimed(payload: ResponseRequestPayload): void {
    if (!payload.leaseId) {
      return;
    }

    const claimPayload: TurnClaimPayload = {
      turnId: payload.turnId,
      eventId: payload.eventId,
      botId: this.config.botId,
      instanceId: this.instanceId,
      leaseId: payload.leaseId,
    };

    this.sendMessage({
      type: 'turn_claimed',
      payload: claimPayload,
    });
  }

  private sendTurnLeaseRenewed(payload: ResponseRequestPayload): void {
    if (!payload.leaseId) {
      return;
    }

    const renewalPayload: TurnLeaseRenewedPayload = {
      turnId: payload.turnId,
      eventId: payload.eventId,
      botId: this.config.botId,
      instanceId: this.instanceId,
      leaseId: payload.leaseId,
    };

    this.sendMessage({
      type: 'turn_lease_renewed',
      payload: renewalPayload,
    });
  }

  private startLeaseRenewal(payload: ResponseRequestPayload): void {
    if (!payload.leaseId) {
      return;
    }

    this.stopLeaseRenewal(payload.turnId);

    const initialExpiry = payload.leaseExpiresAt ? new Date(payload.leaseExpiresAt).getTime() : NaN;
    const remainingMs = Number.isNaN(initialExpiry) ? 15000 : Math.max(3000, initialExpiry - Date.now());
    const renewEveryMs = Math.max(2000, Math.min(5000, Math.floor(remainingMs / 2)));

    const timer = setInterval(() => {
      if (!this.inFlightTurns.has(payload.turnId)) {
        this.stopLeaseRenewal(payload.turnId);
        return;
      }

      this.sendTurnLeaseRenewed(payload);
    }, renewEveryMs);

    this.leaseRenewalTimers.set(payload.turnId, timer);
  }

  private stopLeaseRenewal(turnId: string): void {
    const timer = this.leaseRenewalTimers.get(turnId);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.leaseRenewalTimers.delete(turnId);
  }

  private handleDisconnect(): void {
    this.isConnected = false;

    for (const timer of this.leaseRenewalTimers.values()) {
      clearInterval(timer);
    }
    this.leaseRenewalTimers.clear();
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.guildUpdateRetryTimer) {
      clearTimeout(this.guildUpdateRetryTimer);
      this.guildUpdateRetryTimer = null;
    }

    for (const pending of this.pendingCollectiveKnowledgeQueries.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCollectiveKnowledgeQueries.clear();

    if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`[Orchestrator] Reconnecting (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((error) => {
          console.error('[Orchestrator] Reconnection failed:', error);
        });
      }, this.config.reconnectIntervalMs);
    } else {
      console.error('[Orchestrator] Max reconnection attempts reached');
    }
  }

  isConnectedToOrchestrator(): boolean {
    return this.isConnected;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Force a guild update - useful for debugging or when guilds change
   */
  forceGuildUpdate(guilds: string[]): void {
    console.log(`[Orchestrator] Forcing guild update: ${guilds.length} guilds`);
    this.pendingGuildUpdate = guilds;
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendGuildUpdate(guilds);
    } else {
      console.log('[Orchestrator] Cannot force update - not connected, will retry when connected');
      this.scheduleGuildUpdateRetry();
    }
  }

  /**
   * Get current connection status for debugging
   */
  getConnectionStatus(): { isConnected: boolean; hasPendingGuildUpdate: boolean; pendingGuildCount: number } {
    return {
      isConnected: this.isConnected,
      hasPendingGuildUpdate: this.pendingGuildUpdate !== null,
      pendingGuildCount: this.pendingGuildUpdate?.length || 0,
    };
  }
}
