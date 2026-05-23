/**
 * runDeckJob — ported from api/generate-deck.ts.
 *
 * This is the long-running half of deck generation:
 *   1. Resolves the decks model id from Postgres (one round-trip)
 *   2. Stamps the deck record with the chosen model/language/size/attachments
 *      and status='generating' (so any browser already watching gets an
 *      instant "now generating" view via Realtime)
 *   3. Downloads each user-uploaded attachment from Supabase Storage and
 *      forwards it to the Anthropic Files API
 *   4. Calls Anthropic with the wassel-general-ppt skill (+ optionally
 *      wassel-deck-review) and the code_execution tool
 *   5. Extracts the .pptx bytes via the base64-stdout sentinel channel
 *      (primary) or Files API list scan (fallback)
 *   6. Uploads to the `wassel-decks` Supabase Storage bucket at
 *      `<user.id>/<record.id>/<filename>` and creates a 7-day signed URL
 *   7. Writes `status='ready'` + `file_url` + `file_path` + `filename`
 *      back to the deck record (Realtime fan-out → SPA download card)
 *
 * Errors bubble out to index.ts which marks the deck_jobs row failed
 * AND writes status='failed' / error_message to the deck record (also
 * via Realtime).
 *
 * Auth model: service-role Supabase client — bypasses RLS. We enforce
 * ownership by reading the deck record's `created_by_user_id` and
 * comparing against job.userId before any writes.
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

/** Vision-tier images get an additional `image` content block. */
const MAX_VISION_IMAGES = 3;
const VISION_IMAGE_BYTES_CAP = 5 * 1024 * 1024;
/** Max PDF page-images we render and pass as image content blocks. 20 pages
 * × ~1.5k tokens each ≈ 30k tokens of vision budget — predictable, fits
 * comfortably under the 1M context window with room for the brief,
 * skill, and Claude's response. We render the FIRST 20 pages of each PDF.
 * PDFs are always also `container_upload`'d so the full doc is in the
 * sandbox for Python (pypdf/pdfplumber) to read in detail. */
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
// payloads — stdout returns all bytes intact. See the original
// /api/generate-deck for the history.
const B64_MARKER_START = '===WASSEL_DECK_B64_START===';
const B64_MARKER_END = '===WASSEL_DECK_B64_END===';

/**
 * Same system prompt as the old Edge function. The skill's own SKILL.md
 * drives the design workflow — we keep this wrapper deliberately thin
 * (stacking a workflow prompt on top made Claude rush the design pass
 * in older runs).
 */
