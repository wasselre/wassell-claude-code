/**
 * Reference selector — turns the ranked `mkt_creative_references` rows (+ the
 * model's picks) into contract `ReferencePick`s.
 *
 * Guarantees (brief A-GEN):
 *  - Hallucination guard: any model-picked ref_id that is NOT among the
 *    candidate rows is dropped (with the reason recorded) — the model can
 *    only cite rows it was shown.
 *  - Org diversity: at most 2 references per organisation.
 *  - Carousels get ≥1 POST-level reference (the L2 whole-post design read);
 *    when the model picked only slide-level rows, the best post-level
 *    candidate is promoted in.
 *  - Preview URLs come from the ROWS, never from the model.
 *
 * Pure module — no I/O. Rows arrive pre-ranked from the RPC (score desc).
 */
import { normAr } from '../../marketing/script/entities.js';
import type {
  PostFormat,
  RefAspect,
  RefKind,
  RefLevel,
  ReferencePick,
} from '../contracts.js';

/** Row shape of RPC `mkt_creative_references` (contracts §2 `_22`). */
export interface CreativeReferenceRow {
  ref_kind: RefKind;
  ref_id: string;
  post_id: string | null;
  slide_index: number | null;
  level: RefLevel;
  preview_url: string | null;
  org_name: string | null;
  platform: string | null;
  published_at: string | null;
  post_url: string | null;
  score: number | null;
  /** Ranking rationale jsonb (purpose/district/unit matches…). */
  why: unknown;
  /** The visual design read when one exists — L1 SlideRead (level 'slide') or L2 PostRead (level 'post'). */
  read: unknown;
}

export interface ReferenceIntent {
  format: PostFormat;
}

/** The text fields the model authors per chosen reference (ids come from rows). */
export interface ModelReferencePick {
  ref_id: string;
  aspect: RefAspect;
  why: string;
  study: string;
  adapt: string;
  do_not_copy: string;
  differ: string;
}

export interface ReferenceSelection {
  references: ReferencePick[];
  /** Every pick/row that did NOT make the cut, with the machine reason. */
  dropped: Array<{ ref_id: string; reason: 'unknown_id' | 'org_diversity' | 'over_max' }>;
  warnings: string[];
}

const DEFAULT_MAX = 4;
const MAX_PER_ORG = 2;

/** Generic study text for deterministic (no-model-pick) selections. */
const FALLBACK_TEXT = {
  aspect: 'composition' as RefAspect,
  study: 'ادرس بنية هذا العمل وهرمية العناصر فيه، وطبّق الدروس على تصميمنا.',
  adapt: 'كيّف البنية مع حقائق مشروعنا وهوية وصل ونبرتها.',
  do_not_copy: 'لا تنسخ النص ولا الهوية ولا أرقام المنافس — الإلهام في البنية فقط.',
  differ: 'هوية وصل البصرية ونبرتها السعودية الدافئة وحقائق مشروعنا.',
};

