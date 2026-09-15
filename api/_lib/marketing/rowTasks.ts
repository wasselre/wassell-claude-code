/**
 * The ROW as something a screen can open, read and act on.
 *
 * A row is three posts, one task to work and one task to approve. Groups A–C
 * built the row into the data model and the engine; nothing yet could READ one
 * from a browser, because `mos_content_rows` carries RLS with zero policies and
 * `task_complete` hard-filtered `subject_table = 'mos_content'`.
 *
 * This module is the shaping half of `row_detail` / `row_order_save` /
 * `row_task_complete` in `api/marketing-os.ts` — everything that is pure
 * (labels, ordering, parsing a refusal) lives here so the endpoint keeps only
 * the queries and the authorization.
 *
 * The one piece of real logic here is `parseRequirementsMissing`. The engine
 * refuses an incomplete row with
 *
 *     MOS:REQUIREMENTS_MISSING P-151 — caption, P-152 — final_vertical
 *
 * and repeats the list as a JSON array in the error's DETAIL. That token is NOT
 * in `DB_MESSAGES`, so the generic translator turns the whole thing into «رفضت
 * قاعدة البيانات هذا التغيير» and the designer loses the ONE fact she needed:
 * which post, and which slot. Parsing it back into structure is what makes the
 * refusal fixable without the manager.
 */

/** One missing requirement, already named for a human. */
export interface MissingRequirement {
  /** The post it belongs to (`ref` / title), or null for a single-item subject. */
  member: string | null;
  /** The raw requirement key the engine named: a field key or an asset role. */
  key: string;
  label_ar: string;
  label_en: string;
}

/**
 * The requirement vocabulary the row path can refuse on. Kept here rather than
 * in the SPA so the server ships the words with the refusal and the two can
 * never disagree — the same posture the `DB_MESSAGES` table takes.
 *
 * `caption_confirmed` is not a field: `workflow_advance_role_path` adds it when
 * a step requires `caption` and the writer has not confirmed THAT EXACT text.
 */
const REQUIREMENT_LABELS: Record<string, { ar: string; en: string }> = {
  caption: { ar: 'النص', en: 'the caption' },
  caption_confirmed: { ar: 'تأكيد النص من الكاتب', en: 'the writer’s caption confirmation' },
  headlines: { ar: 'أسطر المنشور', en: 'the post lines' },
  design_brief: { ar: 'موجز التصميم', en: 'the design brief' },
  final_square: { ar: 'الملف المربّع ١:١', en: 'the square 1:1 file' },
  final_vertical: { ar: 'الملف العمودي ٩:١٦', en: 'the vertical 9:16 file' },
  final: { ar: 'الملف النهائي', en: 'the final file' },
  idea: { ar: 'الفكرة', en: 'the idea' },
  hook: { ar: 'الخطاف', en: 'the hook' },
  scenes: { ar: 'المشاهد', en: 'the scenes' },
};

export function requirementLabel(key: string): { ar: string; en: string } {
  return REQUIREMENT_LABELS[key] ?? { ar: key, en: key };
}

/** The separator `workflow_advance_role_path` puts between member and key. */
const MEMBER_SEP = ' — ';

/**
 * Turn a Postgres refusal into the list the designer can act on, or null when
 * the error is something else entirely.
 *
 * DETAIL is preferred: it is `to_jsonb(v_missing)::text`, so it survives any
 * punctuation inside a post's title. The message is the fallback, because a
 * PostgREST error does not always carry DETAIL through.
 */
