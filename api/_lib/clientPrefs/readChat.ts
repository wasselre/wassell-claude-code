/**
 * THE ONE unified read of a client's WhatsApp conversation — used by the
 * per-minute cron (`cron`), the rep opening the chat (`open`) and the
 * «أعد القراءة» button (`manual`).
 *
 *   (a) load the unread customer text (incl. transcribed voice notes) after the
 *       lower watermark; nothing new ⇒ `nothing_new` (unless manual); on `open`
 *       a voice note still being transcribed (and the batch not capped) ⇒
 *       `waiting` — the cron reads it once the transcript lands.
 *   (b) cron | open: the free keyword gate; a batch with nothing in it ⇒ both
 *       watermarks advance (`chat_read_mark_gate_skipped`) and no model runs.
 *   (c) claim the (chat, client) lease; someone else holds it ⇒ `not_claimed`.
 *   (d) the watermark = the newest unread customer message, captured NOW.
 *   (e) gather the conversation ONCE for both agents.
 *   (f) run the geography agent (analyzeChatConversation — unchanged) and the
 *       preference agent (extractChatPrefs) in parallel. An agent only runs
 *       when ITS watermark is behind (manual runs both), so a partial failure
 *       retries only the agent that failed. Geo's `skipped_recent` (its 60 s
 *       cool-down) does NOT advance the geo watermark.
 *   (g) chat_read_finish: per-agent watermarks, outcome read | partial | failed.
 *   (h) finally: the lease is released if finish was never reached.
 *
 * An AGENT failure never throws — it becomes `partial` / `failed` and is
 * console.error-ed. An infrastructure failure (state read, lease RPC, finish)
 * THROWS, after the lease is released. Nothing here writes the client record.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from '../geoPreference/extractor.js';
import { analyzeChatConversation, chatLinkedToClient, ChatCardError, type AnalyzeOptions } from '../geoPreference/chatCard.js';
import { gatherChatConversation } from '../geoPreference/backfillPorts.js';
import { loadAutomationSettings, autoSavePlaces, autoSavePrefs, routeChatRead, type SaveTarget } from './autoSave.js';
import { passesKeywordGate } from './keywordGate.js';
import { LEASE_SECONDS, MAX_WAIT_MS } from './dueSelection.js';
import {
  readReadState, readInboundSince, summarizeUnread, scanSince,
  type ReadStateRow, type InboundMsg,
} from './readState.js';
import { extractChatPrefs, type ExtractChatPrefsInput, type ExtractChatPrefsResult } from './extractChatPrefs.js';

export type ReadTrigger = 'cron' | 'open' | 'manual';

export interface ReadChatResult {
  outcome: 'read' | 'partial' | 'failed' | 'gate_skipped' | 'not_claimed' | 'nothing_new' | 'waiting';
  geo: { ran: boolean; mode?: string; error?: string };
  prefs: { ran: boolean; proposalId?: string | null; fields?: number; model?: string; error?: string };
  /** The AI's own save of what this read found (autoSave.ts); absent when nothing was minted or it is switched off. */
  autosave?: { prefs?: string; places?: string; route?: string; error?: string };
  watermark: string | null;
  ms: number;
}

export interface FinishArgs {
  owner: string;
  geoThrough: string | null;
  prefThrough: string | null;
  trigger: ReadTrigger;
  outcome: 'read' | 'partial' | 'failed';
  error: string | null;
}

