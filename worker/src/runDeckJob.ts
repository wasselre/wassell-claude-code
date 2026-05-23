/**
 * runDeckJob — 3-phase Wassel deck pipeline.
 *
 * Phases (each is a separate Anthropic call with its own 1M context budget):
 *   1. Plan    — Claude reads brief + attachments + page images, outputs
 *                a structured markdown plan covering every design decision.
 *                Includes code execution so Claude can sample non-PDF
 *                attachments (xlsx/docx/etc.) but no .pptx is built.
 *   2. Build   — Claude reads the PLAN + brand skill + attachments mounted
 *                in the sandbox, writes python-pptx code, produces .pptx
 *                bytes via the base64 sentinel.
 *   3. Review  — Claude reads the built .pptx + the review skill, auto-
 *                patches brand-compliance issues, returns reviewed .pptx.
 *                Skipped if ANTHROPIC_WASSEL_REVIEW_SKILL_ID is unset.
 *                If the review call itself fails, we ship the unreviewed
 *                build rather than failing the whole job — the user still
 *                gets a deck.
 *
 * Why three calls instead of one? Each call gets its own 1M context budget.
 * The previous single-call flow accumulated ~50 agent turns of tool calls
 * and thinking into one context that hit the 1M ceiling at ~10 min in
 * (record bdf9b0ed, 2026-05-23). Splitting gives each phase enough room to
 * think hard without truncation. Total reasoning ACROSS the pipeline is
 * HIGHER than the old single call, not lower — each phase keeps the same
 * model + adaptive thinking + effort settings as before.
 *
 * The SPA shows `phase = 'calling-claude'` for all three calls and reads
 * `phase_detail` for the sub-step label ("planning the design…" /
 * "building slides…" / "reviewing & auto-patching…"). No SPA-side changes
 * were needed; the existing 4-step progress bar (calling-claude →
 * downloading → uploading → finalizing) still applies, the Claude step
 * just internally has three legs.
 *
 * Carried-over invariants (unchanged from the 1-call version):
 *   • record_save RPC with p_expected_version=null (worker is sole writer)
 *   • created_by_user_id preserved on every update (never NULL the FK)
 *   • errors humanized via humanizeErrorMessage for the UI's red box
 *   • base64 stdout sentinel is the primary .pptx return path
 *   • Files API list scan is the fallback when the sentinel didn't fire
 *   • heartbeat every 30s during each stream so the client stuck-detector
 *     doesn't false-fire during long tool turns
 *
 * Auth model: service-role Supabase client — bypasses RLS. Ownership is
 * enforced by reading the deck record's `created_by_user_id` and comparing
 * against job.userId before any writes.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { pdfToImages } from './pdfToImages.js';

export interface DeckJob {
  /** deck_jobs.id */
  id: string;
  /** records.id (the deck record being filled in). */
  deckRecordId: string;
  /** auth.users.id of the submitter. */
  userId: string;
  /** Frozen request body — { brief, language, model, size, attachments }. */
  payload: Record<string, unknown>;
  attempts: number;
}

type DeckSize = '16:9' | '9:16' | '4:3' | '1:1';

interface DeckAttachmentRef {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

interface JobPayload {
  brief: string;
  language: 'ar' | 'en' | 'mixed';
  model: 'claude-opus-4-7' | 'claude-sonnet-4-6';
  size: DeckSize;
  attachments: DeckAttachmentRef[];
}

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const STORAGE_BUCKET = 'wassel-decks';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

const SIZE_TO_INCHES: Record<DeckSize, { width: number; height: number }> = {
  '16:9': { width: 13.333, height: 7.5 },
  '9:16': { width: 7.5, height: 13.333 },
  '4:3': { width: 10, height: 7.5 },
  '1:1': { width: 7.5, height: 7.5 },
};

/** Vision-tier images (regular image attachments) added as image blocks. */
const MAX_VISION_IMAGES = 3;
const VISION_IMAGE_BYTES_CAP = 5 * 1024 * 1024;
/** Max PDF page-images we render and pass as image content blocks. See
 * pdfToImages.PdfRenderOptions.longEdgePx (default 1200) for token-cost
 * math. Visual page images are passed ONLY to the Plan phase — the Build
 * phase works from the plan, the Review phase works from the built .pptx.
 * The original PDF is also `container_upload`'d to every phase that needs
 * sandbox access so Python (pypdf/pdfplumber) can still read the full
 * doc. */
const MAX_PDF_PAGES_AS_IMAGES = 20;

const ANTHROPIC_BETAS = [
  'skills-2025-10-02',
  'code-execution-2025-08-25',
  'files-api-2025-04-14',
];

// Bash-stdout sentinel channel — the reliable .pptx return path. The
// sandbox has no outbound internet (DNS blocked) so we can't curl
// directly to Supabase. Asking Claude to base64 the saved file between
// these markers in a FINAL bash works around it. Tested with 200KB+
// payloads — stdout returns all bytes intact.
const B64_MARKER_START = '===WASSEL_DECK_B64_START===';
const B64_MARKER_END = '===WASSEL_DECK_B64_END===';

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: DeckJob;
}

interface UploadedAttachment {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Captured ONLY for PDFs — used by the page-rendering step. */
  pdfBytes: Uint8Array | null;
}

// ═══════════════════════════════════════════════════════════════════════
// System prompts — one per phase.
// ═══════════════════════════════════════════════════════════════════════

function sizeBlockFor(size: DeckSize): string {
  const dims = SIZE_TO_INCHES[size];
  return `Slide size: ${size} (${dims.width}" × ${dims.height}"). When initializing the python-pptx Presentation, set:
    prs.slide_width  = Inches(${dims.width})
    prs.slide_height = Inches(${dims.height})
Compose every layout for this aspect ratio — don't reuse 16:9 grids on a 9:16 deck.`;
}