function renderWhy(why: unknown): string {
  if (why === null || why === undefined) return '';
  if (typeof why === 'string') return why;
  if (Array.isArray(why)) return why.filter((x): x is string => typeof x === 'string').join('؛ ');
  try {
    return Object.entries(why as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('؛ ');
  } catch (err) {
    // Only reachable on a non-enumerable exotic object — keep the reason visible.
    console.error(`[director/references] could not render row.why (${err instanceof Error ? err.message : String(err)})`);
    return '';
  }
}

function orgKey(row: CreativeReferenceRow): string {
  return normAr(row.org_name ?? '').trim() || '(unknown)';
}

interface Working {
  row: CreativeReferenceRow;
  pick: ModelReferencePick;
  /** true when the model explicitly chose this row (vs deterministic fill). */
  authored: boolean;
}

/**
 * Select the final reference list.
 *
 * `opts.picks` — the model's chosen refs (id + authored text). Unknown ids are
 * dropped (hallucination guard). When absent, the top rows by score are used
 * with generic study text (the deterministic fallback path).
 */
export function selectReferences(
  rows: CreativeReferenceRow[],
  intent: ReferenceIntent,
  opts: { max?: number; picks?: ModelReferencePick[] } = {},
): ReferenceSelection {
  const max = opts.max ?? DEFAULT_MAX;
  const byId = new Map(rows.map((r) => [r.ref_id, r]));
  const dropped: ReferenceSelection['dropped'] = [];
  const warnings: string[] = [];

  // 1. Pair picks with rows (hallucination guard) — or take the ranked rows as-is.
  let working: Working[];
  if (opts.picks) {
    working = [];
    for (const pick of opts.picks) {
      const row = byId.get(pick.ref_id);
      if (!row) {
        dropped.push({ ref_id: pick.ref_id, reason: 'unknown_id' });
        continue;
      }
      working.push({ row, pick, authored: true });
    }
  } else {
    working = rows.map((row) => ({
      row,
      pick: {
        ref_id: row.ref_id,
        aspect: FALLBACK_TEXT.aspect,
        why: renderWhy(row.why) || 'منشور منافس عالي الصلة بالمشروع والجمهور.',
        study: FALLBACK_TEXT.study,
        adapt: FALLBACK_TEXT.adapt,
        do_not_copy: FALLBACK_TEXT.do_not_copy,
        differ: FALLBACK_TEXT.differ,
      },
      authored: false,
    }));
  }

  // 2. Org diversity — at most MAX_PER_ORG per organisation, first pick wins.
  const perOrg = new Map<string, number>();
  const diverse: Working[] = [];
  for (const w of working) {
    const key = orgKey(w.row);
    const n = perOrg.get(key) ?? 0;
    if (n >= MAX_PER_ORG) {
      dropped.push({ ref_id: w.row.ref_id, reason: 'org_diversity' });
      continue;
    }
    perOrg.set(key, n + 1);
    diverse.push(w);
  }

  // 3. Cap at max.
  const selected = diverse.slice(0, max);
  for (const w of diverse.slice(max)) dropped.push({ ref_id: w.row.ref_id, reason: 'over_max' });

  // 4. Carousels need ≥1 post-level read (the L2 whole-post structure).
  if (intent.format === 'carousel' && !selected.some((w) => w.row.level === 'post')) {
    const candidate = rows.find((r) => r.level === 'post' && !selected.some((w) => w.row.ref_id === r.ref_id));
    if (candidate) {
      const fill: Working = {
        row: candidate,
        pick: {
          ref_id: candidate.ref_id,
          aspect: 'carousel_structure',
          why: renderWhy(candidate.why) || 'قراءة كاروسيل كاملة (بنية الشرائح) عالية الصلة.',
          study: FALLBACK_TEXT.study,
          adapt: FALLBACK_TEXT.adapt,
          do_not_copy: FALLBACK_TEXT.do_not_copy,
          differ: FALLBACK_TEXT.differ,
        },
        authored: false,
      };
      if (selected.length >= max) {
        // Replace the LAST slide-level pick (never displace a post-level one).
        const lastSlideIdx = ((): number => {
          for (let i = selected.length - 1; i >= 0; i--) if (selected[i]!.row.level !== 'post') return i;
          return -1;
        })();
        if (lastSlideIdx >= 0) {
          dropped.push({ ref_id: selected[lastSlideIdx]!.row.ref_id, reason: 'over_max' });
          selected.splice(lastSlideIdx, 1, fill);
        } else {
          dropped.push({ ref_id: selected[selected.length - 1]!.row.ref_id, reason: 'over_max' });
          selected[selected.length - 1] = fill;
        }
      } else {
        selected.push(fill);
      }
    } else {
      warnings.push('no_post_level_reference: format is carousel but no post-level design read was available among the candidates');
    }
  }

  // 5. Map to contract ReferencePick — deterministic fields from the ROW, prose from the pick.
  const references: ReferencePick[] = selected.map(({ row, pick }) => ({
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    post_id: row.post_id,
    slide_index: row.slide_index,
    level: row.level,
    preview_url: row.preview_url,
    aspect: pick.aspect,
    why: pick.why,
    study: pick.study,
    adapt: pick.adapt,
    do_not_copy: pick.do_not_copy,
    differ: pick.differ,
  }));

  return { references, dropped, warnings };
}
