import WebSocket from 'ws';
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
  ErrorPayload,
  LumiaBotConfig,
  ResponseHandler,
  TypingCallback,
} from './types';

export class LumiaBotIntegration {
  private ws: WebSocket | null = null;
  private config: Required<LumiaBotConfig>;
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
  private pendingFollowUps: Map<string, { resolve: (result: FollowUpAckPayload) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
  private responseMessageIds: Map<string, string> = new Map(); // eventId -> Discord message ID

  constructor(config: LumiaBotConfig) {
    this.config = {
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 10,
      metadata: {},
      ...config,
    };
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
        console.log(`[Orchestrator] Response acknowledged: ${(message.payload as any).turnId}`);
        break;
      case 'follow_up_ack':
        this.handleFollowUpAck(message.payload as FollowUpAckPayload);
        break;
      case 'banter_invite':
        console.log('[Orchestrator] Received banter invite');
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
    });

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

    try {
      console.log(`[Orchestrator] Calling response handler with eventId ${payload.eventId}...`);
      
      // Call the response handler to generate the response
      const response = await this.responseHandler(payload.context, payload.eventId);
      
      console.log(`[Orchestrator] Response handler completed, got response of ${response.length} chars`);
      
      // ALWAYS stop typing indicator
      if (this.typingCallback && payload.channelId && payload.guildId) {
        console.log(`⌨️ [Orchestrator] STOPPING typing indicator for channel ${payload.channelId}`);
        this.typingCallback(payload.channelId, payload.guildId, false);
      }
      
      // Retrieve the Discord message ID set by client.ts after sending to Discord
      const discordMessageId = this.responseMessageIds.get(payload.eventId);
      if (discordMessageId) {
        this.responseMessageIds.delete(payload.eventId);
      }

      // Send the response back to the orchestrator
      this.sendResponseComplete(payload.turnId, response, discordMessageId);

      // Notify client that response is ready
      if (this.responseReadyCallback) {
        console.log(`[Orchestrator] Notifying client that response is ready for event ${payload.eventId}`);
        this.responseReadyCallback(payload.eventId, response);
      }
    } catch (error) {
      console.error('[Orchestrator] Response handler failed:', error);
      
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
    }
  }

  setResponseReadyCallback(callback: (eventId: string, response: string) => void): void {
    this.responseReadyCallback = callback;
  }

  setTypingCallback(callback: TypingCallback): void {
    this.typingCallback = callback;
  }

  setResponseMessageId(eventId: string, messageId: string): void {
    this.responseMessageIds.set(eventId, messageId);
  }

  private sendResponseComplete(turnId: string, responseContent: string, responseMessageId?: string): void {
    const payload: ResponseCompletePayload = {
      turnId,
      botId: this.config.botId,
      responseContent,
      responseMessageId,
    };

    this.sendMessage({
      type: 'response_complete',
      payload,
    });
  }

  /**
   * Request a follow-up turn from the orchestrator.
   * Returns a promise that resolves with the ack payload (approved/denied).
   * Called by the LLM tool execution when the model wants to reply to another bot.
   */
  requestFollowUp(eventId: string, targetBotId?: string, reason?: string): Promise<FollowUpAckPayload> {
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

      const payload: FollowUpRequestPayload = {
        eventId,
        botId: this.config.botId,
        targetBotId,
        reason,
      };

      // Set up a timeout to avoid hanging forever
      const timeout = setTimeout(() => {
        this.pendingFollowUps.delete(eventId);
        resolve({
          eventId,
          botId: this.config.botId,
          approved: false,
          reason: 'timeout',
        });
      }, 10000);

      this.pendingFollowUps.set(eventId, { resolve, timeout });

      this.sendMessage({
        type: 'request_follow_up',
        payload,
      });

      console.log(`[Orchestrator] Sent follow-up request for event ${eventId}`, {
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

    const pending = this.pendingFollowUps.get(payload.eventId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingFollowUps.delete(payload.eventId);
      pending.resolve(payload);
    }
  }

  private sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleDisconnect(): void {
    this.isConnected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.guildUpdateRetryTimer) {
      clearTimeout(this.guildUpdateRetryTimer);
      this.guildUpdateRetryTimer = null;
    }

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