/** Everything that touches the outside world — injectable for tests. */
export interface ReadChatDeps {
  loadState(chatWid: string, clientId: string): Promise<ReadStateRow | null>;
  loadInbound(chatWid: string, since: string | null): Promise<InboundMsg[]>;
  isLinked(clientId: string, chatWid: string): Promise<boolean>;
  claim(chatWid: string, clientId: string, owner: string, leaseSeconds: number): Promise<boolean>;
  finish(chatWid: string, clientId: string, args: FinishArgs): Promise<boolean>;
  release(chatWid: string, clientId: string, owner: string): Promise<void>;
  markGateSkipped(chatWid: string, clientId: string, through: string, trigger: ReadTrigger): Promise<void>;
  gather(chatWid: string): Promise<Conversation | null>;
  analyzeGeo(clientId: string, chatWid: string, opts: AnalyzeOptions): Promise<{ mode: string; minted_proposal_id?: string | null }>;
  extractPrefs(input: ExtractChatPrefsInput): Promise<ExtractChatPrefsResult>;
  /**
   * Save what this read minted onto the client, as the AI (autoSave.ts).
   * Optional: absent (tests) ⇒ proposals stay pending, exactly as before.
   */
  autoSave?(a: { clientId: string; chatWid: string; conversation: Conversation; geoProposalId: string | null; prefProposalId: string | null; log: (m: string) => void }): Promise<NonNullable<ReadChatResult['autosave']>>;
}

