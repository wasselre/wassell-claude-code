# PRD: AI Agent

**Status:** Live (v1 — internal testing)
**Last updated:** 2026-04-24
**Related PRDs:** [navigation-layout.md](navigation-layout.md), [data-storage.md](data-storage.md), [record-management.md](record-management.md), [chats.md](chats.md)

## What it is (in plain English)
A chat-with-an-AI page inside the Wassell app. The AI plays the role of a Wassel sales assistant: it answers customer-style questions about the projects Wassel is marketing, asks clarifying questions, and — when the conversation is ripe — captures a lead into the `clients` model. Staff use this page to test and tune the agent today; the same brain will later be exposed to customers via Haberchat or ManyChat, unchanged.

Behind the scenes, every send posts the full chat history to a Vercel Edge function (`/api/agent`), which runs Claude Opus 4.7 through a tool-use loop: the agent can call `search_projects` / `get_project` (to read from the `records` table) and `save_lead` (to write to the `clients` model). The endpoint streams the assistant's reply back to the browser as Server-Sent Events.

## Why it exists
Wassel's sales pipeline runs on WhatsApp. Reps spend a lot of time answering the same questions ("what's available in حي الياسمين under 2M?"). The AI agent does that triage at hour zero — always available, always on-brand, grounded in the actual project data rather than hallucinated. We build and refine it inside the CRM first so staff can read the transcripts and improve the prompt / tools before exposing it to real customers.

## Key behaviors
- **Sidebar entry** `المساعد الذكي / AI Agent` is a top-level item (no group), driven by a system model `name: 'ai_chats'`. The record-list dispatcher in `App.tsx` swaps the generic list view for a purpose-built split-pane layout.
- **Split layout.** Left pane (~320px) = list of past conversations sorted by `last_message_at` desc. Right pane = the active chat thread, or a welcome card when no conversation is selected. Mobile collapses to whichever pane the URL indicates (list when no recordId, thread otherwise).
- **Conversations as records.** Each chat is one `ai_chats` record. Messages live inline on `record.data.messages` as a JSONB array of `{role, content, timestamp}` — no separate messages table. Keeps storage dead simple and reuses the existing records sync.
- **Message format stored** is text-only (role + content). Tool-use and tool-result blocks are never persisted — they're ephemeral to a single turn.
- **Claude Opus 4.7** with adaptive thinking is the model. The system prompt is cached via `cache_control: ephemeral` so repeat turns skip re-processing the prompt (~90% cheaper after the first turn).
- **Tools the agent can call:**
  - `search_projects({city?, district?, property_type?, min_price?, max_price?, bedrooms?, query?})` — scans the `our_projects` model, scores each record against the filters, returns up to 15 matches as JSON.
  - `get_project({project_id})` — fetches a single record by id for full detail.
  - `save_lead({name, phone, city?, district?, budget_max?, interested_project_id?, notes?})` — inserts a new `clients` record with `source: "ai_agent"`.
- **Tool-use loop** runs server-side. The endpoint drives Claude through up to 8 tool iterations per user turn; each iteration streams text deltas to the browser as they're generated, plus `tool_use` / `tool_result` notifications the UI surfaces as a subtle "Searching projects..." badge.
- **Streaming UI.** The assistant message types out live. During a tool call the text pauses and a small animated badge appears until the tool result comes back, then text resumes.
- **Persistence.** The user message is written to the record the instant they hit send (survives a page reload mid-stream). The assistant message is written once the turn completes.
- **Auto-title.** The first user message in a new chat becomes the chat's title (first 60 chars), shown in the left pane and the header.
- **Language matching.** The agent mirrors the customer's language — Arabic in, Arabic out; English in, English out. Default is Arabic.
- **Honesty rules.** The system prompt forbids inventing facts, making financial recommendations, or saying "Wassel CRM". It's told to say "لا أعرف" / "I'll check" when tools don't return an answer.
- **Auth.** Every `/api/agent` request must carry the caller's Supabase JWT. The Edge function creates a Supabase client scoped to that JWT so tool calls respect row-level security (the agent can only read records the signed-in user can already see).
- **Env var.** `ANTHROPIC_API_KEY` must be set on Vercel (production + preview + development). Missing key → the endpoint returns `500 "ANTHROPIC_API_KEY is not configured"`.

