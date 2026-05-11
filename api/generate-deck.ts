/**
 * POST /api/generate-deck
 *
 * Generates a Wassel-branded .pptx file by calling Claude with the
 * `wassel-general-ppt` skill (registered in Anthropic Skills API) and the
 * code_execution tool. Downloads the resulting file via the Files API,
 * uploads it to the private `wassel-decks` Supabase Storage bucket at
 *   {auth.uid()}/{record_id}/{filename}
 * and signs a 7-day URL for the browser.
 *
 * Request body:
 *   {
 *     recordId: string,                                  // a `decks` record already created by the client
 *     brief:    string,                                  // the deck description
 *     language?: 'ar' | 'en' | 'mixed',                  // hint for Claude (default 'ar')
 *     model?:    'claude-opus-4-7' | 'claude-sonnet-4-6' // default opus
 *   }
 *
 * SSE events:
 *   { type: 'status', phase: 'calling-claude' | 'downloading' | 'uploading' | 'finalizing', detail?: string }
 *   { type: 'done',   file_url: string, file_path: string, filename: string }
 *   { type: 'error',  message: string }
 *
 * The `decks` record is updated in-band:
 *   - On entry → status='generating', model_used + language stamped, error_message cleared
 *   - On success → status='ready', file_url, file_path, filename, anthropic_file_id set
 *   - On any failure → status='failed', error_message set
 *
 * Auth: Supabase JWT in `Authorization: Bearer …`. Storage upload + record
 * write happen as the user (not service role) so RLS gates them.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError } from './_lib/auth.js';

// Edge runtime: SSE chunks flush in real-time on Vercel (Node runtime
// buffers and can hang the response). The Anthropic call typically takes
// 60-120s.
//
// `maxDuration` is REQUIRED to extend Edge functions past the default 30s
// wall-clock. Without this export, Vercel kills the function at 30s even
// while the SSE response is actively flushing — observed 2026-05-10 on
// record 545bd8d6 (Vercel Runtime Timeout Error at exactly 29s). Pro plan
// supports up to 800s on Edge; we cap at 300s (5 min) — Anthropic's
// Opus + skills + code_execution combo typically finishes in 90-180s,
// so 5 min leaves comfortable headroom while still failing fast on
// pathological hangs.
export const config = { runtime: 'edge' };
export const maxDuration = 300;

type DeckSize = '16:9' | '9:16' | '4:3' | '1:1';

interface DeckAttachmentRef {
  /** Storage path inside the `wassel-decks` bucket. The user's JWT must be
   * able to read it (path-prefix RLS — first segment must be auth.uid()). */
  path: string;
  /** Display name. Doubles as the filename inside the sandbox at
   * `/mnt/user-data/uploads/<name>`. */
  name: string;
  /** Browser-reported mime type. Empty string is acceptable — falls back to
   * extension sniffing for upload to Anthropic. */
  mimeType: string;
  /** Bytes — informational, not enforced server-side (bucket already
   * enforces 100 MB). */
  size: number;
}

interface GenerateDeckRequestBody {
  recordId: string;
  brief: string;
  language?: 'ar' | 'en' | 'mixed';
  model?: 'claude-opus-4-7' | 'claude-sonnet-4-6';
  size?: DeckSize;
  attachments?: DeckAttachmentRef[];
}

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const STORAGE_BUCKET = 'wassel-decks';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Mapping from aspect ratio → python-pptx slide_width / slide_height in
 * inches. Mirrors the values supplied to the model in the system prompt
 * so we can validate the size param up front. */
const SIZE_TO_INCHES: Record<DeckSize, { width: number; height: number }> = {
  '16:9': { width: 13.333, height: 7.5 },
  '9:16': { width: 7.5, height: 13.333 },
  '4:3': { width: 10, height: 7.5 },
  '1:1': { width: 7.5, height: 7.5 },
};

/** Cap on how many image attachments we ALSO embed as `image` content
 * blocks (in addition to making them available in the sandbox). Vision
 * is expensive — a Sonnet vision token is ~5x text — so we trade quality
 * for cost with a small budget. The remaining images stay accessible
 * via /mnt/user-data/uploads/ for the skill to embed/inspect with PIL. */
const MAX_VISION_IMAGES = 3;
/** Per-image cap for the vision content-block path. Anthropic enforces
 * 5 MB on image inputs; bigger images go to sandbox-only. */
const VISION_IMAGE_BYTES_CAP = 5 * 1024 * 1024;
/** Cap on how many PDF attachments we ALSO add as `document` content
 * blocks for native reading. Document content blocks are even more
 * expensive than images (~1500 tok/page) so we limit to one. */
const MAX_DOCUMENT_PDFS = 1;

const ANTHROPIC_BETAS = [
  'skills-2025-10-02',
  'code-execution-2025-08-25',
  'files-api-2025-04-14',
];