export function parseRequirementsMissing(
  error: { message?: string | null; details?: string | null } | null,
): MissingRequirement[] | null {
  if (!error) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  if (!message.includes('MOS:REQUIREMENTS_MISSING')) return null;

  let entries: string[] = [];
  const detail = typeof error.details === 'string' ? error.details.trim() : '';
  if (detail.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (Array.isArray(parsed)) {
        entries = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch (e) {
      // A malformed DETAIL is not fatal — the message carries the same list.
      // Logged rather than swallowed so a shape change is visible in the logs.
      console.error('[marketing-os] REQUIREMENTS_MISSING detail was not JSON', detail, e);
    }
  }
  if (entries.length === 0) {
    const tail = message.split('MOS:REQUIREMENTS_MISSING')[1] ?? '';
    entries = tail.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }

  return entries.map((entry) => {
    const at = entry.indexOf(MEMBER_SEP);
    const member = at > 0 ? entry.slice(0, at).trim() : null;
    const key = (at > 0 ? entry.slice(at + MEMBER_SEP.length) : entry).trim();
    const label = requirementLabel(key);
    return { member, key, label_ar: label.ar, label_en: label.en };
  });
}

/** The sentence shown when the SPA has nothing better to render. */
export function requirementsMissingText(
  missing: MissingRequirement[],
): { ar: string; en: string } {
  const ar = missing
    .map((m) => (m.member ? `${m.member}: ${m.label_ar}` : m.label_ar))
    .join('، ');
  const en = missing
    .map((m) => (m.member ? `${m.member}: ${m.label_en}` : m.label_en))
    .join(', ');
  return {
    ar: `لا يمكن إرسال هذا الصف — ينقصه ${ar}.`,
    en: `This row cannot be sent — it is missing ${en}.`,
  };
}

/* ------------------------------------------------------------------ */
/* row shape                                                          */
/* ------------------------------------------------------------------ */

/** `mos_row_summary`'s output — the row's own facts. */
export interface RowFacts {
  row_id: string;
  kind: string;
  batch_day: string | null;
  row_key: string | null;
  campaign_id: string | null;
  project_id: string | null;
  plan_id: string | null;
  workflow_version_id: string | null;
  member_count: number;
  member_ids: string[];
}

/**
 * The writer's order, stable. `row_order` is the reading order; anything
 * without one sorts after, by creation, so a half-ordered row never shuffles
 * between two reads of the same data.
 */
export function sortMembers<T extends { id: string; row_order?: number | null; created_at?: string | null }>(
  members: T[],
  memberIds: string[],
): T[] {
  const rank = new Map(memberIds.map((id, i) => [id, i]));
  return [...members].sort((a, b) => {
    const ao = typeof a.row_order === 'number' ? a.row_order : null;
    const bo = typeof b.row_order === 'number' ? b.row_order : null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    const ar = rank.get(a.id);
    const br = rank.get(b.id);
    if (typeof ar === 'number' && typeof br === 'number' && ar !== br) return ar - br;
    return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  });
}

/**
 * Where the row stands in its own path, expressed as something a screen can
 * branch on without knowing any step key.
 *
 * `writing_review` is an approval with NO design step before it; `final` is an
 * approval that comes after one. That rule survives a workflow rename, which a
 * hardcoded `design_review` would not.
 */
export type RowFace = 'writing' | 'design' | 'writing_review' | 'final_approval' | 'other';

export interface FaceStep {
  key: string;
  role_key: string;
  is_approval: boolean;
  required_files: string[];
  required_fields: string[];
}

export function faceOfStep(steps: FaceStep[], stepKey: string | null): RowFace {
  if (!stepKey) return 'other';
  const idx = steps.findIndex((s) => s.key === stepKey);
  if (idx < 0) return 'other';
  const step = steps[idx];
  if (!step) return 'other';
  const designBefore = steps
    .slice(0, idx)
    .some((s) => !s.is_approval && s.required_files.length > 0);
  if (step.is_approval) return designBefore ? 'final_approval' : 'writing_review';
  // A making step that must deliver files IS the design step, whatever it is
  // called (`design` on post_std, `first_version` on video_std).
  if (step.required_files.length > 0) return 'design';
  if (step.required_fields.length > 0) return 'writing';
  return 'other';
}