function attachmentsBlockFor(
  attachments: ReadonlyArray<{ name: string; mimeType: string }>,
): string {
  if (attachments.length === 0) return '';
  return `\n\nUser attachments are mounted at /mnt/user-data/uploads/ — inspect them BEFORE making any decision because the user expects you to use them:
${attachments.map((a) => `  • ${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}`).join('\n')}

Read the right tool per type:
  • .xlsx / .xls / .csv → pandas / openpyxl: extract the rows the user is referring to and turn them into slides (charts, tables, callouts)
  • .pdf                → pypdf or pdfplumber: pull headings + body. Some PDFs were also passed natively above — read them visually if so
  • .pptx               → python-pptx: read existing slides; copy structure / typography / brand if asked
  • .docx               → python-docx: read paragraphs as deck content
  • images              → PIL for dimensions; embed via slide.shapes.add_picture(path, ...). Some images were also passed visually above — use them for layout decisions`;
}

/**
 * PHASE 1 system prompt: produce a structured markdown plan. No .pptx
 * is built in this call — Claude outputs the plan as its final text
 * response, which the Build phase parses to drive python-pptx code.
 */
function buildPlanSystemPrompt(args: {
  size: DeckSize;
  attachments: ReadonlyArray<{ name: string; mimeType: string }>;
}): string {
  return `You are designing a Wassel-branded PowerPoint deck (وصل العقارية).

The 'wassel-general-ppt' skill is loaded at /mnt/skills/wassel-general-ppt/. Read its SKILL.md NOW so the brand system (palette, typography, RTL rules, layout primitives) is in your head before you plan.

YOUR JOB IN THIS CALL: produce a complete slide-by-slide MARKDOWN PLAN. Make EVERY design decision now — palette choices, layouts, exact Arabic/English copy, imagery placement, chart types. Another Claude session receives this plan and translates it directly into python-pptx; they will not re-do design work or fill gaps.

DO NOT build a .pptx in this call. Do not run python-pptx. Do not base64 anything. Your final output is the plan as a text response.

${sizeBlockFor(args.size)}${attachmentsBlockFor(args.attachments)}

Plan format — use this exact markdown structure (the Build phase parses by these headings):

# Wassel Deck Plan

## Meta
- Project: <name from brief>
- Language: <ar | en | mixed>
- Size: <e.g. 16:9>
- Slide count: <N>

## Brand decisions
- Palette emphasis: <which Wassel colors dominate this deck>
- Typography: <Amiri default; any role-specific weight/size choices>
- Visual motif: <1-2 sentences on the overall visual feel>

## Slide 1 — <short name like "Cover" or "Market overview">
- Layout: <hero | section-divider | data-card | image-text-split | bullet-list | comparison-table | chart | quote | timeline | cta>
- Background: <#hex or named brand color>
- Title (ar): "<exact text>"
- Title (en): "<exact text, or 'omit' if Arabic-only>"
- Subtitle: "<exact text, or 'none'>"
- Body / bullets:
  - <bullet 1>
  - <bullet 2>
- Imagery: <none | description + source (e.g. "page 3 of brochure.pdf, top-right rendering") + placement>
- Charts/tables: <none | spec with data source>
- Notes: <quirks, alignment hints, custom typography>

## Slide 2 — …

(continue for every slide)

## Build hints
- <cross-slide meta-instructions, e.g. "use the brochure's terracotta as accent on slides 3-6", "embed cover image from page 1 on slide 1 top-right">

Quality bar:
  • Be thorough: typical deck is 8-15 slides; never fewer than 5.
  • Every slide section must list ALL fields (use "none" where applicable).
  • If language hint is 'ar', write copy in Arabic. If 'en', English. If 'mixed', choose per-slide.
  • Use specific brand hex codes from the skill's palette, not generic color names.
  • Imagery instructions must reference attachments by name + page/cell where applicable.

End your response with the plan ONLY — no preamble like "Here is the plan:", no postamble like "Let me know if…". The Build phase reads your text verbatim and acts on it.`;
}

/**
 * PHASE 2 system prompt: execute the plan in python-pptx, return .pptx via
 * the base64 sentinel. The plan is in the user message.
 */
function buildBuildSystemPrompt(args: {
  size: DeckSize;
  attachments: ReadonlyArray<{ name: string; mimeType: string }>;
}): string {
  return `You are implementing a Wassel-branded PowerPoint deck (وصل العقارية) per a pre-written design plan.

The 'wassel-general-ppt' skill is loaded at /mnt/skills/wassel-general-ppt/. Use its drawing primitives, brand colors, font helpers, and Arabic typography helpers as documented in its SKILL.md.

YOUR JOB IN THIS CALL: execute the plan attached in the user message and return the .pptx via the base64 sentinel. The design is SETTLED — focus on faithful, brand-correct implementation. Don't redesign; don't improvise extra slides; don't override palette choices from the plan.

${sizeBlockFor(args.size)}${attachmentsBlockFor(args.attachments)}

Save the deck to \`/mnt/user-data/outputs/wassel-deck-<unix_ms>.pptx\`. After saving, run ONE final bash that prints the file as base64 between sentinel lines (this is how the file reaches the user — the receiver scans bash stdouts for these exact markers):

    echo "${B64_MARKER_START}"
    base64 -w0 /mnt/user-data/outputs/<FILE>
    echo
    echo "${B64_MARKER_END}"

If the plan references imagery from attachments, open the attachment with PIL/pypdf and use \`slide.shapes.add_picture(...)\` to embed it.

Don't skip slides or shorten the plan. If a slide spec looks light, render it as specified — the planner chose that for a reason. If a field says "none", don't add anything for it.`;
}

/**
 * PHASE 3 system prompt: review the built .pptx via the wassel-deck-review
 * skill and return the reviewed .pptx via the base64 sentinel.
 */