// Deliberately minimal — earlier versions stacked an aesthetics + workflow
// prompt on top of the skill, which made Claude RUSH the design pass
// ("compose in one shot, no iteration"). The skill's own SKILL.md is the
// source of truth for HOW to design a Wassel deck. Let it drive: just
// point Claude at the skill, anchor the save path, and stay out of the
// way. This matches how /wassel-general-ppt behaves in Claude Code.
//
// One pragmatic addition: ask Claude to use a UNIQUE timestamped filename
// per save, never overwrite. We've observed Anthropic's sandbox file
// capture lose track when the same path is overwritten across iterations
// — it apparently caches the file_id of the first write and silently
// drops subsequent overwrites from the response. Unique names sidestep that.
// File-return strategy: empirically Anthropic's automatic file_id capture
// from Skills + code_execution is unreliable for this skill — verified
// runs where the file lands on disk (rc=0, ls confirmed, 198 KB) but
// Files API has no entry. The sandbox has no outbound internet (DNS
// blocked) so we can't curl directly to Supabase. The reliable channel
// is bash stdout: we ask Claude to base64 the saved file between two
// sentinel markers in the FINAL bash call, and the endpoint extracts
// bytes from the stdout stream. Tested with 200KB+ payloads — stdout
// returns all 266k bytes intact.
const B64_MARKER_START = '===WASSEL_DECK_B64_START===';
const B64_MARKER_END = '===WASSEL_DECK_B64_END===';

/** Build the system prompt. We keep the wrapper minimal so the skill's own
 * SKILL.md can drive the design workflow — earlier versions stacked an
 * aesthetics + workflow prompt on top, which made Claude RUSH the design
 * pass. Variable parts (size + attachments) are appended only when set. */
