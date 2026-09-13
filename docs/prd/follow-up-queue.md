# PRD: Follow-up Queue (متابعات مقترحة)

**Status:** Live
**Last updated:** 2026-09-13 (voice rules added the same day — see `.claude/skills/wassel-whatsapp-voice/SKILL.md`)

## What it is

A review surface where the operator works through **Claude-suggested WhatsApp follow-ups** one by one. Claude reads the client chats (in a Claude Code session, against the live DB), decides which conversations need a message — a client waiting for a reply, a client who visited a project, a client who asked for something that was never sent, a client who received a project sheet and went quiet, or an old request worth reviving — and writes one row per conversation into `wa_followup_suggestions`: the suggested message, the reason, and a plain summary of the whole thread.

The page at `/sales/follow-up-queue` lists those rows as cards. Clicking **«افتح المحادثة وأرسل»** opens the real WhatsApp conversation in the existing chat popup (`ChatThreadModal`) with the suggested text **already in the composer**, so the operator reads the actual chat, edits if needed, and sends through the normal chat path. The page detects the send and records the suggestion as `sent` with the exact text that went out.

**Nothing on this page sends a message by itself.** It is a human-confirms surface, the same posture as `call_result_suggestions` and `ai_notifications`.

## Key behaviors

- **Bespoke table, not a model.** `wa_followup_suggestions` is read directly through `useFollowupSuggestions()` (the sanctioned pattern for ops tables). RLS: any authenticated staff member can select / insert / update. Claude inserts rows via SQL (service role); the page only edits the lifecycle fields.
- **One pending suggestion per conversation** — a partial unique index (`status='pending'`) makes a second Claude pass replace the open suggestion instead of stacking two messages for the same client.
- **Categories** (fixed order on the page): `reply` (client is waiting for a reply) → `visited` (visited a project) → `promised` (asked for something we never sent) → `nudge` (got a project, went quiet) → `revive` (old request). **Priority** 1 = today, 2 = this week, 3 = low.
- **Card** = client name + phone + project chip + priority + "client last wrote N days ago" + chat summary + reason + the suggested message in an editable textarea (edits are saved to `suggested_message` on blur) + an internal note + links to the full chat page and the client record (new tab).
- **Open chat & send:** writes the suggested text into the per-conversation draft store (`saveDraftText(chat_wid, text)` — the Composer restores it synchronously on mount) and mounts `ChatThreadModal` for the `chats` record. This deliberately overwrites any older unsent draft for that conversation. A dark strip above the popup explains the text is pre-filled; it turns green once the send is recorded.
- **Send detection:** while the popup is open the page watches `chatMessages[chat_wid]`; the first `flow:'out'` message dated after the popup opened (the store's optimistic bubble appears the instant the rep hits send) marks the row `sent` with `final_message` = the bubble body and `sent_message_id` = its id. A **«سجّلها كمرسلة»** button covers sends made elsewhere. The popup stays open so the rep can keep chatting.
- **Dismiss** asks for an optional reason and moves the row to `dismissed`; **Back to pending** restores a sent/dismissed row. Tabs: Pending / Sent / Dismissed / All, with per-category chips and a name/phone/project search.
- **Sidebar + access:** a `CUSTOM_PAGES` entry (`follow_up_queue`, `default_access:'admin'`) — admins see it; other profiles get it from Settings → Profiles. The route is guarded by `RequirePageAccess`.
- **Realtime:** the page mounts `subscribeToAllChats` while open so the popup thread updates live.
- `sent_by_user_id` / `dismissed_by_user_id` are `public.users.id` (from `currentUserId`), never `auth.uid()`.

- **Voice:** every `suggested_message` is written under `.claude/skills/wassel-whatsapp-voice/SKILL.md` — the reps' measured WhatsApp style (median 29 characters, Najdi, one idea, one closing question, no bullets, no «ر.س»). The first batch was rewritten under it on 2026-09-13 after the operator rejected the original brochure-style drafts.

## User flows

1. Claude (in a Claude Code session) reviews the client chats and inserts a batch (`batch_id` e.g. `2026-09-13-claude`) of suggestions.
2. The operator opens **متابعات مقترحة** → Pending. Cards are grouped by category, priority first.
3. For a card: read the summary + reason → optionally edit the message → **افتح المحادثة وأرسل** → the WhatsApp popup opens with the text in the composer → read the real thread → send (or change the text first) → the strip turns green, the card moves to Sent.
4. Not worth sending → **تجاهل** (+ reason). Sent by mistake / changed mind → **إرجاع للقائمة**.

## Data touched

| Table | Purpose |
|---|---|
| `wa_followup_suggestions` | One row per suggested follow-up: deep-link triple (`chat_record_id`, `chat_wid`, `client_record_id`), `category`, `priority`, `project`, `chat_summary`, `reason`, `suggested_message`, `last_client_message_at`, lifecycle (`status`, `final_message`, `sent_at`, `sent_by_user_id`, `sent_message_id`, `dismissed_*`, `rep_note`). |
| `chat_messages` (read) | Send detection through the store's `chatMessages` slice. |
| localStorage `wassell_chat_draft_text:<wid>` | The composer pre-fill. |

## Key files

| File | What it does |
|---|---|
| `supabase/migrations/2026-09-13_01_wa_followup_suggestions.sql` | Table, indexes (incl. one-pending-per-chat), touch trigger, RLS. |
| `src/lib/followupSuggestions/client.ts` | Types + `useFollowupSuggestions()` (list, markSent, dismiss, restore, saveMessage, saveNote). |
| `src/pages/Sales/FollowUpQueuePage.tsx` | The page: tabs, category chips, search, cards, chat popup + review strip, send detection. |
| `src/pages/Chats/components/ChatThreadModal.tsx` | Reused unchanged — the WhatsApp popup. |
| `src/pages/Chats/lib/drafts.ts` | Reused unchanged — `saveDraftText` is how the composer gets pre-filled. |
| `src/lib/customPages.ts` | `follow_up_queue` entry (sidebar + PermissionMatrix + route guard). |
| `src/App.tsx` | Route `/sales/follow-up-queue`. |

## Out of scope / future

- Generating the suggestions inside the app (a runner lane) — today Claude writes them from a Claude Code session.
- Snoozing (the `snoozed` status and `snoozed_until` column exist; no UI yet).
- Closing the client's open follow-up task when a suggestion is sent — the WhatsApp activity bridge already reconciles outbound messages on client-linked chats, so no second writer was added here.
