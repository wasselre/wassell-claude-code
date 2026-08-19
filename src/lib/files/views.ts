/**
 * Phase 3 · B5 — saved views.
 *
 * Two kinds, and the difference matters:
 *
 *   SYSTEM views  — the six the spec ships on day one. Code constants, right
 *                   here. Every user has them, they are bilingual, they cannot
 *                   be edited or deleted, and they cannot fail to load.
 *   SAVED views   — rows in `file_views`, written by a person. Private by
 *                   default; a shared one is visible to everyone and editable
 *                   only by its author.
 *
 * ── WHY THE SIX ARE NOT ROWS ──────────────────────────────────────────────
 * The long version is in the migration header. The short version: two of them
 * are not constant. "My files" filters on the CALLER, so a row would need a
 * placeholder the client rewrites — at which point the row is not the
 * definition, the client is. And a row is a thing that can fail to load; the
 * Library's own navigation must not depend on a fetch that can come back empty.
 *
 * A view has NO membership — it is a stored query, evaluated live through
 * `business_files_search` under the caller's own RLS. So it can never drift,
 * and two people opening the same shared view correctly see different counts.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { errorText } from './library';
import type {
  BusinessFileSort,
  FileViewRow,
  LibraryFilters,
  LibraryGrouping,
  LibraryLayout,
} from '@/types';

/** The shape both kinds resolve to, so the rail and the page treat them alike. */
export interface LibraryViewState {
  q: string;
  filters: LibraryFilters;
  grouping: LibraryGrouping;
  sort: BusinessFileSort;
  layout: LibraryLayout;
}

export interface SystemView {
  /** Stable across releases — it goes in the URL. */
  key: string;
  label_ar: string;
  label_en: string;
  /** One line of "what am I looking at", shown under the header band. */
  hint_ar: string;
  hint_en: string;
  /** Lucide icon name, resolved by the rail. */
  icon: 'unlink' | 'clock' | 'user' | 'folder' | 'megaphone' | 'alarm';
  /**
   * `me` is the caller's `public.users.id`, or null when the session has not
   * bound one yet. A view that NEEDS it (My files) says so via `requiresUser`
   * rather than silently resolving to "everyone's files", which is a different
   * and much more surprising answer.
   */
  build: (me: string | null) => LibraryViewState;
  requiresUser?: boolean;
}

const BASE: LibraryViewState = {
  q: '',
  filters: {},
  grouping: 'none',
  sort: 'created_desc',
  layout: 'grid',
};