function buildReviewSystemPrompt(args: { inputFilename: string }): string {
  return `You are reviewing a freshly-built Wassel PowerPoint for brand compliance and typography bugs (وصل العقارية).

The 'wassel-deck-review' skill is loaded at /mnt/skills/wassel-deck-review/. Use its review_deck() routine — it auto-patches the mechanical issues (broken RTL on tables, missing complex-script font slots that make Arabic render as theme default, blue hyperlink color, double-spaced separators, missing LRM marks on numbers inside Arabic text, parens-in-body, banned phrases like "Wassel CRM", etc.).

The deck to review is mounted at /mnt/user-data/uploads/${args.inputFilename}.

YOUR JOB: run review_deck() with fix=True, then return the reviewed .pptx via the base64 sentinel. Don't redesign — don't change copy, layouts, or colors. Just lint and auto-patch.

\`\`\`python
import sys
sys.path.insert(0, "/mnt/skills/wassel-deck-review/scripts")
from review import review_deck

raw_path = "/mnt/user-data/uploads/${args.inputFilename}"
reviewed_path = "/mnt/user-data/outputs/wassel-deck-<unix_ms>_reviewed.pptx"
report = review_deck(input_path=raw_path, output_path=reviewed_path, fix=True)
print(report.markdown())  # useful in the log
\`\`\`

Then run ONE final bash that prints the **reviewed** file as base64 between sentinel lines:

    echo "${B64_MARKER_START}"
    base64 -w0 /mnt/user-data/outputs/wassel-deck-<unix_ms>_reviewed.pptx
    echo
    echo "${B64_MARKER_END}"

If the review skill exposes a different entrypoint than \`review_deck\`, follow its SKILL.md. The goal is one reviewed .pptx returned via the sentinel.`;
}

// ═══════════════════════════════════════════════════════════════════════
// Shared stream-runner helper. Each phase calls this with its own params.
// ═══════════════════════════════════════════════════════════════════════

interface AnthropicStreamResult {
  content: unknown[];
  outputFileId: string | null;
  eventCount: number;
}

/**
 * Run one Anthropic streaming turn end-to-end:
 *   • iterate the stream (with heartbeat + phase_detail throttling + logs)
 *   • capture any file_id deep in tool results
 *   • return the final message's content blocks
 *
 * Errors during stream iteration propagate out — the caller decides
 * whether to humanize + persist to the deck record (top-level) or to
 * swallow (e.g. review phase failures don't kill the job).
 */