function buildSystemPrompt(args: {
  size: DeckSize;
  attachments: ReadonlyArray<{ name: string; mimeType: string }>;
  /** Whether the wassel-deck-review skill is also loaded. When true, the
   * prompt instructs Claude to run review_deck() with fix=True against
   * the raw deck and base64-stdout the REVIEWED file instead of the
   * raw one. The review skill auto-patches RTL/font-slot/spacing/LRM
   * issues that the builder skill doesn't catch — fixes the "tables
   * left-to-right" + "overlapping text" issues observed on production
   * runs that bypass the local /wassel-general-ppt pipeline. */
  reviewEnabled: boolean;
}): string {
  const dims = SIZE_TO_INCHES[args.size];
  const sizeBlock = `Slide size: ${args.size} (${dims.width}" × ${dims.height}"). When initializing the python-pptx Presentation, set:
    prs.slide_width  = Inches(${dims.width})
    prs.slide_height = Inches(${dims.height})
Compose every layout for this aspect ratio — don't reuse 16:9 grids on a 9:16 deck.`;

  const attachmentsBlock = args.attachments.length === 0
    ? ''
    : `\n\nUser attachments are mounted at /mnt/user-data/uploads/ — inspect them BEFORE designing because the user expects you to use them:
${args.attachments.map((a) => `  • ${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}`).join('\n')}

Read the right tool per type:
  • .xlsx / .xls / .csv → pandas / openpyxl: extract the rows the user is referring to and turn them into slides (charts, tables, callouts)
  • .pdf                → pypdf or pdfplumber: pull headings + body. Some PDFs were also passed natively above — read them visually if so
  • .pptx               → python-pptx: read existing slides; copy structure / typography / brand if asked
  • .docx               → python-docx: read paragraphs as deck content
  • images              → PIL for dimensions; embed via slide.shapes.add_picture(path, ...). Some images were also passed visually above — use them for layout decisions`;

  // When review skill is loaded, the workflow is: build → save raw →
  // review with fix=True → save reviewed → base64 the REVIEWED file.
  // When review skill is NOT loaded (env var missing), fall back to
  // the old single-pass workflow that base64s the raw file directly.
  const finalSaveBlock = args.reviewEnabled
    ? `Save the raw build to \`/mnt/user-data/outputs/wassel-deck-<unix_ms>.pptx\`.

Then run the 'wassel-deck-review' skill (loaded at /mnt/skills/wassel-deck-review/) to auto-patch brand-compliance + typography bugs. This is the same final-gate that runs locally before delivery — it fixes broken RTL on tables, missing complex-script font slots (which makes Arabic render as theme default), blue hyperlink color, double-spaced separators, missing LRM marks on numbers inside Arabic text, parens-in-body, etc. Do not skip it.

\`\`\`python
import sys
sys.path.insert(0, "/mnt/skills/wassel-deck-review/scripts")
from review import review_deck

raw_path = "/mnt/user-data/outputs/wassel-deck-<unix_ms>.pptx"
reviewed_path = "/mnt/user-data/outputs/wassel-deck-<unix_ms>_reviewed.pptx"
report = review_deck(input_path=raw_path, output_path=reviewed_path, fix=True)
print(report.markdown())  # optional but useful for the log
\`\`\`

Then run ONE final bash that prints the **reviewed** file as base64 between sentinel lines (this is how the file reaches the user — the receiver scans bash stdouts for these exact markers):

    echo "${B64_MARKER_START}"
    base64 -w0 /mnt/user-data/outputs/wassel-deck-<unix_ms>_reviewed.pptx
    echo
    echo "${B64_MARKER_END}"`
    : `Save to /mnt/user-data/outputs/wassel-deck-<unix_ms>.pptx. After saving, run ONE final bash that prints the file as base64 between sentinel lines (this is how the file reaches the user — the receiver scans bash stdouts for these exact markers):

    echo "${B64_MARKER_START}"
    base64 -w0 /mnt/user-data/outputs/<FILE>
    echo
    echo "${B64_MARKER_END}"`;

  return `Build a Wassel-branded PowerPoint (.pptx) per the user's brief.

The 'wassel-general-ppt' skill is loaded at /mnt/skills/wassel-general-ppt/. Read its SKILL.md and follow that workflow as written.

${sizeBlock}${attachmentsBlock}

${finalSaveBlock}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: GenerateDeckRequestBody;
    try {
      body = (await req.json()) as GenerateDeckRequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.recordId || typeof body.recordId !== 'string') {
      return jsonError(400, 'recordId must be a string');
    }
    if (!body.brief || typeof body.brief !== 'string' || body.brief.trim().length < 10) {
      return jsonError(400, 'brief must be at least 10 characters');
    }
    // Default to Opus 4.7 — quality matters more than cost, and the
    // earlier "Opus doesn't return file_id" blocker was about file
    // capture, not generation. With the base64-via-stdout return path
    // the file_id capture is no longer in the critical path.
    const model = body.model ?? 'claude-opus-4-7';
    const language = body.language ?? 'ar';
    const size: DeckSize = body.size ?? '16:9';
    const attachments: DeckAttachmentRef[] = Array.isArray(body.attachments)
      ? body.attachments
      : [];
    if (!['claude-opus-4-7', 'claude-sonnet-4-6'].includes(model)) {
      return jsonError(400, `unsupported model: ${model}`);
    }
    if (!(size in SIZE_TO_INCHES)) {
      return jsonError(400, `unsupported size: ${size}`);
    }
    // Defensive: every attachment must declare a path that starts with
    // the caller's auth.uid()/. Anyone bypassing the form could try to
    // smuggle a path from another user — the storage RLS would still
    // block the download, but failing fast here returns a clearer error
    // and avoids spending an Anthropic Files API upload slot on it.
    for (const att of attachments) {
      if (!att.path || typeof att.path !== 'string' || !att.path.startsWith(`${user.userId}/`)) {
        return jsonError(400, `attachment path outside user scope: ${att.path ?? '(missing)'}`);
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const skillId = process.env.ANTHROPIC_WASSEL_SKILL_ID;
    if (!skillId) return jsonError(500, 'ANTHROPIC_WASSEL_SKILL_ID is not configured');
    // Optional: when set, the endpoint also loads wassel-deck-review as a
    // second skill and the system prompt instructs Claude to run it
    // against the generated .pptx before returning bytes. If unset, the
    // review step is skipped and the raw deck is returned as-is. Keeping
    // this optional means a misconfig (missing env var) degrades to "no
    // review" rather than "endpoint broken".
    const reviewSkillId = process.env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID ?? null;

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // One-shot lookup of the decks model id. Seed UUIDs are regenerated per
    // module load, so the value in the database is the only source of truth.
    const { data: modelRow, error: modelErr } = await supabase
      .from('models')
      .select('id')
      .eq('name', 'decks')
      .single();
    if (modelErr || !modelRow) {
      return jsonError(500, `decks model not found: ${modelErr?.message ?? 'unknown'}`);
    }
    const decksModelId = modelRow.id as string;

    const anthropic = new Anthropic({ apiKey });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        // Read-then-write helper that preserves any other fields on the record.
        // Pass p_expected_version: null — the endpoint is the only writer
        // during a generation, so the version-conflict check is unnecessary
        // and skipping it lets us recover from a partial earlier failure.
        // Pass p_created_by as the EXISTING created_by_user_id (or null) —
        // never the auth.uid() blindly, because records.created_by_user_id
        // has an FK to public.users (the CRM's user table) which is a
        // strict subset of auth.users; passing an auth.uid that isn't in
        // public.users raises 23503 / FK violation. This mirrors the
        // appStore.supabaseRecordUpsert pattern.
        const updateRecord = async (patch: Record<string, unknown>) => {
          const { data: current, error: readErr } = await supabase
            .from('records')
            .select('data, created_by_user_id')
            .eq('id', body.recordId)
            .single();
          if (readErr || !current) {
            throw new Error(`failed to read decks record: ${readErr?.message ?? 'not found'}`);
          }
          const newData = { ...(current.data as Record<string, unknown>), ...patch };
          const { error: saveErr } = await supabase.rpc('record_save', {
            p_model_id: decksModelId,
            p_id: body.recordId,
            p_data: newData,
            p_created_by: (current as { created_by_user_id: string | null }).created_by_user_id ?? null,
            p_expected_version: null,
          });
          if (saveErr) {
            throw new Error(`record_save failed: ${saveErr.message}`);
          }
        };

        // Track Anthropic file_ids we created for THIS request — uploaded
        // attachments + (later) the output file. Used to power
        // container.file_ids and content blocks. Local cleanup is
        // intentionally skipped — the Files API has its own retention,
        // and a follow-up GC pass can sweep stale uploads if needed.
        const uploadedAttachments: Array<{
          fileId: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
        }> = [];

        try {
          send({ type: 'status', phase: 'calling-claude', detail: model });
          await updateRecord({
            status: 'generating',
            model_used: model,
            language,
            size,
            attachments,
            error_message: null,
          });

          // Forward each attachment to Anthropic Files API. We download
          // from Supabase Storage with the user's JWT (RLS-gated), then
          // upload to Anthropic. Done in parallel — typical case is 1-3
          // small files, so we don't bother throttling. Any failure
          // poisons the run with a clear error rather than silently
          // dropping the file (per CLAUDE.md "Silent Failures").
          if (attachments.length > 0) {
            send({
              type: 'status',
              phase: 'calling-claude',
              detail: `uploading ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}…`,
            });
            const uploads = await Promise.all(
              attachments.map(async (att) => {
                const { data: blob, error: dlErr } = await supabase.storage
                  .from(STORAGE_BUCKET)
                  .download(att.path);
                if (dlErr || !blob) {
                  throw new Error(
                    `Failed to read attachment "${att.name}" from storage: ${dlErr?.message ?? 'unknown'}`,
                  );
                }
                const arrayBuf = await blob.arrayBuffer();
                const file = new File(
                  [arrayBuf],
                  att.name,
                  { type: att.mimeType || (blob.type ?? 'application/octet-stream') },
                );
                // SDK 0.91.0 doesn't expose beta.files.upload in the public
                // typings yet — same cast pattern we use for messages.stream.
                const uploaded = await (anthropic.beta.files as unknown as {
                  upload: (args: Record<string, unknown>) => Promise<{ id: string; filename?: string; size_bytes?: number }>;
                }).upload({ file, betas: ANTHROPIC_BETAS });
                return {
                  fileId: uploaded.id,
                  name: att.name,
                  mimeType: att.mimeType || (blob.type ?? 'application/octet-stream'),
                  sizeBytes: arrayBuf.byteLength,
                };
              }),
            );
            uploadedAttachments.push(...uploads);
            console.log(
              `[generate-deck] uploaded ${uploads.length} attachment(s) to Anthropic Files API: ${uploads.map((u) => u.fileId).join(', ')}`,
            );
          }

          // Build the user message. Order:
          //  1. text — brief, language hint, slide size, file inventory
          //  2. container_upload blocks — one per attachment. THIS is how
          //     files reach the code_execution sandbox; they land at
          //     /mnt/user-data/uploads/<original_filename>. Earlier we
          //     tried `container.file_ids: [...]` at the top level, but
          //     Anthropic rejects that with
          //     `container.ContainerParams.file_ids: Extra inputs are not
          //     permitted` (observed 2026-05-10 with an .xlsx attachment).
          //     The supported channel is the content block.
          //  3. image — for small images, ALSO expose visually so Claude
          //     can reason about layout/branding (the container_upload
          //     above is what makes them readable from python-pptx).
          //  4. document — for the first PDF, ALSO expose for native PDF
          //     reading. Doesn't replace the sandbox copy; both work
          //     together.
          const visionImages = uploadedAttachments
            .filter((a) => a.mimeType.startsWith('image/') && a.sizeBytes <= VISION_IMAGE_BYTES_CAP)
            .slice(0, MAX_VISION_IMAGES);
          const documentPdfs = uploadedAttachments
            .filter((a) => a.mimeType === 'application/pdf')
            .slice(0, MAX_DOCUMENT_PDFS);

          const userContentBlocks: Array<Record<string, unknown>> = [
            {
              type: 'text',
              text:
                `Brief:\n${body.brief.trim()}\n\n` +
                `Language hint: ${
                  language === 'ar'
                    ? 'Arabic preferred — default the deck to Arabic RTL with Amiri.'
                    : language === 'en'
                      ? 'English preferred — Latin layout with Amiri throughout.'
                      : 'Mixed — choose per-slide based on what the content implies.'
                }\n\n` +
                `Slide size: ${size}.` +
                (uploadedAttachments.length > 0
                  ? `\n\nAttachments mounted at /mnt/user-data/uploads/:\n${uploadedAttachments
                      .map((u) => `  • ${u.name} (${u.mimeType})`)
                      .join('\n')}`
                  : ''),
            },
            // Mount every attachment in the sandbox.
            ...uploadedAttachments.map((a) => ({
              type: 'container_upload',
              file_id: a.fileId,
            })),
            // Plus visual access for the small images we picked.
            ...visionImages.map((a) => ({
              type: 'image',
              source: { type: 'file', file_id: a.fileId },
            })),
            // Plus native PDF reading for the first PDF.
            ...documentPdfs.map((a) => ({
              type: 'document',
              source: { type: 'file', file_id: a.fileId },
            })),
          ];

          // Use streaming: iterating the SDK's stream forces Node to keep
          // reading the HTTP response from Anthropic, which avoids a
          // long-idle hang on Vercel Edge (and keeps the SSE consumer
          // up-to-date with text deltas + tool starts as Claude works).
          // Cast to any: the SDK's beta.messages typing in 0.91.0 doesn't
          // expose `container.skills` or `code_execution_20250825` yet —
          // the endpoint accepts both per the Skills API docs.
          const turn = (anthropic.beta.messages as unknown as {
            stream: (args: Record<string, unknown>) => {
              [Symbol.asyncIterator]: () => AsyncIterator<{ type: string; [k: string]: unknown }>;
              finalMessage: () => Promise<{ content: unknown[] }>;
            };
          }).stream({
            model,
            max_tokens: 32000,
            // Adaptive thinking — Opus 4.7's preferred mode. The model
            // decides how much hidden reasoning to spend per turn based
            // on task complexity. Combined with effort=high, this
            // mirrors Claude Code session behavior which is part of
            // why local /wassel-general-ppt produces nicer decks than
            // a plain non-thinking call. Sonnet 4.6 doesn't support
            // adaptive thinking, so we omit thinking when on Sonnet.
            ...(model === 'claude-opus-4-7'
              ? {
                  thinking: { type: 'adaptive' },
                  output_config: { effort: 'high' },
                }
              : {}),
            betas: ANTHROPIC_BETAS,
            // container takes `skills` only. Files reach the sandbox via
            // `container_upload` content blocks in the user message
            // (added above) — passing `file_ids` here returns 400
            // "Extra inputs are not permitted".
            //
            // Two skills when ANTHROPIC_WASSEL_REVIEW_SKILL_ID is set:
            //   1. wassel-general-ppt — composition
            //   2. wassel-deck-review — auto-patch QA gate (RTL on
            //      tables, font slots, spacing, LRM marks, etc.)
            // This mirrors what /wassel-general-ppt does locally,
            // where the review is the mandatory final step before
            // returning the file.
            container: {
              skills: [
                { type: 'custom', skill_id: skillId, version: 'latest' },
                ...(reviewSkillId
                  ? [{ type: 'custom', skill_id: reviewSkillId, version: 'latest' }]
                  : []),
              ],
            },
            system: buildSystemPrompt({
              size,
              attachments: uploadedAttachments.map((u) => ({
                name: u.name,
                mimeType: u.mimeType,
              })),
              reviewEnabled: reviewSkillId !== null,
            }),
            messages: [{ role: 'user', content: userContentBlocks }],
            tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
          });
          console.log(`[generate-deck] step=stream-created model=${model} content_blocks=${userContentBlocks.length} attachments=${uploadedAttachments.length}`);

          // Forward content_block_start events as progress notes — the
          // user sees "Claude is editing the script" / "running the
          // sandbox" instead of staring at a single spinner for 90s.
          // Also belt-and-suspenders capture file_id from any event, in
          // case the SDK's finalMessage assembly drops nested fields.
          let outputFileId: string | null = null;
          const captureFileId = (root: unknown): void => {
            const seen = new Set<unknown>();
            const stack: unknown[] = [root];
            while (stack.length > 0) {
              const node = stack.pop();
              if (!node || typeof node !== 'object' || seen.has(node)) continue;
              seen.add(node);
              for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
                if (k === 'file_id' && typeof v === 'string') outputFileId = v;
                else if (v && typeof v === 'object') stack.push(v);
              }
            }
          };

          // Track request-start time so we can fall back to "list Files
          // API for newly-created .pptx during this request" if the
          // streaming response doesn't surface file_id (some model +
          // skill + code_execution combos drop the file_id from the
          // response even though the file lands in Files API).
          const requestStartedAtMs = Date.now() - 5000; // 5s slack

          // Diagnostic: count every event the SDK yields so a hang shows
          // up as "iterated 0 events in 5 min" rather than a silent void.
          // Also log the FIRST event so we can see what Anthropic
          // accepted (or rejected) before going quiet. The three runs
          // on record f7b2cd0d (2026-05-11) all stopped at "uploaded N
          // attachments" with zero subsequent logs — without these we
          // can't tell whether the request was rejected, the stream
          // never sent the first event, or every event was filtered out
          // by the type check below.
          let eventCount = 0;
          let lastEventType: string | null = null;
          const iterStartedAtMs = Date.now();
          try {
            for await (const event of turn) {
              eventCount++;
              lastEventType = event.type;
              if (eventCount === 1) {
                console.log(`[generate-deck] step=stream-first-event type=${event.type} elapsed_ms=${Date.now() - iterStartedAtMs}`);
              }
              if (eventCount % 50 === 0) {
                console.log(`[generate-deck] step=stream-progress events=${eventCount} last_type=${event.type} elapsed_ms=${Date.now() - iterStartedAtMs}`);
              }
              captureFileId(event);
              if (event.type === 'content_block_start') {
                const cb = (event as unknown as { content_block?: { type?: string; name?: string } }).content_block;
                const cbType = cb?.type ?? 'unknown';
                console.log(`[generate-deck] content_block_start type=${cbType} name=${cb?.name ?? 'n/a'}`);
                if (cbType === 'server_tool_use') {
                  send({ type: 'status', phase: 'calling-claude', detail: `tool: ${cb?.name ?? 'unknown'}` });
                }
              }
              if (event.type === 'message_stop' || event.type === 'error') {
                console.log(`[generate-deck] step=stream-terminal type=${event.type}`);
              }
            }
            console.log(`[generate-deck] step=stream-iter-done events=${eventCount} last_type=${lastEventType ?? 'none'} elapsed_ms=${Date.now() - iterStartedAtMs}`);
          } catch (streamErr) {
            const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
            console.error(`[generate-deck] step=stream-iter-FAIL events=${eventCount} last_type=${lastEventType ?? 'none'} elapsed_ms=${Date.now() - iterStartedAtMs} error=${msg}`);
            throw streamErr; // Re-throw so the outer catch writes status='failed'.
          }
          console.log(`[generate-deck] step=final-message-start`);
          const finalStartedAtMs = Date.now();
          const response = await turn.finalMessage();
          console.log(`[generate-deck] step=final-message-OK elapsed_ms=${Date.now() - finalStartedAtMs} blocks=${response.content.length}`);
          captureFileId(response.content);

          // PRIMARY return path: walk bash stdouts for the base64 sentinel
          // markers and extract bytes directly. This sidesteps Anthropic's
          // unreliable Files API capture entirely. If markers are present
          // and decode cleanly, we skip the Files API path below.
          let extractedBytes: Uint8Array | null = null;
          let extractedFilename: string | null = null;
          for (const block of response.content) {
            const b = block as { type?: string; content?: unknown };
            if (b.type !== 'bash_code_execution_tool_result') continue;
            const stdout = ((b.content as { stdout?: string } | undefined)?.stdout) ?? '';
            const start = stdout.indexOf(B64_MARKER_START);
            const end = stdout.indexOf(B64_MARKER_END);
            if (start === -1 || end === -1 || end <= start) continue;
            const lineEnd = stdout.indexOf('\n', start);
            if (lineEnd === -1) continue;
            const b64 = stdout.slice(lineEnd + 1, end).replace(/\s+/g, '');
            if (b64.length < 100) continue;
            try {
              const binStr = atob(b64);
              const out = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
              // Sanity-check: .pptx files start with PK\x03\x04 (zip magic)
              if (out.length >= 4 && out[0] === 0x50 && out[1] === 0x4b && out[2] === 0x03 && out[3] === 0x04) {
                extractedBytes = out;
                console.log(`[generate-deck] extracted ${out.byteLength} bytes from bash stdout via base64 markers`);
              } else {
                console.warn(`[generate-deck] base64 decoded ${out.byteLength} bytes but missing PK zip magic — discarding`);
              }
              break;
            } catch (e) {
              console.error('[generate-deck] base64 decode failed:', e);
            }
          }
          // Recover the filename Claude used (matches our prompt's pattern).
          // Prefer the `_reviewed` variant when both names appear in the
          // logs — when wassel-deck-review is loaded, the user gets the
          // reviewed file and the display name should reflect that.
          if (extractedBytes) {
            let reviewedName: string | null = null;
            let rawName: string | null = null;
            for (const block of response.content) {
              const b = block as { type?: string; content?: unknown };
              const stdout = ((b.content as { stdout?: string } | undefined)?.stdout) ?? '';
              if (!reviewedName) {
                const m = stdout.match(/wassel-deck-\d+_reviewed\.pptx/);
                if (m) reviewedName = m[0];
              }
              if (!rawName) {
                // Match a deck filename that is NOT immediately followed by
                // `_reviewed` — this is the raw build.
                const m = stdout.match(/wassel-deck-\d+(?!_reviewed)\.pptx/);
                if (m) rawName = m[0];
              }
              if (reviewedName) break;
            }
            extractedFilename = reviewedName ?? rawName;
          }

          if (!outputFileId && !extractedBytes) {
            // Fallback: scan Files API for any .pptx created during this
            // request window. Anthropic sometimes doesn't surface file_id
            // in the response even when the file landed in Files API.
            // We poll up to 3 times with a 2s gap between attempts — Files
            // API has indexing latency and the file may appear shortly
            // after the streaming response closes.
            console.log('[generate-deck] no file_id in response, scanning Files API');
            const scanFilesApi = async () => {
              const candidates: Array<{ id: string; filename: string; created_at: string }> = [];
              const listIter = (anthropic.beta.files as unknown as {
                list: (args: Record<string, unknown>) => AsyncIterable<{
                  id: string;
                  filename?: string;
                  created_at?: string;
                  size_bytes?: number;
                }>;
              }).list({ limit: 30 });
              for await (const f of listIter) {
                const ts = f.created_at ? new Date(f.created_at).getTime() : 0;
                if (ts >= requestStartedAtMs && (f.filename ?? '').endsWith('.pptx')) {
                  candidates.push({
                    id: f.id,
                    filename: f.filename ?? `deck-${Date.now()}.pptx`,
                    created_at: f.created_at ?? '',
                  });
                }
              }
              candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
              return candidates;
            };
            try {
              for (let attempt = 0; attempt < 3 && !outputFileId; attempt++) {
                if (attempt > 0) {
                  console.log(`[generate-deck] fallback retry ${attempt + 1}/3 after 2s`);
                  await new Promise((r) => setTimeout(r, 2000));
                }
                const candidates = await scanFilesApi();
                console.log(`[generate-deck] fallback attempt ${attempt + 1}: ${candidates.length} candidates after threshold ${requestStartedAtMs}`);
                if (candidates.length > 0 && candidates[0]) {
                  outputFileId = candidates[0].id;
                  console.log(`[generate-deck] fallback recovered file_id=${outputFileId} filename=${candidates[0].filename}`);
                  send({ type: 'status', phase: 'calling-claude', detail: 'recovered output via Files API fallback' });
                  break;
                }
              }
            } catch (listErr) {
              console.error('[generate-deck] Files API list fallback failed:', listErr);
            }
          }

          if (!outputFileId && !extractedBytes) {
            // Still nothing. Surface the most actionable error — full
            // last text (no truncation), last bash stdout (so we can
            // see the path Claude used and decide whether the file
            // was actually written), and stop_reason.
            const stopReason = (response as unknown as { stop_reason?: string }).stop_reason;
            const lastText = response.content
              .filter((b) => (b as { type?: string }).type === 'text')
              .map((b) => (b as { text?: string }).text ?? '')
              .pop();
            // Walk for the LAST bash result's stdout/stderr/return_code.
            let lastBash: { stdout?: string; stderr?: string; return_code?: number } | null = null;
            for (const b of response.content) {
              const bb = b as { type?: string; content?: { stdout?: string; stderr?: string; return_code?: number } | unknown };
              if (bb.type === 'bash_code_execution_tool_result' && bb.content && typeof bb.content === 'object') {
                lastBash = bb.content as { stdout?: string; stderr?: string; return_code?: number };
              }
            }
            if (stopReason === 'max_tokens') {
              throw new Error(
                `Claude ran out of output tokens before saving the .pptx. Try a shorter brief.\n\nLast note: ${lastText ?? '(empty)'}`,
              );
            }
            const lines: string[] = [
              `Claude finished without surfacing a file_id (Anthropic-side intermittent issue with Skills + code_execution).`,
              ``,
              `stop_reason: ${stopReason ?? 'unknown'}`,
              ``,
              `Claude's final note:`,
              lastText ?? '(empty)',
            ];
            if (lastBash) {
              lines.push(``, `Last bash result: rc=${lastBash.return_code ?? '?'}`);
              if (lastBash.stdout) lines.push(`stdout: ${lastBash.stdout.slice(0, 600)}`);
              if (lastBash.stderr) lines.push(`stderr: ${lastBash.stderr.slice(0, 600)}`);
            }
            lines.push(``, `Try clicking "إعادة المحاولة" again — this is intermittent and usually works on the second or third try.`);
            throw new Error(lines.join('\n'));
          }

          // Source the bytes — base64-from-stdout (primary) wins; otherwise
          // fall back to Anthropic Files API download. Per-step logs from
          // here on are deliberately verbose: a previous run (record
          // 545bd8d6, 2026-05-10 17:56:58) extracted bytes successfully
          // but never wrote status='ready' or status='failed', leaving
          // the record stuck in 'generating' indefinitely. We need to
          // know which post-extraction step the function dies on next
          // time so we can fix it instead of guessing.
          let bytes: Uint8Array;
          let filename: string;
          if (extractedBytes) {
            bytes = extractedBytes;
            filename = (extractedFilename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
            console.log(`[generate-deck] step=source-bytes route=base64 size=${bytes.byteLength}B filename=${filename}`);
            send({ type: 'status', phase: 'uploading', detail: `${(bytes.byteLength / 1024).toFixed(0)} KB (via base64 stream)` });
          } else if (outputFileId) {
            send({ type: 'status', phase: 'downloading' });
            console.log(`[generate-deck] step=files-api-download file_id=${outputFileId}`);
            const meta = await anthropic.beta.files.retrieveMetadata(outputFileId);
            const dlResponse = await anthropic.beta.files.download(outputFileId);
            const arrayBuffer = await dlResponse.arrayBuffer();
            bytes = new Uint8Array(arrayBuffer);
            filename = (meta.filename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
            console.log(`[generate-deck] step=source-bytes route=files-api size=${bytes.byteLength}B filename=${filename}`);
            send({ type: 'status', phase: 'uploading', detail: `${(bytes.byteLength / 1024).toFixed(0)} KB` });
          } else {
            throw new Error('internal: reached upload branch without bytes or file_id');
          }
          const path = `${user.userId}/${body.recordId}/${filename}`;

          // withTimeout wrapper. If any single Supabase op hangs (we
          // observed a silent hang after extraction on record 545bd8d6),
          // we raise a clear error instead of letting Vercel kill the
          // function silently — the catch block then writes
          // status='failed' with a useful message.
          const withTimeout = async <T>(label: string, ms: number, p: Promise<T>): Promise<T> => {
            return Promise.race([
              p,
              new Promise<T>((_, reject) =>
                setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
              ),
            ]);
          };

          console.log(`[generate-deck] step=storage-upload-start path=${path}`);
          const uploadStartedAt = Date.now();
          const { error: uploadErr } = await withTimeout(
            'storage upload',
            45_000,
            supabase.storage
              .from(STORAGE_BUCKET)
              .upload(path, bytes, {
                contentType: PPTX_MIME,
                upsert: true,
              }),
          );
          if (uploadErr) {
            console.error(`[generate-deck] step=storage-upload-FAIL path=${path} error=${uploadErr.message}`);
            throw new Error(`Storage upload failed: ${uploadErr.message}`);
          }
          console.log(`[generate-deck] step=storage-upload-OK path=${path} elapsed_ms=${Date.now() - uploadStartedAt}`);

          send({ type: 'status', phase: 'finalizing' });
          console.log(`[generate-deck] step=sign-url-start`);
          const signStartedAt = Date.now();
          const { data: signed, error: signErr } = await withTimeout(
            'signed URL creation',
            10_000,
            supabase.storage
              .from(STORAGE_BUCKET)
              .createSignedUrl(path, SIGNED_URL_TTL_SECONDS),
          );
          if (signErr || !signed) {
            console.error(`[generate-deck] step=sign-url-FAIL error=${signErr?.message ?? 'unknown'}`);
            throw new Error(`signed URL creation failed: ${signErr?.message ?? 'unknown'}`);
          }
          console.log(`[generate-deck] step=sign-url-OK elapsed_ms=${Date.now() - signStartedAt}`);

          console.log(`[generate-deck] step=record-save-ready-start`);
          const recordStartedAt = Date.now();
          await withTimeout(
            'record_save (ready)',
            10_000,
            updateRecord({
              status: 'ready',
              file_url: signed.signedUrl,
              file_path: path,
              filename,
              anthropic_file_id: outputFileId,
              error_message: null,
            }),
          );
          console.log(`[generate-deck] step=record-save-ready-OK elapsed_ms=${Date.now() - recordStartedAt} record=${body.recordId}`);

          send({
            type: 'done',
            file_url: signed.signedUrl,
            file_path: path,
            filename,
          });
          console.log(`[generate-deck] step=DONE record=${body.recordId} filename=${filename}`);
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[generate-deck] step=CATCH record=${body.recordId} message=${message}`, err);
          // Best-effort: mark the record as failed so the UI can show an
          // error state on reload. If this itself fails, surface BOTH
          // problems to the SSE consumer rather than silently dropping one.
          let combined = message;
          try {
            await updateRecord({ status: 'failed', error_message: message });
            console.log(`[generate-deck] step=CATCH-record-saved-failed record=${body.recordId}`);
          } catch (innerErr) {
            const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
            console.error(`[generate-deck] step=CATCH-record-save-FAILED record=${body.recordId} inner=${innerMsg}`);
            combined = `${message} — and updating the record also failed: ${innerMsg}`;
          }
          try {
            send({ type: 'error', message: combined });
          } catch {
            // Controller already closed — nothing to do.
          }
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