/** 30 days back from now, as an ISO instant. Computed at call time, not at
 *  module load — a tab left open overnight must not keep yesterday's window. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

export const SYSTEM_VIEWS: SystemView[] = [
  {
    key: 'unlinked',
    label_ar: 'ملفات غير مرتبطة',
    label_en: 'Unlinked files',
    hint_ar: 'ملفات لا يستخدمها أي سجل — يمكن ربطها أو أرشفتها',
    hint_en: 'Files no record uses — link them or archive them',
    icon: 'unlink',
    // The spec is explicit that this is a view and a counter, not a gate:
    // "Unlinked is a saved view, not an error." Requiring a link at upload
    // time would push people straight back to WhatsApp and email.
    build: () => ({ ...BASE, filters: { unlinked: true } }),
  },
  {
    key: 'recent',
    label_ar: 'أُضيف حديثاً',
    label_en: 'Recently added',
    hint_ar: 'آخر ٣٠ يوماً',
    hint_en: 'The last 30 days',
    icon: 'clock',
    build: () => ({ ...BASE, filters: { created_from: daysAgo(30) } }),
  },
  {
    key: 'mine',
    label_ar: 'ملفاتي',
    label_en: 'My files',
    hint_ar: 'الملفات التي أنا المسؤول عنها',
    hint_en: 'Files you are accountable for',
    icon: 'user',
    requiresUser: true,
    // `owner_user_id`, not `uploaded_by_user_id`: ownership is transferable and
    // the uploader is immutable history. One person uploaded 80% of this
    // library; "my files" has to mean something after they hand a document over.
    build: (me) => ({ ...BASE, filters: me ? { owner_user_id: [me] } : {} }),
  },
  {
    key: 'project_pack',
    label_ar: 'حزمة مشروع',
    label_en: 'Project pack',
    hint_ar: 'كل ملفات المشاريع مجمّعة حسب نوع المستند — اختر مشروعاً لتضييق النتائج',
    hint_en: 'Everything attached to projects, grouped by document type — pick a project to narrow it',
    icon: 'folder',
    // The spec calls this "one project, grouped by document type" — the direct
    // replacement for the المشاريع folder tree. It opens as ALL projects and
    // the filter bar's project picker narrows it to one, because a view cannot
    // hard-code which project you meant.
    build: () => ({ ...BASE, filters: { linked_model: 'all_projects' }, grouping: 'document_type' }),
  },
  {
    key: 'marketing',
    label_ar: 'مكتبة التسويق',
    label_en: 'Marketing library',
    hint_ar: 'المواد التي دخلت عبر مساحة التسويق',
    hint_en: 'Assets that arrived through the Marketing workspace',
    icon: 'megaphone',
    build: () => ({ ...BASE, filters: { origin: ['marketing_intake'] } }),
  },
  {
    key: 'expiring',
    // Named for what it ACTUALLY returns. The spec asked for "valid_until
    // within 30 days", and `business_files_search` cannot express that: its
    // date bounds are on `created_at`, and its one validity filter — `expired`
    // — means ALREADY expired. Rather than label a view with a window it does
    // not apply, this is called "Expired" in both languages and the 30-day
    // version waits for a `valid_until_before` filter, which is a B2 change,
    // not a B5 one. Production currently has ZERO files with any `valid_until`,
    // so the two only diverge once somebody dates a contract.
    label_ar: 'انتهت صلاحيتها',
    label_en: 'Expired',
    hint_ar: 'ملفات تجاوزت تاريخ نهاية صلاحيتها',
    hint_en: 'Files past their valid-until date',
    icon: 'alarm',
    build: () => ({ ...BASE, filters: { expired: true } }),
  },
];

export function systemView(key: string): SystemView | undefined {
  return SYSTEM_VIEWS.find((v) => v.key === key);
}

// ─── file_views (user-saved) ──────────────────────────────────────────────

function surfaceViewError(scope: string, err: unknown): Error {
  // errorText, not String(err) — supabase-js hands back a plain PostgrestError
  // object and String() would render it as "[object Object]". See library.ts.
  const msg = errorText(err);
  console.error(`[library] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — console.error above is still loud and the caller still throws.
  }
  return new Error(msg);
}

/**
 * Every view the caller may open: their own plus everyone's shared ones.
 * RLS decides which; this does not filter client-side.
 *
 * Throws on failure so the rail can say "saved views could not be loaded"
 * instead of quietly showing only the six system views, which would look
 * identical to "you have not saved any".
 */
export async function listFileViews(): Promise<FileViewRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file_views')
    .select('*')
    .order('pinned', { ascending: false })
    .order('sort_order')
    .order('created_at');
  if (error) throw surfaceViewError('load saved views', error);
  return (data ?? []) as FileViewRow[];
}

export interface SaveViewInput extends LibraryViewState {
  name: string;
  visibility: 'private' | 'shared';
  pinned?: boolean;
}

/**
 * Save-or-update by NAME, in one call.
 *
 * The name is the identity from the user's point of view: pressing Save on a
 * name they already used means "update that one". Read-then-write on the
 * client would be a race, and would surface a unique-violation for what is a
 * perfectly ordinary action.
 */
export async function saveFileView(input: SaveViewInput): Promise<FileViewRow> {
  if (!supabase) throw surfaceViewError('save view', new Error('Supabase is not configured'));
  const { data, error } = await supabase.rpc('file_views_save', {
    p_name: input.name,
    p_filters: input.filters,
    p_q: input.q || null,
    p_grouping: input.grouping,
    p_sort: input.sort,
    p_layout: input.layout,
    p_visibility: input.visibility,
    p_pinned: input.pinned ?? false,
  });
  if (error) throw surfaceViewError('save view', error);
  return data as FileViewRow;
}

/**
 * Delete a saved view.
 *
 * RLS allows only the owner, and a refused delete comes back as 200 with zero
 * rows — same silent shape as a refused update. So the deleted row is
 * requested back and its absence is an error, not a shrug.
 */
export async function deleteFileView(viewId: string): Promise<void> {
  if (!supabase) throw surfaceViewError('delete view', new Error('Supabase is not configured'));
  const { data, error } = await supabase.from('file_views').delete().eq('id', viewId).select('id');
  if (error) throw surfaceViewError('delete view', error);
  if (((data ?? []) as unknown[]).length === 0) {
    throw surfaceViewError('delete view', new Error('nothing was deleted — only the view’s author may remove it'));
  }
}

/** A stored row, in the shape the page drives from. */
export function viewStateFromRow(row: FileViewRow): LibraryViewState {
  return {
    q: row.q ?? '',
    filters: row.filters ?? {},
    grouping: row.grouping,
    sort: row.sort,
    layout: row.layout,
  };
}