async function runAnthropicStream(args: {
  anthropic: Anthropic;
  /** Used as a log prefix: 'plan' | 'build' | 'review'. */
  label: string;
  /** User-visible substep label written to record.data.phase_detail. */
  phaseDetailUi: string;
  /** Raw params handed straight to `anthropic.beta.messages.stream`. */
  streamParams: Record<string, unknown>;
  updateRecord: (patch: Record<string, unknown>) => Promise<void>;
}): Promise<AnthropicStreamResult> {
  const { anthropic, label, phaseDetailUi, streamParams, updateRecord } = args;

  await updateRecord({ phase: 'calling-claude', phase_detail: phaseDetailUi });

  const turn = (anthropic.beta.messages as unknown as {
    stream: (params: Record<string, unknown>) => {
      [Symbol.asyncIterator]: () => AsyncIterator<{ type: string; [k: string]: unknown }>;
      finalMessage: () => Promise<{ content: unknown[] }>;
    };
  }).stream(streamParams);

  console.log(`[run][${label}] stream-created`);
  const iterStartedAtMs = Date.now();
  let eventCount = 0;
  let lastEventType: string | null = null;
  let outputFileId: string | null = null;
  let lastPhaseWriteAt = 0;

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

  const tryWritePhaseDetail = async (sub: string) => {
    const now = Date.now();
    if (now - lastPhaseWriteAt < 2000) return;
    lastPhaseWriteAt = now;
    try {
      await updateRecord({
        phase: 'calling-claude',
        phase_detail: `${phaseDetailUi} · ${sub}`,
      });
    } catch (err) {
      console.warn(
        `[run][${label}] phase_detail update failed (non-fatal): ${(err as Error).message}`,
      );
    }
  };

  // Heartbeat — bumps updated_at every 30s so the SPA's stuck-detector
  // doesn't false-fire while Claude is mid-tool-call. Cleaned up in
  // `finally` so an early throw never leaks the interval.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeat = setInterval(() => {
    void updateRecord({}).catch((err) => {
      console.warn(
        `[run][${label}] heartbeat failed (non-fatal): ${(err as Error).message}`,
      );
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    for await (const event of turn) {
      eventCount++;
      lastEventType = event.type;
      if (eventCount === 1) {
        console.log(
          `[run][${label}] stream-first-event type=${event.type} elapsed_ms=${Date.now() - iterStartedAtMs}`,
        );
      }
      if (eventCount % 50 === 0) {
        console.log(
          `[run][${label}] stream-progress events=${eventCount} last_type=${event.type} elapsed_ms=${Date.now() - iterStartedAtMs}`,
        );
      }
      captureFileId(event);
      if (event.type === 'content_block_start') {
        const cb = (event as unknown as { content_block?: { type?: string; name?: string } })
          .content_block;
        const cbType = cb?.type ?? 'unknown';
        console.log(`[run][${label}] content_block_start type=${cbType} name=${cb?.name ?? 'n/a'}`);
        if (cbType === 'server_tool_use') {
          await tryWritePhaseDetail(`tool: ${cb?.name ?? 'unknown'}`);
        }
      }
      if (event.type === 'message_stop' || event.type === 'error') {
        console.log(`[run][${label}] stream-terminal type=${event.type}`);
      }
    }
    console.log(
      `[run][${label}] stream-iter-done events=${eventCount} last_type=${lastEventType ?? 'none'} elapsed_ms=${Date.now() - iterStartedAtMs}`,
    );
  } catch (streamErr) {
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    console.error(
      `[run][${label}] stream-iter-FAIL events=${eventCount} last_type=${lastEventType ?? 'none'} elapsed_ms=${Date.now() - iterStartedAtMs} error=${msg}`,
    );
    throw streamErr;
  } finally {
    clearInterval(heartbeat);
  }

  console.log(`[run][${label}] final-message-start`);
  const finalStartedAtMs = Date.now();
  const response = await turn.finalMessage();
  console.log(
    `[run][${label}] final-message-OK elapsed_ms=${Date.now() - finalStartedAtMs} blocks=${response.content.length}`,
  );
  captureFileId(response.content);

  return { content: response.content, outputFileId, eventCount };
}

// ═══════════════════════════════════════════════════════════════════════
// Extractors — pull plan text / .pptx bytes / filename out of a stream's
// final content blocks.
// ═══════════════════════════════════════════════════════════════════════

/** Concatenate all text blocks in the response (excludes thinking blocks). */
function extractPlanFromContent(content: unknown[]): string {
  return content
    .filter((b) => (b as { type?: string }).type === 'text')
    .map((b) => ((b as { text?: string }).text ?? '').trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * Extract .pptx bytes from a bash_code_execution_tool_result via the base64
 * sentinel, plus best-effort filename detection. Returns null if no
 * sentinel-bounded base64 with PK zip magic was found.
 */
function extractPptxFromContent(
  content: unknown[],
): { bytes: Uint8Array; filename: string | null } | null {
  let extractedBytes: Uint8Array | null = null;
  for (const block of content) {
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
      const buf = Buffer.from(b64, 'base64');
      const out = new Uint8Array(buf);
      // .pptx files start with PK\x03\x04 (zip magic).
      if (
        out.length >= 4 &&
        out[0] === 0x50 &&
        out[1] === 0x4b &&
        out[2] === 0x03 &&
        out[3] === 0x04
      ) {
        extractedBytes = out;
        console.log(
          `[run] extracted ${out.byteLength} bytes from bash stdout via base64 markers`,
        );
      } else {
        console.warn(
          `[run] base64 decoded ${out.byteLength} bytes but missing PK zip magic — discarding`,
        );
      }
      break;
    } catch (e) {
      console.error('[run] base64 decode failed:', e);
    }
  }
  if (!extractedBytes) return null;

  // Best-effort: recover filename printed in any tool stdout.
  let reviewedName: string | null = null;
  let rawName: string | null = null;
  for (const block of content) {
    const b = block as { type?: string; content?: unknown };
    const stdout = ((b.content as { stdout?: string } | undefined)?.stdout) ?? '';
    if (!reviewedName) {
      const m = stdout.match(/wassel-deck-\d+_reviewed\.pptx/);
      if (m) reviewedName = m[0];
    }
    if (!rawName) {
      const m = stdout.match(/wassel-deck-\d+(?!_reviewed)\.pptx/);
      if (m) rawName = m[0];
    }
    if (reviewedName) break;
  }
  return { bytes: extractedBytes, filename: reviewedName ?? rawName };
}

// ═══════════════════════════════════════════════════════════════════════
// runDeckJob — top-level entrypoint.
// ═══════════════════════════════════════════════════════════════════════

export async function runDeckJob({ supabase, env, job }: RunArgs): Promise<void> {
  // ── Parse / validate payload ────────────────────────────────────────
  const payload = job.payload as Partial<JobPayload>;
  const brief = (payload.brief ?? '').toString().trim();
  if (brief.length < 10) {
    throw new Error(`brief must be at least 10 characters (got ${brief.length})`);
  }
  const language = (payload.language ?? 'ar') as JobPayload['language'];
  const model = (payload.model ?? 'claude-opus-4-7') as JobPayload['model'];
  if (!['claude-opus-4-7', 'claude-sonnet-4-6'].includes(model)) {
    throw new Error(`unsupported model: ${model}`);
  }
  const size = (payload.size ?? '16:9') as DeckSize;
  if (!(size in SIZE_TO_INCHES)) {
    throw new Error(`unsupported size: ${size}`);
  }
  const attachments: DeckAttachmentRef[] = Array.isArray(payload.attachments)
    ? payload.attachments
    : [];
  for (const att of attachments) {
    if (!att.path || typeof att.path !== 'string' || !att.path.startsWith(`${job.userId}/`)) {
      throw new Error(`attachment path outside user scope: ${att.path ?? '(missing)'}`);
    }
  }

  // ── Resolve decks model id ──────────────────────────────────────────
  const { data: modelRow, error: modelErr } = await supabase
    .from('models')
    .select('id')
    .eq('name', 'decks')
    .single();
  if (modelErr || !modelRow) {
    throw new Error(`decks model not found: ${modelErr?.message ?? 'unknown'}`);
  }
  const decksModelId = modelRow.id as string;

  // ── Record-update helper ────────────────────────────────────────────
  // Mirrors the api/generate-deck pattern: read current data + created_by,
  // merge patch, write through record_save RPC with p_expected_version=null
  // (worker is the sole writer during a generation). Preserves
  // created_by_user_id (never overwrites with service-role NULL — that
  // would break the FK to public.users).
  const updateRecord = async (patch: Record<string, unknown>) => {
    const { data: current, error: readErr } = await supabase
      .from('records')
      .select('data, created_by_user_id')
      .eq('id', job.deckRecordId)
      .single();
    if (readErr || !current) {
      throw new Error(`failed to read decks record: ${readErr?.message ?? 'not found'}`);
    }
    const newData = { ...(current.data as Record<string, unknown>), ...patch };
    const { error: saveErr } = await supabase.rpc('record_save', {
      p_model_id: decksModelId,
      p_id: job.deckRecordId,
      p_data: newData,
      p_created_by:
        (current as { created_by_user_id: string | null }).created_by_user_id ?? null,
      p_expected_version: null,
    });
    if (saveErr) {
      throw new Error(`record_save failed: ${saveErr.message}`);
    }
  };

  // Stamp initial state. `phase = 'calling-claude'` and a thin
  // `phase_detail` get the SPA's progress UI showing immediately via
  // Realtime. The three Claude phases will each refine phase_detail.
  await updateRecord({
    status: 'generating',
    phase: 'calling-claude',
    phase_detail: 'starting…',
    model_used: model,
    language,
    size,
    attachments,
    error_message: null,
  });

  // From here, any throw MUST also write status='failed' to the record
  // so the UI's spinner exits via Realtime. The catch in index.ts marks
  // the deck_jobs row failed but doesn't touch the deck record — that's
  // our job.
  try {
    await runGeneration();
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendlyMsg = humanizeErrorMessage(rawMsg);
    try {
      await updateRecord({
        status: 'failed',
        phase: null,
        phase_detail: null,
        error_message: friendlyMsg,
      });
    } catch (recErr) {
      console.error('[run] could not mark deck record failed:', (recErr as Error).message);
    }
    throw err;
  }

  async function runGeneration(): Promise<void> {
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    // ── Upload attachments + render PDF page-images (shared) ──────────
    // Done ONCE; the resulting file_ids are reused across all three
    // phases via container_upload blocks. Page-image blocks go ONLY to
    // the Plan phase (Build & Review work from the plan / .pptx
    // respectively, not from raw page renders).
    const uploadedAttachments = await uploadAttachmentsToAnthropic({
      anthropic,
      supabase,
      attachments,
      updateRecord,
    });
    const pdfPageImageBlocks = await renderPdfPageImageBlocks({
      anthropic,
      supabase,
      uploadedAttachments,
      job,
      updateRecord,
    });
    const visionImageBlocks = uploadedAttachments
      .filter((a) => a.mimeType.startsWith('image/') && a.sizeBytes <= VISION_IMAGE_BYTES_CAP)
      .slice(0, MAX_VISION_IMAGES)
      .map((a) => ({
        type: 'image',
        source: { type: 'file', file_id: a.fileId },
      }));
    const containerUploads = uploadedAttachments.map((a) => ({
      type: 'container_upload',
      file_id: a.fileId,
    }));

    // ════════════════════════════════════════════════════════════════
    // PHASE 1 — PLAN
    // ════════════════════════════════════════════════════════════════
    const planUserBlocks: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text:
          `Brief:\n${brief}\n\n` +
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
            : '') +
          (pdfPageImageBlocks.length > 0
            ? `\n\nThe ${pdfPageImageBlocks.length} image${pdfPageImageBlocks.length === 1 ? '' : 's'} attached below ${pdfPageImageBlocks.length === 1 ? 'is' : 'are'} the rendered page${pdfPageImageBlocks.length === 1 ? '' : 's'} of the PDF, in order. Use ${pdfPageImageBlocks.length === 1 ? 'it' : 'them'} for visual reference (layout, color, typography); read the full PDF via the sandbox for detailed text.`
            : '') +
          `\n\nNow produce the markdown plan as your final text response. Do not build a .pptx in this call.`,
      },
      ...containerUploads,
      ...visionImageBlocks,
      ...pdfPageImageBlocks,
    ];

    const planResp = await runAnthropicStream({
      anthropic,
      label: 'plan',
      phaseDetailUi: 'planning the design…',
      updateRecord,
      streamParams: {
        model,
        max_tokens: 16_000,
        ...(model === 'claude-opus-4-7'
          ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
          : {}),
        betas: ANTHROPIC_BETAS,
        container: {
          skills: [
            { type: 'custom', skill_id: env.ANTHROPIC_WASSEL_SKILL_ID, version: 'latest' },
          ],
        },
        system: buildPlanSystemPrompt({
          size,
          attachments: uploadedAttachments.map((u) => ({ name: u.name, mimeType: u.mimeType })),
        }),
        messages: [{ role: 'user', content: planUserBlocks }],
        tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
      },
    });

    const planMd = extractPlanFromContent(planResp.content);
    if (planMd.trim().length < 200) {
      throw new Error(
        `Plan phase returned no usable plan (got ${planMd.length} chars).`,
      );
    }
    console.log(`[run][plan] extracted plan length=${planMd.length} chars`);

    // Surface the plan in the record so it's visible in the Supabase
    // dashboard for debugging. Truncate to keep the record JSONB small —
    // the in-memory `planMd` is still passed to Build at full length.
    await updateRecord({ plan_markdown: planMd.slice(0, 30_000) });

    // ════════════════════════════════════════════════════════════════
    // PHASE 2 — BUILD
    // ════════════════════════════════════════════════════════════════
    const buildUserBlocks: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text:
          `DESIGN PLAN — execute this faithfully:\n\n` +
          `${planMd}\n\n` +
          `---\n\n` +
          `Slide size: ${size}.\n` +
          (uploadedAttachments.length > 0
            ? `Attachments mounted at /mnt/user-data/uploads/:\n${uploadedAttachments
                .map((u) => `  • ${u.name} (${u.mimeType})`)
                .join('\n')}\n`
            : '') +
          `\nBuild the .pptx now. Save it to /mnt/user-data/outputs/wassel-deck-<unix_ms>.pptx, then return it via the ${B64_MARKER_START} / ${B64_MARKER_END} base64 sentinel.`,
      },
      ...containerUploads,
    ];

    const buildResp = await runAnthropicStream({
      anthropic,
      label: 'build',
      phaseDetailUi: 'building slides…',
      updateRecord,
      streamParams: {
        model,
        max_tokens: 32_000,
        ...(model === 'claude-opus-4-7'
          ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
          : {}),
        betas: ANTHROPIC_BETAS,
        container: {
          skills: [
            { type: 'custom', skill_id: env.ANTHROPIC_WASSEL_SKILL_ID, version: 'latest' },
          ],
        },
        system: buildBuildSystemPrompt({
          size,
          attachments: uploadedAttachments.map((u) => ({ name: u.name, mimeType: u.mimeType })),
        }),
        messages: [{ role: 'user', content: buildUserBlocks }],
        tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
      },
    });

    let extracted = extractPptxFromContent(buildResp.content);

    // Files API fallback if the base64 sentinel didn't fire.
    if (!extracted && buildResp.outputFileId) {
      console.log('[run][build] no base64 bytes, downloading by captured file_id');
      const meta = await anthropic.beta.files.retrieveMetadata(buildResp.outputFileId);
      const dlResponse = await anthropic.beta.files.download(buildResp.outputFileId);
      const arrayBuffer = await dlResponse.arrayBuffer();
      extracted = {
        bytes: new Uint8Array(arrayBuffer),
        filename: meta.filename ?? null,
      };
    } else if (!extracted) {
      // Last resort: scan recent Files API entries.
      const scanned = await scanFilesApiForRecentPptx(anthropic);
      if (scanned) extracted = scanned;
    }

    if (!extracted) {
      throw buildNoFileIdError(buildResp.content);
    }
    console.log(
      `[run][build] bytes=${extracted.bytes.byteLength} filename=${extracted.filename ?? '(unset)'}`,
    );

    let finalBytes = extracted.bytes;
    let finalFilename = (extracted.filename ?? `wassel-deck-${Date.now()}.pptx`).replace(
      /[^\w\-. ]/g,
      '_',
    );
    let buildFileId: string | null = buildResp.outputFileId;

    // ════════════════════════════════════════════════════════════════
    // PHASE 3 — REVIEW (optional, non-fatal on failure)
    // ════════════════════════════════════════════════════════════════
    if (env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID) {
      try {
        // Upload the built .pptx to Anthropic so the review call can
        // mount it in the sandbox.
        const builtFile = new File([finalBytes], finalFilename, { type: PPTX_MIME });
        const builtUpload = await (anthropic.beta.files as unknown as {
          upload: (a: Record<string, unknown>) => Promise<{ id: string; filename?: string }>;
        }).upload({ file: builtFile, betas: ANTHROPIC_BETAS });
        console.log(`[run][review] uploaded built pptx file_id=${builtUpload.id}`);

        const reviewUserBlocks: Array<Record<string, unknown>> = [
          {
            type: 'text',
            text:
              `The deck built in the previous step is mounted at /mnt/user-data/uploads/${finalFilename}.\n\n` +
              `Run the wassel-deck-review skill with fix=True and return the reviewed .pptx via the ${B64_MARKER_START} / ${B64_MARKER_END} base64 sentinel. Don't redesign — just apply the auto-patches.`,
          },
          {
            type: 'container_upload',
            file_id: builtUpload.id,
          },
        ];

        const reviewResp = await runAnthropicStream({
          anthropic,
          label: 'review',
          phaseDetailUi: 'reviewing & auto-patching…',
          updateRecord,
          streamParams: {
            model,
            max_tokens: 16_000,
            ...(model === 'claude-opus-4-7'
              ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
              : {}),
            betas: ANTHROPIC_BETAS,
            container: {
              skills: [
                {
                  type: 'custom',
                  skill_id: env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID,
                  version: 'latest',
                },
              ],
            },
            system: buildReviewSystemPrompt({ inputFilename: finalFilename }),
            messages: [{ role: 'user', content: reviewUserBlocks }],
            tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
          },
        });

        const reviewed = extractPptxFromContent(reviewResp.content);
        if (reviewed) {
          finalBytes = reviewed.bytes;
          finalFilename = (
            reviewed.filename ?? finalFilename.replace(/\.pptx$/i, '_reviewed.pptx')
          ).replace(/[^\w\-. ]/g, '_');
          if (reviewResp.outputFileId) buildFileId = reviewResp.outputFileId;
          console.log(
            `[run][review] reviewed bytes=${finalBytes.byteLength} filename=${finalFilename}`,
          );
        } else {
          console.warn(
            `[run][review] no reviewed bytes returned — shipping unreviewed build`,
          );
        }
      } catch (reviewErr) {
        // Review failures are NON-FATAL — we still have a perfectly good
        // unreviewed build. Log loudly and ship it.
        console.error(
          `[run][review] review phase failed (non-fatal — shipping unreviewed build): ${(reviewErr as Error).message}`,
        );
      }
    } else {
      console.log(`[run] review skill not configured; shipping unreviewed build`);
    }

    // ════════════════════════════════════════════════════════════════
    // Upload to Supabase + sign URL + write ready (unchanged from 1-call)
    // ════════════════════════════════════════════════════════════════
    await updateRecord({
      phase: 'uploading',
      phase_detail: `${(finalBytes.byteLength / 1024).toFixed(0)} KB`,
    });
    const path = `${job.userId}/${job.deckRecordId}/${finalFilename}`;

    const withTimeout = async <T>(label: string, ms: number, p: Promise<T>): Promise<T> => {
      return Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
        ),
      ]);
    };

    console.log(`[run] storage-upload-start path=${path}`);
    const uploadStartedAt = Date.now();
    const { error: uploadErr } = await withTimeout(
      'storage upload',
      60_000,
      supabase.storage.from(STORAGE_BUCKET).upload(path, finalBytes, {
        contentType: PPTX_MIME,
        upsert: true,
      }),
    );
    if (uploadErr) {
      console.error(`[run] storage-upload-FAIL path=${path} error=${uploadErr.message}`);
      throw new Error(`Storage upload failed: ${uploadErr.message}`);
    }
    console.log(`[run] storage-upload-OK path=${path} elapsed_ms=${Date.now() - uploadStartedAt}`);

    await updateRecord({ phase: 'finalizing' });

    console.log(`[run] sign-url-start`);
    const signStartedAt = Date.now();
    const { data: signed, error: signErr } = await withTimeout(
      'signed URL creation',
      15_000,
      supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS),
    );
    if (signErr || !signed) {
      console.error(`[run] sign-url-FAIL error=${signErr?.message ?? 'unknown'}`);
      throw new Error(`signed URL creation failed: ${signErr?.message ?? 'unknown'}`);
    }
    console.log(`[run] sign-url-OK elapsed_ms=${Date.now() - signStartedAt}`);

    console.log(`[run] record-save-ready-start`);
    const recordStartedAt = Date.now();
    await withTimeout(
      'record_save (ready)',
      15_000,
      updateRecord({
        status: 'ready',
        phase: null,
        phase_detail: null,
        file_url: signed.signedUrl,
        file_path: path,
        filename: finalFilename,
        anthropic_file_id: buildFileId,
        error_message: null,
      }),
    );
    console.log(
      `[run] record-save-ready-OK elapsed_ms=${Date.now() - recordStartedAt} record=${job.deckRecordId}`,
    );
    console.log(`[run] DONE record=${job.deckRecordId} filename=${finalFilename}`);
  } // end runGeneration()
} // end runDeckJob()