## User flows
1. **Try the agent (happy path):**
   1. Click `المساعد الذكي` in the sidebar.
   2. Click "محادثة جديدة" — a new `ai_chats` record is created and the URL flips to `/model/ai_chats/:newId`.
   3. Type a customer-style question, hit Send. User message lands in the transcript immediately.
   4. The agent streams a reply. If it needs data, a "Searching projects..." badge briefly appears, then the response continues.
   5. Continue the conversation. Each turn ships the full history to the backend; no state lives server-side.
2. **Save a lead from a conversation:**
   1. Describe yourself as a prospective customer; give name + phone when the agent asks.
   2. The agent calls `save_lead` (a "Saving lead..." badge flashes).
   3. A new record appears in `clients` with `source: ai_agent` and the notes the agent captured.
3. **Resume an old conversation:**
   1. Click any row in the left-pane list.
   2. The full transcript loads from the record. Send a new message — it appends to the same record.
4. **Empty state:** no chats yet → the left pane reads "No conversations yet."; the right pane shows a welcome card with the `Sparkles` icon, a short description, and a "New chat" button.
5. **Error state:** backend returns an error → a red banner appears at the bottom of the transcript with the message; input is re-enabled so the user can retry.

## Data touched
- **Reads:**
  - `models` (finds the `our_projects` and `clients` system models by name inside `executeAgentTool`).
  - `records` (all `our_projects` records for `search_projects`, a single record by id for `get_project`).
- **Writes:**
  - `records` — inserts one row into the `clients` model per `save_lead` call.
  - `records` — upserts the active `ai_chats` row on every user send and every agent reply (`record.data.messages`, `record.data.message_count`, `record.data.last_message_at`, and `record.data.title` on the very first send).

## Key files
| File | What it does |
|---|---|
| `src/data/seedModels.ts` | Defines the `ai_chats` system model (registered in `SEED_MODELS`). |
| `src/App.tsx` | Dispatchers: `modelName === 'ai_chats'` in both list + detail route → render `AiAgentPage`. |
| `src/pages/AiAgent/AiAgentPage.tsx` | Split-pane layout, conversation list, new-chat button. |
| `src/pages/AiAgent/components/AiChatThread.tsx` | Right-pane transcript, streaming UI, send flow, persistence. |
| `src/lib/aiAgent/client.ts` | Browser-side SSE fetch helper — decodes `data: <json>` events from `/api/agent`. |
| `api/agent.ts` | Vercel Edge function — owns the Claude tool-use loop and the SSE stream back to the browser. |
| `api/_lib/aiAgent.ts` | System prompt, tool schemas, `executeAgentTool` (the Supabase reads/writes that back each tool). |

## Open questions / known limitations
- **Only `our_projects` is searched.** The other two project models (`all_projects`, `targeted_projects`) aren't exposed yet — customers only ask about what Wassel is actively marketing. Trivial to add when needed.
- **No conversation memory across chats.** Each `ai_chats` record is independent. If the same customer comes back tomorrow, the agent doesn't remember them — they'd get a fresh conversation. Fine for the "customers ask about projects" use case; might matter later if we layer on a CRM-linked persona.
- **No streaming interruption.** The UI doesn't yet expose a "stop generating" button. The component aborts the fetch on unmount, but while you're on the page you wait for the turn to finish.
- **Tool results aren't shown in detail.** The UI shows a badge ("Searching projects...") but not the raw JSON Claude got back. That's intentional for customer-facing UX, but staff debugging the agent might want a dev-only toggle later.
- **External channel is not wired up yet.** The endpoint is reusable for Haberchat / ManyChat (same `POST /api/agent` shape), but there's no webhook handler that posts inbound WhatsApp messages into it. That's the next phase.
- **Cost.** Every turn costs Anthropic tokens. Prompt caching keeps the system prompt cheap, but a long conversation still scales linearly. If this gets used heavily, consider per-user rate limiting and/or downgrading to Sonnet 4.6 for low-value turns.
