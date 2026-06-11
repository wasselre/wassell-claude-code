/**
 * Real-time collaboration for Wassel documents: Yjs CRDT over Supabase
 * Realtime broadcast — no dedicated websocket server.
 *
 * Topology: every open editor of a document joins channel `ydoc:<file_id>`.
 *   - Local Y.Doc updates are buffered ~150 ms (merged via Y.mergeUpdates so
 *     fast typing can't trip Realtime's per-client rate limits) and broadcast
 *     as base64 on event 'yu'; peers apply them. CRDT updates are idempotent
 *     and commutative, so duplicates/reordering are harmless.
 *   - On join, a client broadcasts 'sync-req' with its state vector; every
 *     peer answers 'sync-res' with the missing diff (addressed by clientID,
 *     others ignore it). Redundant answers are merged harmlessly.
 *   - Presence/cursors ride y-protocols Awareness, broadcast on 'aw' with
 *     the same throttling.
 *
 * Persistence: the PAGE bootstraps the Y.Doc — from `wassel_documents.
 * ydoc_state` when present, else seeded ONCE from content_json (guarded by
 * `WHERE ydoc_state IS NULL`; a losing racer re-fetches the winner's blob).
 * Every autosave then persists the merged state alongside content_json, and
 * REMOTE updates also trigger the autosave path, so whichever client saves
 * last persists everyone's edits.
 *
 * Degradation: if the channel errors or Supabase is absent, the editor keeps
 * working single-user off the local Y.Doc; saves still flow.
 */

import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { SCHEMA_EXTENSIONS } from '@/lib/documents/render';
import type { WasselDocumentRow } from '@/types';

/** TipTap's Collaboration extension binds to this Y.XmlFragment name. */
export const Y_FIELD = 'default';

const OUTBOX_MS = 150;

// ─── base64 <-> bytes (binary-safe, chunked to avoid call-stack limits) ──────

export function u8ToB64(u8: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ─── Cursor colors ───────────────────────────────────────────────────────────

const CARET_COLORS = ['#B8734F', '#8E4E3A', '#C09B5F', '#4A6FA5', '#5B8C5A', '#9B5BA5', '#C04949'];

export function caretColorFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return CARET_COLORS[Math.abs(h) % CARET_COLORS.length] ?? '#B8734F';
}

export interface CollabPeer {
  clientId: number;
  name: string;
  color: string;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class SupabaseCollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private channel: RealtimeChannel | null = null;
  private outbox: Uint8Array[] = [];
  private outboxTimer: number | null = null;
  private destroyed = false;

  constructor(doc: Y.Doc, fileId: string, user: { name: string; color: string }) {
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.awareness.setLocalStateField('user', user);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);

    if (!supabase) return; // offline — local-only editing, no channel