export function makeReadChatDeps(sb: SupabaseClient): ReadChatDeps {
  return {
    loadState: (chatWid, clientId) => readReadState(sb, chatWid, clientId),
    loadInbound: (chatWid, since) => readInboundSince(sb, chatWid, since),
    isLinked: (clientId, chatWid) => chatLinkedToClient(sb, clientId, chatWid),
    async claim(chatWid, clientId, owner, leaseSeconds) {
      const { data, error } = await sb.rpc('chat_read_claim', {
        p_chat_wid: chatWid, p_client_id: clientId, p_owner: owner, p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`chat_read_claim failed: ${error.message}`);
      return data === true;
    },
    async finish(chatWid, clientId, a) {
      const { data, error } = await sb.rpc('chat_read_finish', {
        p_chat_wid: chatWid, p_client_id: clientId, p_owner: a.owner,
        p_geo_through: a.geoThrough, p_pref_through: a.prefThrough,
        p_trigger: a.trigger, p_outcome: a.outcome, p_error: a.error,
      });
      if (error) throw new Error(`chat_read_finish failed: ${error.message}`);
      return data === true;
    },
    async release(chatWid, clientId, owner) {
      const { error } = await sb.rpc('chat_read_release', { p_chat_wid: chatWid, p_client_id: clientId, p_owner: owner });
      if (error) throw new Error(`chat_read_release failed: ${error.message}`);
    },
    async markGateSkipped(chatWid, clientId, through, trigger) {
      const { error } = await sb.rpc('chat_read_mark_gate_skipped', {
        p_chat_wid: chatWid, p_client_id: clientId, p_through: through, p_trigger: trigger,
      });
      if (error) throw new Error(`chat_read_mark_gate_skipped failed: ${error.message}`);
    },
    gather: (chatWid) => gatherChatConversation(sb, chatWid),
    analyzeGeo: (clientId, chatWid, opts) => analyzeChatConversation(sb, clientId, chatWid, opts),
    extractPrefs: (input) => extractChatPrefs(sb, input),
    async autoSave(a) {
      const settings = await loadAutomationSettings(sb);
      if (!settings.auto_save_profile) return { prefs: 'off', places: 'off' };
      const out: NonNullable<ReadChatResult['autosave']> = {};
      const errs: string[] = [];
      // Which profile this belongs to — same wish, a change of mind, or a
      // separate second wish (wishRouter.ts). Decided once for both halves; if
      // it fails nothing is saved and both proposals stay for the rep.
      let target: SaveTarget;
      try {
        target = await routeChatRead(sb, { clientId: a.clientId, chatWid: a.chatWid, conversation: a.conversation, geoProposalId: a.geoProposalId, prefProposalId: a.prefProposalId, log: a.log });
      } catch (err) {
        console.error(`[chat-read] client=${a.clientId} wish routing failed — nothing auto-saved, proposals left for the rep:`, errMsg(err));
        return { error: `route: ${errMsg(err)}` };
      }
      out.route = target.replace?.length ? `changed:${target.replace.join(',')}` : target.profileId ? `profile:${target.profileId}` : 'active';
      // Each half on its own: a failed places save must not stop the preferences.
      if (a.geoProposalId) {
        try {
          const r = await autoSavePlaces(sb, { proposalId: a.geoProposalId, source: 'chat', sourceRef: a.chatWid, target, log: a.log });
          out.places = `${r.status}:${r.added}`;
        } catch (err) { errs.push(`places: ${errMsg(err)}`); console.error(`[chat-read] client=${a.clientId} places auto-save failed:`, errMsg(err)); }
      }
      if (a.prefProposalId) {
        try {
          const r = await autoSavePrefs(sb, { proposalId: a.prefProposalId, conversation: a.conversation, source: 'chat', sourceRef: a.chatWid, target, log: a.log });
          out.prefs = `${r.status}:${r.written.length}`;
        } catch (err) { errs.push(`prefs: ${errMsg(err)}`); console.error(`[chat-read] client=${a.clientId} prefs auto-save failed:`, errMsg(err)); }
      }
      if (errs.length) out.error = errs.join(' | ');
      return out;
    },
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const behind = (through: string | null, watermark: string | null): boolean =>
  watermark === null || through === null || Date.parse(through) < Date.parse(watermark);

export interface ReadChatOptions {
  clientId: string;
  chatWid: string;
  trigger: ReadTrigger;
  /** Lease owner id — unique per reader (cron tick + chat, or endpoint request). */
  owner: string;
  log?: (msg: string) => void;
  now?: () => Date;
  deps?: Partial<ReadChatDeps>;
}

export async function readChatForClient(sb: SupabaseClient, o: ReadChatOptions): Promise<ReadChatResult> {
  const started = Date.now();
  const nowFn = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const deps: ReadChatDeps = { ...makeReadChatDeps(sb), ...(o.deps ?? {}) };
  const { clientId, chatWid, trigger, owner } = o;
  const done = (r: Omit<ReadChatResult, 'ms'>): ReadChatResult => ({ ...r, ms: Date.now() - started });
  const idle = { geo: { ran: false }, prefs: { ran: false } };

  // The chat must belong to this client — the reader gathers by wid alone.
  if (!(await deps.isLinked(clientId, chatWid))) {
    throw new ChatCardError(404, 'this chat is not linked to this client');
  }

  // (a) what is unread?
  const state = await deps.loadState(chatWid, clientId);
  const now = nowFn();
  const summary = summarizeUnread(await deps.loadInbound(chatWid, scanSince(state)), state, now);
  const watermark = summary.newestUnreadAt; // (d) captured before anything else runs
  if (trigger !== 'manual') {
    const capped = summary.oldestUnreadAt !== null && now.getTime() - Date.parse(summary.oldestUnreadAt) >= MAX_WAIT_MS;
    if (trigger === 'open' && summary.pendingTranscripts > 0 && !capped) {
      return done({ outcome: 'waiting', ...idle, watermark });
    }
    if (summary.unread.length === 0) return done({ outcome: 'nothing_new', ...idle, watermark: null });

    // (b) the free keyword gate.
    const gate = passesKeywordGate(summary.unread.map((m) => m.text));
    if (!gate.pass) {
      await deps.markGateSkipped(chatWid, clientId, watermark!, trigger);
      log(`[chat-read] client=${clientId} chat=${chatWid} trigger=${trigger} gate_skipped unread=${summary.unread.length}`);
      return done({ outcome: 'gate_skipped', ...idle, watermark });
    }
  }

  // (c) the lease.
  if (!(await deps.claim(chatWid, clientId, owner, LEASE_SECONDS))) {
    return done({ outcome: 'not_claimed', ...idle, watermark });
  }

  let finished = false;
  try {
    // (e) the conversation, once.
    const conversation = await deps.gather(chatWid);
    if (!conversation) {
      throw new ChatCardError(422, 'the customer has not written anything in this chat yet — there is nothing to read');
    }

    // (f) both agents, in parallel — each only when its own watermark is behind.
    const runGeo = trigger === 'manual' || behind(state?.geo_read_through ?? null, watermark);
    const runPrefs = trigger === 'manual' || behind(state?.pref_read_through ?? null, watermark);
    const [geoRes, prefRes] = await Promise.allSettled([
      runGeo
        ? deps.analyzeGeo(clientId, chatWid, { conversation, workerId: owner, log, now: nowFn })
        : Promise.resolve(null),
      runPrefs
        ? deps.extractPrefs({ clientId, chatWid, conversation, trigger, watermark, log })
        : Promise.resolve(null),
    ]);

    const geo: ReadChatResult['geo'] = { ran: runGeo };
    const prefs: ReadChatResult['prefs'] = { ran: runPrefs };
    const errors: string[] = [];
    let geoOk = true;
    let prefsOk = true;
    let geoAdvances = false;
    let geoMinted: string | null = null;
    if (geoRes.status === 'fulfilled') {
      if (geoRes.value) {
        geo.mode = geoRes.value.mode;
        geoMinted = geoRes.value.minted_proposal_id ?? null;
        geoAdvances = geoRes.value.mode !== 'skipped_recent';
      }
    } else {
      geoOk = false;
      geo.error = errMsg(geoRes.reason);
      errors.push(`geo: ${geo.error}`);
      console.error(`[chat-read] client=${clientId} chat=${chatWid} trigger=${trigger} geo agent failed:`, geo.error);
    }
    if (prefRes.status === 'fulfilled') {
      if (prefRes.value) {
        prefs.proposalId = prefRes.value.proposalId;
        prefs.fields = prefRes.value.fieldCount;
        prefs.model = prefRes.value.model;
      }
    } else {
      prefsOk = false;
      prefs.error = errMsg(prefRes.reason);
      errors.push(`prefs: ${prefs.error}`);
      console.error(`[chat-read] client=${clientId} chat=${chatWid} trigger=${trigger} preference agent failed:`, prefs.error);
    }

    const outcome: 'read' | 'partial' | 'failed' =
      geoOk && prefsOk ? 'read' : !geoOk && !prefsOk ? 'failed' : 'partial';

    // (g) record it. Only an agent that ran AND succeeded advances its watermark.
    const ok = await deps.finish(chatWid, clientId, {
      owner,
      geoThrough: runGeo && geoOk && geoAdvances ? watermark : null,
      prefThrough: runPrefs && prefsOk ? watermark : null,
      trigger,
      outcome,
      error: errors.length ? errors.join(' | ') : null,
    });
    finished = true;
    if (!ok) {
      throw new Error(`chat read lease for ${chatWid} / ${clientId} was lost before finish (owner ${owner}) — watermarks not recorded`);
    }
    // (i) the AI saves what it found onto the client (no rep tick). Never fails
    // the read: a failed save leaves the proposal pending, as before.
    let autosave: ReadChatResult['autosave'];
    const prefMinted = prefs.proposalId ?? null;
    if (deps.autoSave && (geoMinted || prefMinted)) {
      try {
        autosave = await deps.autoSave({ clientId, chatWid, conversation, geoProposalId: geoMinted, prefProposalId: prefMinted, log });
      } catch (err) {
        autosave = { error: errMsg(err) };
        console.error(`[chat-read] client=${clientId} chat=${chatWid} auto-save failed:`, errMsg(err));
      }
    }
    log(`[chat-read] client=${clientId} chat=${chatWid} trigger=${trigger} outcome=${outcome} geo=${geo.ran ? (geo.mode ?? 'error') : 'skip'} prefs=${prefs.ran ? (prefs.error ? 'error' : `${prefs.fields ?? 0} fields`) : 'skip'} watermark=${watermark ?? '-'}`);
    return done({ outcome, geo, prefs, ...(autosave ? { autosave } : {}), watermark });
  } finally {
    // (h) never leave a lease behind when finish was not reached.
    if (!finished) {
      try {
        await deps.release(chatWid, clientId, owner);
      } catch (releaseErr) {
        // The original error (already propagating) matters more; the lease
        // expires on its own after LEASE_SECONDS. Logged, not swallowed silently.
        console.error(`[chat-read] releasing the lease for ${chatWid} / ${clientId} failed:`, errMsg(releaseErr));
      }
    }
  }
}
