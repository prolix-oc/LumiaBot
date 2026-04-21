import { Database } from 'bun:sqlite';
import type { ResponseRequestPayload } from './types';

export type OrchestratorTurnState =
  | 'received'
  | 'claimed'
  | 'generating'
  | 'generated'
  | 'discord_sent'
  | 'completion_sent'
  | 'acknowledged'
  | 'failed';

export interface OrchestratorTurnRecord {
  turnId: string;
  eventId: string;
  state: OrchestratorTurnState;
  instanceId?: string;
  payload?: ResponseRequestPayload;
  responseText?: string;
  responseMessageId?: string;
  lastError?: string;
  updatedAt: string;
  createdAt: string;
}

interface TurnRow {
  turn_id: string;
  event_id: string;
  state: OrchestratorTurnState;
  instance_id: string | null;
  payload_json: string | null;
  response_text: string | null;
  response_message_id: string | null;
  last_error: string | null;
  updated_at: string;
  created_at: string;
}

export class OrchestratorTurnJournal {
  private db: Database;

  constructor(filename: string = 'orchestrator_turns.db') {
    this.db = new Database(filename);
    this.init();
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orchestrator_turns (
        turn_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        state TEXT NOT NULL,
        instance_id TEXT,
        payload_json TEXT,
        response_text TEXT,
        response_message_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_turns_event_id ON orchestrator_turns(event_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_turns_state ON orchestrator_turns(state)');
  }

  getTurn(turnId: string): OrchestratorTurnRecord | undefined {
    const row = this.db.query(
      `SELECT turn_id, event_id, state, instance_id, payload_json, response_text,
              response_message_id, last_error, updated_at, created_at
       FROM orchestrator_turns
       WHERE turn_id = ?`
    ).get(turnId) as TurnRow | null;

    if (!row) {
      return undefined;
    }

    return {
      turnId: row.turn_id,
      eventId: row.event_id,
      state: row.state,
      instanceId: row.instance_id ?? undefined,
      payload: row.payload_json ? JSON.parse(row.payload_json) as ResponseRequestPayload : undefined,
      responseText: row.response_text ?? undefined,
      responseMessageId: row.response_message_id ?? undefined,
      lastError: row.last_error ?? undefined,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    };
  }

  markReceived(payload: ResponseRequestPayload, instanceId: string): void {
    this.upsert(payload.turnId, payload.eventId, 'received', instanceId, payload);
  }

  markClaimed(turnId: string, eventId: string, instanceId: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'claimed', instanceId, payload);
  }

  markGenerating(turnId: string, eventId: string, instanceId: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'generating', instanceId, payload);
  }

  markGenerated(turnId: string, eventId: string, instanceId: string, responseText: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'generated', instanceId, payload, responseText);
  }

  markDiscordSent(turnId: string, eventId: string, instanceId: string, responseText: string, responseMessageId: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'discord_sent', instanceId, payload, responseText, responseMessageId);
  }

  markCompletionSent(turnId: string, eventId: string, instanceId: string, responseText: string, responseMessageId?: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'completion_sent', instanceId, payload, responseText, responseMessageId);
  }

  markAcknowledged(turnId: string): void {
    const existing = this.getTurn(turnId);
    if (!existing) {
      return;
    }

    this.upsert(
      turnId,
      existing.eventId,
      'acknowledged',
      existing.instanceId,
      existing.payload,
      existing.responseText,
      existing.responseMessageId,
      undefined
    );
  }

  markFailed(turnId: string, eventId: string, instanceId: string, error: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'failed', instanceId, payload, undefined, undefined, error);
  }

  private upsert(
    turnId: string,
    eventId: string,
    state: OrchestratorTurnState,
    instanceId?: string,
    payload?: ResponseRequestPayload,
    responseText?: string,
    responseMessageId?: string,
    lastError?: string
  ): void {
    const existing = this.getTurn(turnId);
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO orchestrator_turns (
         turn_id,
         event_id,
         state,
         instance_id,
         payload_json,
         response_text,
         response_message_id,
         last_error,
         updated_at,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET
         event_id = excluded.event_id,
         state = excluded.state,
         instance_id = excluded.instance_id,
         payload_json = COALESCE(excluded.payload_json, orchestrator_turns.payload_json),
         response_text = COALESCE(excluded.response_text, orchestrator_turns.response_text),
         response_message_id = COALESCE(excluded.response_message_id, orchestrator_turns.response_message_id),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        turnId,
        eventId,
        state,
        instanceId ?? existing?.instanceId ?? null,
        payload ? JSON.stringify(payload) : existing?.payload ? JSON.stringify(existing.payload) : null,
        responseText ?? existing?.responseText ?? null,
        responseMessageId ?? existing?.responseMessageId ?? null,
        lastError ?? null,
        now,
        existing?.createdAt ?? now,
      ]
    );
  }
}

export const orchestratorTurnJournal = new OrchestratorTurnJournal();