    this.channel = supabase.channel(`ydoc:${fileId}`, {
      config: { broadcast: { self: false } },
    });
    this.channel
      .on('broadcast', { event: 'yu' }, ({ payload }) => {
        try {
          Y.applyUpdate(this.doc, b64ToU8(String(payload.u)), 'remote');
        } catch (err) {
          console.error('[collab] bad remote update', err);
        }
      })
      .on('broadcast', { event: 'aw' }, ({ payload }) => {
        try {
          applyAwarenessUpdate(this.awareness, b64ToU8(String(payload.u)), 'remote');
        } catch (err) {
          console.error('[collab] bad awareness update', err);
        }
      })
      .on('broadcast', { event: 'sync-req' }, ({ payload }) => {
        try {
          const diff = Y.encodeStateAsUpdate(this.doc, b64ToU8(String(payload.sv)));
          this.send('sync-res', { to: payload.from, u: u8ToB64(diff) });
          // Introduce ourselves to the newcomer too.
          this.broadcastAwareness([this.doc.clientID]);
        } catch (err) {
          console.error('[collab] sync-req failed', err);
        }
      })
      .on('broadcast', { event: 'sync-res' }, ({ payload }) => {
        if (payload.to !== this.doc.clientID) return;
        try {
          Y.applyUpdate(this.doc, b64ToU8(String(payload.u)), 'remote');
        } catch (err) {
          console.error('[collab] bad sync-res', err);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Ask peers for whatever we're missing + announce presence.
          this.send('sync-req', {
            from: this.doc.clientID,
            sv: u8ToB64(Y.encodeStateVector(this.doc)),
          });
          this.broadcastAwareness([this.doc.clientID]);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Keep editing locally; saves still persist. Loud in console.
          console.error(`[collab] realtime channel ${status} — editing continues locally`);
        }
      });
  }

  private send(event: string, payload: Record<string, unknown>): void {
    if (!this.channel || this.destroyed) return;
    void this.channel.send({ type: 'broadcast', event, payload });
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote' || this.destroyed) return;
    this.outbox.push(update);
    if (this.outboxTimer !== null) return;
    this.outboxTimer = window.setTimeout(() => {
      this.outboxTimer = null;
      if (this.outbox.length === 0) return;
      const merged = this.outbox.length === 1 ? this.outbox[0] : Y.mergeUpdates(this.outbox);
      this.outbox = [];
      if (merged) this.send('yu', { u: u8ToB64(merged) });
    }, OUTBOX_MS);
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === 'remote' || this.destroyed) return;
    this.broadcastAwareness([...added, ...updated, ...removed]);
  };

  private broadcastAwareness(clients: number[]): void {
    if (clients.length === 0) return;
    this.send('aw', { u: u8ToB64(encodeAwarenessUpdate(this.awareness, clients)) });
  }

  /** Peers (NOT including the local client) for presence avatars. */
  peers(): CollabPeer[] {
    const out: CollabPeer[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return;
      const user = (state as { user?: { name?: string; color?: string } }).user;
      out.push({
        clientId,
        name: user?.name ?? '?',
        color: user?.color ?? '#B8734F',
      });
    });
    return out;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.outboxTimer !== null) window.clearTimeout(this.outboxTimer);
    // Tell peers our cursor is gone before tearing the channel down.
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.send('aw', { u: u8ToB64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) });
    this.doc.off('update', this.onDocUpdate);
    this.awareness.destroy();
    if (this.channel && supabase) void supabase.removeChannel(this.channel);
    this.channel = null;
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export interface CollabSession {
  ydoc: Y.Doc;
  provider: SupabaseCollabProvider;
}

/**
 * Build the shared Y.Doc for a document. Hydrates from the persisted CRDT
 * blob when present; otherwise seeds it from content_json EXACTLY ONCE
 * (first-writer-wins via `WHERE ydoc_state IS NULL`) — see the migration
 * comment for why two independent JSON bootstraps would duplicate content.
 * Returns null when Supabase is not configured (plain single-user editor).
 */
export async function bootstrapCollabDoc(
  fileId: string,
  docRow: WasselDocumentRow,
  user: { name: string; color: string },
): Promise<CollabSession | null> {
  if (!supabase) return null;

  let ydoc = new Y.Doc();

  if (docRow.ydoc_state) {
    Y.applyUpdate(ydoc, b64ToU8(docRow.ydoc_state));
  } else {
    // Seed from the JSON body (empty docs seed an empty fragment).
    const schema = getSchema(SCHEMA_EXTENSIONS);
    const seeded = prosemirrorJSONToYDoc(
      schema,
      docRow.content_json ?? { type: 'doc', content: [] },
      Y_FIELD,
    );
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seeded));
    seeded.destroy();

    const blob = u8ToB64(Y.encodeStateAsUpdate(ydoc));
    const { data, error } = await supabase
      .from('wassel_documents')
      .update({ ydoc_state: blob })
      .eq('file_id', fileId)
      .is('ydoc_state', null)
      .select('file_id');
    if (error) {
      // Read-only viewers can't write the seed — they still join the channel
      // and will converge via sync-req against an editor's doc. Loud anyway.
      console.error('[collab] seed persist failed (viewer or RLS):', error.message);
    } else if (!data || data.length === 0) {
      // Someone else seeded first — discard ours and hydrate from theirs so
      // both sides share CRDT identities.
      const { data: fresh, error: refetchErr } = await supabase
        .from('wassel_documents')
        .select('ydoc_state')
        .eq('file_id', fileId)
        .single();
      if (refetchErr || !fresh?.ydoc_state) {
        console.error('[collab] seed race re-fetch failed:', refetchErr?.message);
      } else {
        ydoc.destroy();
        ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, b64ToU8(fresh.ydoc_state as string));
      }
    }
  }

  const provider = new SupabaseCollabProvider(ydoc, fileId, user);
  return { ydoc, provider };
}

/** Full current CRDT state, base64 — persisted alongside every save. */
export function encodeYDocState(ydoc: Y.Doc): string {
  return u8ToB64(Y.encodeStateAsUpdate(ydoc));
}