// ═══════════════════════════════════════════════════════════════════════
// Per-attachment helpers (kept outside runGeneration so they're easier to
// reason about; pass-through of the closures they need).
// ═══════════════════════════════════════════════════════════════════════

async function uploadAttachmentsToAnthropic(args: {
  anthropic: Anthropic;
  supabase: SupabaseClient;
  attachments: ReadonlyArray<DeckAttachmentRef>;
  updateRecord: (patch: Record<string, unknown>) => Promise<void>;
}): Promise<UploadedAttachment[]> {
  const { anthropic, supabase, attachments, updateRecord } = args;
  if (attachments.length === 0) return [];
  await updateRecord({
    phase: 'calling-claude',
    phase_detail: `uploading ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}…`,
  });
  const uploads = await Promise.all(
    attachments.map(async (att): Promise<UploadedAttachment> => {
      const { data: blob, error: dlErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(att.path);
      if (dlErr || !blob) {
        throw new Error(
          `Failed to read attachment "${att.name}" from storage: ${dlErr?.message ?? 'unknown'}`,
        );
      }
      const arrayBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      const mimeType = att.mimeType || (blob.type ?? 'application/octet-stream');
      // Wrap bytes in Uint8Array — Node's File constructor expects
      // BinaryLike; older @types/node releases don't accept raw
      // ArrayBuffer. Uint8Array is unambiguously accepted.
      const file = new File([bytes], att.name, { type: mimeType });
      const uploaded = await (anthropic.beta.files as unknown as {
        upload: (a: Record<string, unknown>) => Promise<{
          id: string;
          filename?: string;
          size_bytes?: number;
        }>;
      }).upload({ file, betas: ANTHROPIC_BETAS });
      return {
        fileId: uploaded.id,
        name: att.name,
        mimeType,
        sizeBytes: arrayBuf.byteLength,
        pdfBytes: mimeType === 'application/pdf' ? bytes : null,
      };
    }),
  );
  console.log(
    `[run] uploaded ${uploads.length} attachment(s) to Anthropic Files API: ${uploads.map((u) => u.fileId).join(', ')}`,
  );
  return uploads;
}

async function renderPdfPageImageBlocks(args: {
  anthropic: Anthropic;
  supabase: SupabaseClient;
  uploadedAttachments: UploadedAttachment[];
  job: DeckJob;
  updateRecord: (patch: Record<string, unknown>) => Promise<void>;
}): Promise<Array<Record<string, unknown>>> {
  const { anthropic, supabase, uploadedAttachments, job, updateRecord } = args;
  const blocks: Array<Record<string, unknown>> = [];
  const pdfAttachments = uploadedAttachments.filter((a) => a.pdfBytes !== null);
  if (pdfAttachments.length === 0) return blocks;
  await updateRecord({
    phase: 'calling-claude',
    phase_detail: `rendering PDF pages…`,
  });
  for (const pdf of pdfAttachments) {
    const startedAt = Date.now();
    try {
      const pages = await pdfToImages(pdf.pdfBytes!, {
        maxPages: MAX_PDF_PAGES_AS_IMAGES,
        oversampleStrategy: 'first',
      });
      // Upload each page-PNG to Anthropic Files API in parallel.
      // Inline base64 blew past the 32 MB HTTP body cap; Files API has a
      // 5 MB per-image cap that all our realistic pages fit under.
      const pageUploads = await Promise.all(
        pages.map(async (page) => {
          const file = new File([page.bytes], page.filename, { type: 'image/png' });
          const uploaded = await (anthropic.beta.files as unknown as {
            upload: (a: Record<string, unknown>) => Promise<{ id: string }>;
          }).upload({ file, betas: ANTHROPIC_BETAS });
          return uploaded.id;
        }),
      );
      for (const fileId of pageUploads) {
        blocks.push({ type: 'image', source: { type: 'file', file_id: fileId } });
      }
      console.log(
        `[run] rendered ${pages.length} page(s) from ${pdf.name} (${pdf.sizeBytes}B), ` +
          `uploaded as ${pageUploads.length} file(s) — total ${Date.now() - startedAt}ms`,
      );

      // Best-effort: store rendered pages in Supabase so the user can
      // verify what Claude actually saw. Failure logged, not fatal.
      const pdfBaseName = pdf.name.replace(/\.pdf$/i, '').replace(/[^\w\-. ]/g, '_');
      const pagesPathPrefix = `${job.userId}/${job.deckRecordId}/pdf-pages/${pdfBaseName}`;
      await Promise.all(
        pages.map(async (page) => {
          const path = `${pagesPathPrefix}/${page.filename}`;
          const { error } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(path, page.bytes, { contentType: 'image/png', upsert: true });
          if (error) {
            console.warn(
              `[run] pdf-page upload failed for ${path} (non-fatal): ${error.message}`,
            );
          }
        }),
      );
      console.log(`[run] saved ${pages.length} rendered page(s) to ${pagesPathPrefix}/`);
    } catch (err) {
      // Non-fatal — the PDF is still in the sandbox via container_upload
      // and Claude can still build from text extraction.
      console.error(
        `[run] pdfToImages failed for ${pdf.name} (non-fatal — sandbox still has the PDF): ${(err as Error).message}`,
      );
    } finally {
      // Free the captured bytes — not needed after rendering.
      pdf.pdfBytes = null;
    }
  }
  return blocks;
}

/**
 * Last-resort scan of recent Anthropic Files entries for a .pptx we lost
 * track of (the captured file_id was missing and the base64 sentinel
 * didn't fire). Used by the Build phase only; review never lands here
 * because review failures are non-fatal.
 */
async function scanFilesApiForRecentPptx(
  anthropic: Anthropic,
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  // Look back 1 hour to cover even the slowest deck runs.
  const sinceMs = Date.now() - 60 * 60 * 1000;
  const candidates: Array<{ id: string; filename: string; created_at: string }> = [];
  try {
    const listIter = (anthropic.beta.files as unknown as {
      list: (a: Record<string, unknown>) => AsyncIterable<{
        id: string;
        filename?: string;
        created_at?: string;
      }>;
    }).list({ limit: 30 });
    for await (const f of listIter) {
      const ts = f.created_at ? new Date(f.created_at).getTime() : 0;
      if (ts >= sinceMs && (f.filename ?? '').endsWith('.pptx')) {
        candidates.push({
          id: f.id,
          filename: f.filename ?? `deck-${Date.now()}.pptx`,
          created_at: f.created_at ?? '',
        });
      }
    }
    candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const top = candidates[0];
    if (!top) return null;
    console.log(`[run] fallback recovered file_id=${top.id} filename=${top.filename}`);
    const dl = await anthropic.beta.files.download(top.id);
    const buf = await dl.arrayBuffer();
    return { bytes: new Uint8Array(buf), filename: top.filename };
  } catch (e) {
    console.error('[run] Files API list fallback failed:', e);
    return null;
  }
}

/**
 * Build the user-facing error when Build finishes with no .pptx in any
 * channel. Includes Claude's final note + last bash result to make
 * troubleshooting from a screenshot possible.
 */
function buildNoFileIdError(content: unknown[]): Error {
  const lastText = content
    .filter((b) => (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .pop();
  let lastBash: { stdout?: string; stderr?: string; return_code?: number } | null = null;
  for (const b of content) {
    const bb = b as {
      type?: string;
      content?: { stdout?: string; stderr?: string; return_code?: number } | unknown;
    };
    if (
      bb.type === 'bash_code_execution_tool_result' &&
      bb.content &&
      typeof bb.content === 'object'
    ) {
      lastBash = bb.content as { stdout?: string; stderr?: string; return_code?: number };
    }
  }
  const lines: string[] = [
    `Build phase finished without surfacing a .pptx (no base64 sentinel, no captured file_id, no recent Files-API candidate).`,
    ``,
    `Claude's final note:`,
    lastText ?? '(empty)',
  ];
  if (lastBash) {
    lines.push(``, `Last bash result: rc=${lastBash.return_code ?? '?'}`);
    if (lastBash.stdout) lines.push(`stdout: ${lastBash.stdout.slice(0, 600)}`);
    if (lastBash.stderr) lines.push(`stderr: ${lastBash.stderr.slice(0, 600)}`);
  }
  lines.push(
    ``,
    `Try clicking "إعادة المحاولة" again — this is intermittent and usually works on the second or third try.`,
  );
  return new Error(lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════════
// Error humanization — extended for the 3-phase pipeline.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Translate raw worker error messages to human-readable text for the UI's
 * red error box. The user is expected to read this and decide what to do
 * (try a smaller file, shorten the brief, etc.). Always include the
 * original wording at the end so we can debug from a screenshot.
 */
function humanizeErrorMessage(raw: string): string {
  // 1) Anthropic returns a JSON-string error like:
  //    {"type":"error","error":{"type":"invalid_request_error",
  //     "message":"prompt is too long: 1021176 tokens > 1000000 maximum"}}
  let inner: { type?: string; message?: string } | null = null;
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed?.error && typeof parsed.error === 'object') {
        inner = parsed.error as { type?: string; message?: string };
      }
    } catch {
      // Not JSON — fall through.
    }
  }

  const lowerMsg = (inner?.message ?? raw).toLowerCase();

  // 2) prompt-too-long. With the 3-phase pipeline this is rarer (each
  //    phase has its own 1M budget) but still possible on extreme
  //    attachments.
  if (lowerMsg.includes('prompt is too long')) {
    const toksMatch = lowerMsg.match(/(\d+)\s*tokens?\s*>/);
    const overBy = toksMatch
      ? ` (${parseInt(toksMatch[1]!, 10).toLocaleString()} tokens, ~${Math.round((parseInt(toksMatch[1]!, 10) - 1_000_000) / 1000)}k over the 1M limit)`
      : '';
    return [
      `One phase of the deck pipeline exceeded Claude's context window${overBy}.`,
      ``,
      `The pipeline already splits the work across plan / build / review calls; if a single phase still overflows, the brief or an attachment is unusually large.`,
      ``,
      `Try one of:`,
      `  • Upload a shorter PDF (fewer pages, or a lower-resolution export).`,
      `  • Drop the PDF entirely and describe the brochure in the brief instead.`,
      `  • If you have multiple attachments, remove the largest one and try again.`,
      ``,
      `Original error: ${inner?.message ?? raw}`,
    ].join('\n');
  }

  // 3) Rate limit.
  if (
    lowerMsg.includes('rate_limit') ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('429')
  ) {
    return [
      `Anthropic rate-limited this request. Other decks are running in parallel.`,
      `Wait 30-60 seconds and click Try Again — it usually clears on the next attempt.`,
      ``,
      `Original error: ${inner?.message ?? raw}`,
    ].join('\n');
  }

  // 4) max_tokens — runGeneration's own message is already user-readable.
  if (lowerMsg.includes('ran out of output tokens')) {
    return raw;
  }

  // 5) Build phase no-output — already user-readable.
  if (raw.includes('Build phase finished without surfacing a .pptx')) {
    return raw;
  }

  // 6) Plan phase returned nothing usable.
  if (raw.includes('Plan phase returned no usable plan')) {
    return [
      `The planning phase didn't produce a usable design plan.`,
      ``,
      `This is usually intermittent — click Try Again. If it persists, try a more specific brief (mention the project type, audience, key data points).`,
      ``,
      `Original error: ${raw}`,
    ].join('\n');
  }

  // 7) Storage / signed URL — operational, surface verbatim.
  if (
    raw.startsWith('Storage upload failed') ||
    raw.startsWith('signed URL creation failed')
  ) {
    return [
      `Saving the generated deck to storage failed. This is a server-side issue, not your input.`,
      `Please try again in a minute; if it persists, ping admin.`,
      ``,
      `Original error: ${raw}`,
    ].join('\n');
  }

  // 8) Default.
  return `Deck generation failed: ${inner?.message ?? raw}`;
}
