# PRD: Chats (WhatsApp via Haberchat)

**Status:** Live
**Last updated:** 2026-04-23
**Related PRDs:** [navigation-layout.md](navigation-layout.md), [data-storage.md](data-storage.md), [record-management.md](record-management.md)

## What it is (in plain English)
A two-pane WhatsApp inbox inside the Wassell app. The left pane is the list of every conversation synced from a connected WhatsApp number; the right pane is the open conversation — message history, an image/document composer, and a status + labels header. Staff can reply from the browser, start new chats to numbers they've never messaged, attach images and documents, mark conversations resolved or archived, and see each conversation auto-linked to the matching Client record. New inbound WhatsApp messages appear in the list and the open thread live — no refresh needed.

Chat traffic itself runs through **Haberchat** (`api.haber.chat/v1`), a WhatsApp Business gateway. The app never talks to Haberchat directly — a set of Vercel serverless functions in `api/haberchat/*` proxy every call server-side so the Haberchat API token stays off the client. A webhook handler receives every inbound message + ack update, writes them to Supabase, and Supabase Realtime pushes them to every open browser tab.

## Why it exists
Real estate sales pipelines in Saudi run on WhatsApp. Before this module, staff replied from their personal phones and copy-pasted summaries back into the CRM. Now every conversation lives next to the matching Client record, is searchable, is assignable, and becomes a first-class record the rest of the app (workflows, dashboards, reporting) can act on.