function buildSystemPrompt(args: {
  size: DeckSize;
  attachments: ReadonlyArray<{ name: string; mimeType: string }>;
  reviewEnabled: boolean;
}): string {
  const dims = SIZE_TO_INCHES[args.size];
  const sizeBlock = `Slide size: ${args.size} (${dims.width}" × ${dims.height}"). When initializing the python-pptx Presentation, set:
    prs.slide_width  = Inches(${dims.width})
    prs.slide_height = Inches(${dims.height})
Compose every layout for this aspect ratio — don't reuse 16:9 grids on a 9:16 deck.`;

  const attachmentsBlock =
    args.attachments.length === 0
      ? ''
      : `\n\nUser attachments are mounted at /mnt/user-data/uploads/ — inspect them BEFORE designing because the user expects you to use them:
${args.attachments.map((a) => `  • ${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}`).join('\n')}

Read the right tool per type:
  • .xlsx / .xls / .csv → pandas / openpyxl: extract the rows the user is referring to and turn them into slides (charts, tables, callouts)
  • .pdf                → pypdf or pdfplumber: pull headings + body. Some PDFs were also passed natively above — read them visually if so
  • .pptx               → python-pptx: read existing slides; copy structure / typography / brand if asked
  • .docx               → python-docx: read paragraphs as deck content
  • images              → PIL for dimensions; embed via slide.shapes.add_picture(path, ...). Some images were also passed visually above — use them for layout decisions`;

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

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: DeckJob;
}

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
  // (worker is the sole writer during a generation, version-conflict
  // doesn't apply). Preserves created_by_user_id (never overwrites with
  // service-role NULL — that would break the FK to public.users).
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

  // Stamp initial state. `phase` is the new field the SPA reads to
  // render the GeneratingView's progress dots (replaces SSE).
  await updateRecord({
    status: 'generating',
    phase: 'calling-claude',
    phase_detail: model,
    model_used: model,
    language,
    size,
    attachments,
    error_message: null,
  });

  // From here on, any thrown error MUST also write status='failed' to
  // the deck record so the UI's spinner exits via Realtime. The catch
  // in index.ts marks the deck_jobs row failed but doesn't touch the
  // deck record — that's our job. Bubble the original error after the
  // record write so the job row also reflects the same message.
  try {
    await runGeneration();
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // The UI shows error_message verbatim in a red box. Raw Anthropic JSON
    // errors look terrible there — translate the known cases to plain
    // English the user can act on. Always preserve the original message
    // in the logs (and append it to the friendly text in parens) so we
    // can still debug.
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

  // ── End of runDeckJob top-level ─────────────────────────────────────
  // Body moved into runGeneration() below so the try/catch above can
  // wrap all the heavy work without sprawling indent.

  async function runGeneration(): Promise<void> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // ── Upload attachments to Anthropic Files API ───────────────────────
  // We capture the raw bytes for PDFs so we can render them to per-page
  // PNGs after the upload loop without re-downloading from Supabase.
  interface UploadedAttachment {
    fileId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    /** Captured ONLY for PDFs — used by the page-rendering step below. */
    pdfBytes: Uint8Array | null;
  }
  const uploadedAttachments: UploadedAttachment[] = [];

  if (attachments.length > 0) {
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
        // Wrap in Uint8Array — Node's File constructor (node:buffer) expects
        // BinaryLike, which doesn't include raw ArrayBuffer in older
        // @types/node releases. Uint8Array is unambiguously accepted.
        const file = new File([bytes], att.name, { type: mimeType });
        const uploaded = await (anthropic.beta.files as unknown as {
          upload: (args: Record<string, unknown>) => Promise<{
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
    uploadedAttachments.push(...uploads);
    console.log(
      `[run] uploaded ${uploads.length} attachment(s) to Anthropic Files API: ${uploads.map((u) => u.fileId).join(', ')}`,
    );
  }

  // ── Render PDF pages to inline images ───────────────────────────────
  // PDF document content blocks tokenize unpredictably with image-heavy
  // PDFs — a 6.5 MB real estate brochure hit the 1M token ceiling on
  // 2026-05-18 (record bdf9b0ed). Per-page image blocks have predictable
  // ~1.5k tokens each, and the original PDF stays available in the
  // sandbox via container_upload so Python can still read the full doc.
  // Loose type — userContentBlocks is `Record<string, unknown>` and TS
  // can't see structural compatibility on heterogeneous arrays without it.
  const pdfPageImageBlocks: Array<Record<string, unknown>> = [];
  const pdfAttachments = uploadedAttachments.filter((a) => a.pdfBytes !== null);
  if (pdfAttachments.length > 0) {
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
        for (const page of pages) {
          pdfPageImageBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              // Buffer.from(Uint8Array) zero-copies; toString('base64') is fast.
              data: Buffer.from(page.bytes).toString('base64'),
            },
          });
        }
        console.log(
          `[run] rendered ${pages.length} page(s) from ${pdf.name} (${pdf.sizeBytes}B) ` +
          `in ${Date.now() - startedAt}ms`,
        );
      } catch (err) {
        // Non-fatal — the PDF is still in the sandbox via container_upload,
        // and Claude can still build something from text extraction even
        // without the visual pages. Log loudly and continue.
        console.error(
          `[run] pdfToImages failed for ${pdf.name} (non-fatal — sandbox still has the PDF): ${(err as Error).message}`,
        );
      } finally {
        // Free the captured bytes — we don't need them after rendering.
        pdf.pdfBytes = null;
      }
    }
  }

  // ── Build user message ──────────────────────────────────────────────
  const visionImages = uploadedAttachments
    .filter((a) => a.mimeType.startsWith('image/') && a.sizeBytes <= VISION_IMAGE_BYTES_CAP)
    .slice(0, MAX_VISION_IMAGES);

  const userContentBlocks: Array<Record<string, unknown>> = [
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
          : ''),
    },
    ...uploadedAttachments.map((a) => ({
      type: 'container_upload',
      file_id: a.fileId,
    })),
    ...visionImages.map((a) => ({
      type: 'image',
      source: { type: 'file', file_id: a.fileId },
    })),
    ...pdfPageImageBlocks,
  ];

  // ── Call Anthropic (streaming) ──────────────────────────────────────
  const turn = (anthropic.beta.messages as unknown as {
    stream: (args: Record<string, unknown>) => {
      [Symbol.asyncIterator]: () => AsyncIterator<{ type: string; [k: string]: unknown }>;
      finalMessage: () => Promise<{ content: unknown[] }>;
    };
  }).stream({
    model,
    max_tokens: 32000,
    ...(model === 'claude-opus-4-7'
      ? {
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
        }
      : {}),
    betas: ANTHROPIC_BETAS,
    container: {
      skills: [
        { type: 'custom', skill_id: env.ANTHROPIC_WASSEL_SKILL_ID, version: 'latest' },
        ...(env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID
          ? [{ type: 'custom', skill_id: env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID, version: 'latest' }]
          : []),
      ],
    },
    system: buildSystemPrompt({
      size,
      attachments: uploadedAttachments.map((u) => ({ name: u.name, mimeType: u.mimeType })),
      reviewEnabled: env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID !== null,
    }),
    messages: [{ role: 'user', content: userContentBlocks }],
    tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
  });
  console.log(
    `[run] stream-created model=${model} content_blocks=${userContentBlocks.length} attachments=${uploadedAttachments.length}`,
  );

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

  const requestStartedAtMs = Date.now() - 5000;
  let eventCount = 0;
  let lastEventType: string | null = null;
  const iterStartedAtMs = Date.now();
  // Throttle phase_detail writes — every content_block_start emits one,
  // but we don't want to hammer the records table. Update at most every
  // 2 seconds.
  let lastPhaseWriteAt = 0;
  const tryWritePhaseDetail = async (detail: string) => {
    const now = Date.now();
    if (now - lastPhaseWriteAt < 2000) return;
    lastPhaseWriteAt = now;
    try {
      await updateRecord({ phase: 'calling-claude', phase_detail: detail });
    } catch (err) {
      console.warn(
        `[run] phase_detail update failed (non-fatal): ${(err as Error).message}`,
      );
    }
  };

  // Heartbeat — keep the deck record's updated_at fresh even when no
  // new tool-start event has fired in a while. Without this, Claude
  // sitting inside one long `text_editor_code_execution` tool call for
  // 5+ min (which happens routinely with the newer combined editor)
  // makes the client-side stuck-detector fire a false alarm. We don't
  // change `phase_detail` here so the UI text stays correct; just bump
  // updated_at via a no-op patch.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeat = setInterval(() => {
    void updateRecord({}).catch((err) => {
      console.warn(`[run] heartbeat update failed (non-fatal): ${(err as Error).message}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    for await (const event of turn) {
      eventCount++;
      lastEventType = event.type;
      if (eventCount === 1) {
        console.log(
          `[run] stream-first-event type=${event.type} elapsed_ms=${Date.now() - iterStartedAtMs}`,
        );
      }
      if (eventCount % 50 === 0) {
        console.log(
          `[run] stream-progress events=${eventCount} last_type=${event.type} elapsed_ms=${Date.now() - iterStartedAtMs}`,
        );
      }
      captureFileId(event);
      if (event.type === 'content_block_start') {
        const cb = (event as unknown as { content_block?: { type?: string; name?: string } })
          .content_block;
        const cbType = cb?.type ?? 'unknown';
        console.log(`[run] content_block_start type=${cbType} name=${cb?.name ?? 'n/a'}`);
        if (cbType === 'server_tool_use') {
          await tryWritePhaseDetail(`tool: ${cb?.name ?? 'unknown'}`);
        }
      }
      if (event.type === 'message_stop' || event.type === 'error') {
        console.log(`[run] stream-terminal type=${event.type}`);
      }
    }
    console.log(
      `[run] stream-iter-done events=${eventCount} last_type=${lastEventType ?? 'none'} elapsed_ms=${Date.now() - iterStartedAtMs}`,
    );
  } catch (streamErr) {
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    console.error(
      `[run] stream-iter-FAIL events=${eventCount} last_type=${lastEventType ?? 'none'} elapsed_ms=${Date.now() - iterStartedAtMs} error=${msg}`,
    );
    throw streamErr;
  } finally {
    // The for-await above is where the worker blocks the longest (often
    // 3-10 min) — that's where the heartbeat earns its keep. After this
    // point the remaining steps (finalMessage, byte extraction, storage
    // upload, sign URL, record save) are all fast (~10-60s combined),
    // so it's safe to drop the heartbeat here. Doing this in `finally`
    // guarantees we never leak an interval, even on early throws inside
    // the loop.
    clearInterval(heartbeat);
  }

  console.log(`[run] final-message-start`);
  const finalStartedAtMs = Date.now();
  const response = await turn.finalMessage();
  console.log(
    `[run] final-message-OK elapsed_ms=${Date.now() - finalStartedAtMs} blocks=${response.content.length}`,
  );
  captureFileId(response.content);

  // ── Extract bytes from bash stdout base64 sentinel channel ──────────
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
        console.log(`[run] extracted ${out.byteLength} bytes from bash stdout via base64 markers`);
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
        const m = stdout.match(/wassel-deck-\d+(?!_reviewed)\.pptx/);
        if (m) rawName = m[0];
      }
      if (reviewedName) break;
    }
    extractedFilename = reviewedName ?? rawName;
  }

  // ── Files API fallback ──────────────────────────────────────────────
  if (!outputFileId && !extractedBytes) {
    console.log('[run] no file_id in response, scanning Files API');
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
          console.log(`[run] fallback retry ${attempt + 1}/3 after 2s`);
          await new Promise((r) => setTimeout(r, 2000));
        }
        const candidates = await scanFilesApi();
        console.log(`[run] fallback attempt ${attempt + 1}: ${candidates.length} candidates`);
        if (candidates.length > 0 && candidates[0]) {
          outputFileId = candidates[0].id;
          console.log(
            `[run] fallback recovered file_id=${outputFileId} filename=${candidates[0].filename}`,
          );
          break;
        }
      }
    } catch (listErr) {
      console.error('[run] Files API list fallback failed:', listErr);
    }
  }

  if (!outputFileId && !extractedBytes) {
    const stopReason = (response as unknown as { stop_reason?: string }).stop_reason;
    const lastText = response.content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .pop();
    let lastBash: { stdout?: string; stderr?: string; return_code?: number } | null = null;
    for (const b of response.content) {
      const bb = b as {
        type?: string;
        content?: { stdout?: string; stderr?: string; return_code?: number } | unknown;
      };
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

  // ── Source the bytes ────────────────────────────────────────────────
  let bytes: Uint8Array;
  let filename: string;
  if (extractedBytes) {
    bytes = extractedBytes;
    filename = (extractedFilename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
    console.log(`[run] source-bytes route=base64 size=${bytes.byteLength}B filename=${filename}`);
    await updateRecord({
      phase: 'uploading',
      phase_detail: `${(bytes.byteLength / 1024).toFixed(0)} KB (via base64 stream)`,
    });
  } else if (outputFileId) {
    await updateRecord({ phase: 'downloading' });
    console.log(`[run] files-api-download file_id=${outputFileId}`);
    const meta = await anthropic.beta.files.retrieveMetadata(outputFileId);
    const dlResponse = await anthropic.beta.files.download(outputFileId);
    const arrayBuffer = await dlResponse.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
    filename = (meta.filename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
    console.log(`[run] source-bytes route=files-api size=${bytes.byteLength}B filename=${filename}`);
    await updateRecord({
      phase: 'uploading',
      phase_detail: `${(bytes.byteLength / 1024).toFixed(0)} KB`,
    });
  } else {
    throw new Error('internal: reached upload branch without bytes or file_id');
  }
  const path = `${job.userId}/${job.deckRecordId}/${filename}`;

  // ── Upload to Supabase Storage ──────────────────────────────────────
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
    supabase.storage.from(STORAGE_BUCKET).upload(path, bytes, {
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

  // ── Write ready state ───────────────────────────────────────────────
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
      filename,
      anthropic_file_id: outputFileId,
      error_message: null,
    }),
  );
  console.log(
    `[run] record-save-ready-OK elapsed_ms=${Date.now() - recordStartedAt} record=${job.deckRecordId}`,
  );
  console.log(`[run] DONE record=${job.deckRecordId} filename=${filename}`);
  } // end runGeneration()
} // end runDeckJob()

/**
 * Translate raw worker error messages to human-readable text for the UI's
 * red error box. The user is expected to read this and decide what to do
 * (try a smaller file, shorten the brief, etc.) — raw Anthropic JSON
 * blobs are useless for that. Always include the original wording at the
 * end so we can debug from a screenshot.
 */
function humanizeErrorMessage(raw: string): string {
  // 1) Anthropic returns a JSON-string error like:
  //    {"type":"error","error":{"type":"invalid_request_error",
  //     "message":"prompt is too long: 1021176 tokens > 1000000 maximum"}}
  // Try to parse out the inner message + type.
  let inner: { type?: string; message?: string } | null = null;
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed?.error && typeof parsed.error === 'object') {
        inner = parsed.error as { type?: string; message?: string };
      }
    } catch {
      // Not JSON — fall through to string matching below.
    }
  }

  const lowerMsg = (inner?.message ?? raw).toLowerCase();

  // 2) Specific case: prompt-too-long (the 1M-token context limit). Almost
  //    always caused by a large image-heavy PDF or a deck brief with too
  //    many huge attachments.
  if (lowerMsg.includes('prompt is too long')) {
    const toksMatch = lowerMsg.match(/(\d+)\s*tokens?\s*>/);
    const overBy = toksMatch
      ? ` (${parseInt(toksMatch[1]!, 10).toLocaleString()} tokens, ~${Math.round((parseInt(toksMatch[1]!, 10) - 1_000_000) / 1000)}k over the 1M limit)`
      : '';
    return [
      `Your attachments are too large to fit in Claude's context window${overBy}.`,
      ``,
      `Try one of:`,
      `  • Upload a shorter PDF (fewer pages, or a lower-resolution export).`,
      `  • Drop the PDF entirely and describe the brochure in the brief instead.`,
      `  • If you have multiple attachments, remove the largest one and try again.`,
      ``,
      `Note: PDF page-images are capped at 20 pages — beyond that, additional pages aren't sent to Claude visually (the PDF is still in the sandbox for text extraction).`,
      ``,
      `Original error: ${inner?.message ?? raw}`,
    ].join('\n');
  }

  // 3) Specific case: rate limit.
  if (lowerMsg.includes('rate_limit') || lowerMsg.includes('rate limit') || lowerMsg.includes('429')) {
    return [
      `Anthropic rate-limited this request. Other decks are running in parallel.`,
      `Wait 30-60 seconds and click Try Again — it usually clears on the next attempt.`,
      ``,
      `Original error: ${inner?.message ?? raw}`,
    ].join('\n');
  }

  // 4) Specific case: max_tokens. Claude ran out of output tokens before
  //    finishing the .pptx. Already has a friendly message at the throw
  //    site — pass through.
  if (lowerMsg.includes('ran out of output tokens')) {
    return raw;
  }

  // 5) Specific case: no file_id surfaced (the original message from
  //    runGeneration includes its own user-readable guidance). Pass through.
  if (raw.includes('Claude finished without surfacing a file_id')) {
    return raw;
  }

  // 6) Specific case: Storage upload / signed URL failures — operational,
  //    not user-actionable. Surface verbatim so admin can debug.
  if (raw.startsWith('Storage upload failed') || raw.startsWith('signed URL creation failed')) {
    return [
      `Saving the generated deck to storage failed. This is a server-side issue, not your input.`,
      `Please try again in a minute; if it persists, ping admin.`,
      ``,
      `Original error: ${raw}`,
    ].join('\n');
  }

  // 7) Default: prepend a one-liner and include the raw error so the user
  //    at least sees the original Anthropic/Supabase/etc. text for
  //    troubleshooting.
  return `Deck generation failed: ${inner?.message ?? raw}`;
}