## Key behaviors
- **Sidebar entry** `المحادثات / Chats` is a top-level item (not grouped) driven by a system model with `name: 'chats'`. The record-list dispatcher renders the split layout instead of the generic table view.
- **Split layout always on desktop.** Left pane (~360px) = conversation list. Right pane = detail or a "Select a conversation" placeholder. On mobile, whichever pane matches the URL takes the full width.
- **List rows** sort by `last_message_at` desc. Each row shows avatar (first letter, copper for unread), name (or phone), last message preview (truncated), relative timestamp (time / Yesterday / short date), unread pill, status badge, and a device label when >1 number is active.
- **Detail header** shows avatar + name + status picker (click to resolve/archive/reopen) + phone + kind + last-message-at + editable labels + a linked-client button (opens `/model/clients/:id`) or a "Create client" CTA when no phone match was found.
- **Message thread** loads the latest 50 messages on mount via the proxy. A "Load older" button at the top paginates backwards using the oldest message's `date` as cursor; scroll position is preserved when older history is appended.
- **Bubbles**: outbound right-aligned copper, inbound left-aligned sand, keyed off `flow` not document direction (an Arabic outbound message still sits on the right in RTL). Text, image (inline preview), video (<video controls>), audio (compact player), document (download chip) all render inline. Quoted replies render as a small chip at the top of the bubble. Ack ticks on outbound: clock = pending, single tick = sent, double tick gray = delivered, double tick copper = read, red alert = failed.
- **Composer**: textarea (Enter sends, Shift+Enter newline, auto-grows to 6 rows), paperclip button (opens native file picker, chosen file shows as a removable chip above the textarea, 10 MB upper bound enforced), send button. Uploads land first, then the message is queued with the returned `mediaFileId`.
- **Realtime via webhook.** Every inbound or outbound message from Haberchat fires a webhook. The handler writes the row to `chat_messages` via the service-role Supabase client; Supabase Realtime pushes the INSERT/UPDATE to every browser subscribed to the table. The global subscription lives on `ChatsSplitPage` — active for the entire time the user is under `/model/chats/*` — so the list updates even when the user isn't viewing the specific conversation that got a new message.
- **Optimistic send.** Pressing Send inserts a pending placeholder bubble immediately (clock icon); when the proxy returns the server wid, the placeholder is swapped for a real row with `ack: 'sent'`. Webhook `message:out:ack` events progress the tick through `delivered` → `read`. Failed sends flip the placeholder to red + toast the error.
- **Start new chat.** `+` button in the list header opens a modal: phone + first message + device picker (only if >1 active). On submit, a local chat record is created (so the conversation appears in the list immediately), the first message is sent, and the user is navigated to the new detail pane.
- **Client auto-link.** Whenever a chats record is synced, updated via Realtime, or the user saves a clients record, we sweep unlinked chats and try to match each to a client by digits-only phone compare (exact or suffix match, ≥6 digits, derives the phone-field slug from the clients model schema so it's not hardcoded to `phone` vs `phone_number`). Never overwrites an existing link.
- **Status + labels** on a chat are editable from the detail header. Status is a 3-way pill (active / resolved / archived) wired to Haberchat's action-based PATCH endpoint. Labels are a chip row with inline add/remove. Both are optimistic with revert-on-failure.
- **Unread counts** bump on every new inbound row that lands via Realtime, and zero out when the user opens the chat detail.
- **Multi-device support.** A Settings page at `/settings/whatsapp-numbers` lists every WhatsApp number connected to the Haberchat account, merges with a local overlay for friendly names + default flag + hidden flag. The composer's send-from picker only appears when >1 active number exists; single-number setups silently use the default.
- **Group / channel v2.** v1 renders group / channel conversations in the list but disables the composer and shows "sending to groups and channels is not yet supported". Inbound group messages are received but lack per-sender rendering.

## User flows
1. **Reply to an inbound message (happy path):**
   1. WhatsApp user sends a message to the Wassell number.
   2. Haberchat fires `message:in:new` webhook → handler writes to `chat_messages` + bumps the parent record.
   3. Realtime pushes the insert; the list row reorders, unread pill appears. Agent clicks it; thread loads history + shows the new message; unread zeroes.
   4. Agent types a reply, presses Enter; optimistic bubble appears (clock), webhook + Realtime progress it to sent → delivered → read.
2. **Start a brand-new chat:**
   1. Click `+` in the list header.
   2. Enter phone (any format — country code `+966` assumed for local numbers), type opening message.
   3. Send → local record created + first message posted; navigation lands on the new detail pane; the webhook echo reconciles the actual wid.
3. **Resolve a finished conversation:**
   1. Open the chat.
   2. Click the status pill → pick "Resolved".
   3. Status updates optimistically; Haberchat receives the `action: resolve` patch; the chat stays in the list but the header badge is gray.
4. **Link incoming chat to a new client:**
   1. A message arrives from an unknown phone. The chat appears with a "No linked client — create" CTA in the header.
   2. Agent clicks CTA → clients form opens → fills in name + phone + saves → save hook sweeps unlinked chats and back-fills `client_link` on the matching row.
   3. Agent returns to the chat; the header now shows "Linked client: <Name>" (navigable).
5. **Send an image:**
   1. Click paperclip → pick an image.
   2. Preview chip shows filename + size. Type optional caption. Send.
   3. Upload runs through the proxy (spinner on send button); on success, `sendChatMessage` posts with the returned `mediaFileId` + inferred `kind: 'image'`. Outbound bubble renders the image inline.
6. **Empty state (no numbers connected):**
   - The list shows "Conversations will appear here as new messages arrive" and sends fail with "no WhatsApp device configured — set a default in Settings". Admin opens `/settings/whatsapp-numbers` → refreshes the list from Haberchat → picks a default.

## Data touched
- **Reads:**
  - `models` (finds the `chats` and `clients` system models), `records` (conversations for the chats model, clients records for auto-link).
  - `chat_messages` via the global Realtime subscription + direct per-chat queries from the `listMessages` proxy pass-through (history loads come from Haberchat directly, not from this table — the table is populated by the webhook only).
  - `whatsapp_numbers` (overlay for device friendly names + default).
  - Haberchat (via proxy): `GET /chat/{deviceId}/chats`, `GET /chat/{deviceId}/chats/{wid}/sync`, `POST /files`, `GET /chat/{deviceId}/files/{id}/download`, `POST /messages`, `PATCH /chat/{deviceId}/chats`, `GET /devices`.
- **Writes:**
  - `records` (chats conversations — id = uuidv5(chat_wid)); `records.data` fields: `wid`, `name`, `phone`, `kind`, `device_id`, `status`, `owner`, `labels`, `unread_count`, `last_message_at`, `last_message_preview`, `client_link`.
  - `chat_messages` (webhook only, via service role — bypasses RLS).
  - `whatsapp_numbers` (admin on the Settings page).

## Key files
| File | What it does |
|---|---|
| `src/data/seedModels.ts` | `chatsModel` + field definitions (wid, name, phone, kind, device_id, status, owner, labels, unread_count, last_message_at, last_message_preview, client_link). |
| `src/pages/Chats/ChatsSplitPage.tsx` | Two-pane layout + global Realtime lifecycle (`subscribeToAllChats`). |
| `src/pages/Chats/components/ChatList.tsx` | Left pane: list + search + refresh + `+` new chat button. |
| `src/pages/Chats/components/ChatDetail.tsx` | Right pane: header (status picker + labels editor + client link) + thread + composer. |
| `src/pages/Chats/components/MessageThread.tsx` | Scrolling thread with day separators + "load older" pagination. |
| `src/pages/Chats/components/MessageBubble.tsx` | Bubble rendering; inline media via `useMediaBlob` (authenticated blob fetch + cached `blob:` URLs). |
| `src/pages/Chats/components/Composer.tsx` | Textarea + paperclip + send; auto-grow; upload-then-send flow. |
| `src/pages/Chats/components/AckIndicator.tsx` | Outbound tick icons (pending / sent / delivered / read / failed). |
| `src/pages/Chats/components/StartChatModal.tsx` | "New chat" modal — phone + first message + device picker. |
| `src/pages/Settings/WhatsAppNumbersPage.tsx` | Admin Settings page for connected WhatsApp numbers. |
| `src/stores/appStore.ts` | Store slice: `chatMessages`, `waDevices`, `loadChatsFromHaberchat`, `loadMessagesForChat`, `sendChatMessage`, `startNewChat`, `patchChat`, `markChatAsRead`, `subscribeToAllChats`, `bumpParentFromMessage`, `relinkChatsAgainstClients`. |
| `src/lib/haberchat/client.ts` | Browser-side wrappers for every `/api/haberchat/*` endpoint + Supabase JWT attachment. |
| `src/lib/haberchat/normalize.ts` | `mergeChatIntoRecord`, `chatRecordId` (uuidv5 with baked-in CHATS_NAMESPACE), `resolveClientLink`, `phoneFieldSlugs`, `normalizePhoneDigits`. |
| `api/_lib/haberchat.ts` | Server-side Haberchat REST wrapper (Token header, tolerant field normalization for chats + messages + file upload). |
| `api/_lib/auth.ts` | Supabase JWT verification for every non-webhook proxy endpoint. |
| `api/_lib/supabaseServer.ts` | Service-role Supabase client — **only** used by the webhook handler. |
| `api/haberchat/devices.ts` | `GET` list devices (for Settings). |
| `api/haberchat/chats.ts` | `GET` list conversations for one device. |
| `api/haberchat/chats/[wid].ts` | `PATCH` update status / labels. |
| `api/haberchat/chats/[wid]/messages.ts` | `GET` message history. |
| `api/haberchat/messages.ts` | `POST` send a message. |
| `api/haberchat/files.ts` | `POST` upload media. |
| `api/haberchat/files/[id].ts` | `GET` download media — streams binary with Token added server-side. |
| `api/webhook/haberchat.ts` | Receives Haberchat events; verifies `X-Webhook-Secret` (header or `?secret=` query); writes `chat_messages` + bumps records via the service-role client. |
| `supabase/schema.sql` | `chat_messages` + `whatsapp_numbers` tables + RLS + Realtime publication. |

## Open questions / known limitations
- **Owner assignment.** The header doesn't expose an "owner" picker yet — requires a Haberchat-agent-id ↔ Wassell-user mapping table that doesn't exist. Haberchat's `owner` field round-trips via the `chat:update` webhook but the app treats it as opaque.
- **Groups and channels.** v1 displays them in the list but disables the composer and doesn't render per-sender labels in group threads. Revisit when real-estate teams need group replies.
- **Ack tier gating.** `message:out:ack` events only fire on Haberchat Business / Enterprise plans. On lower tiers, outbound bubbles stay at "sent" (single tick) forever. Consider inferring "delivered" from a tier check instead of always waiting.
- **Records table not on Realtime.** The global subscription covers `chat_messages` only; the parent `records` row bump happens in memory. A different browser that missed the window won't see the updated `last_message_preview` until the next `loadChatsFromHaberchat` call (mount of the Chats page). Adding `records` to `supabase_realtime` was scoped out — too noisy app-wide.
- **Existing `wa_*` tables.** Schema still has the pre-existing `wa_conversations` / `wa_leads` / `wa_errors` scaffolding for a never-shipped autonomous AI replier. Marked DEPRECATED but not yet dropped. Safe to remove in a future migration once confirmed empty.
- **Deleted / edited messages.** Haberchat's `message:update` event isn't handled — edits and poll votes are ignored. Not urgent for the v1 sales workflow.
- **Status "operative".** Haberchat sometimes returns device status strings we don't map (e.g. `operative`). The UI falls back to showing the raw value. Add missing entries to `statusLabel` as they surface.
- **Secret in webhook URL.** Per Haberchat's recommendation we accept the shared secret as a query param. That value ends up in Haberchat's delivery log but not in browser history. If Haberchat later exposes a HMAC-signed header scheme, prefer it.
