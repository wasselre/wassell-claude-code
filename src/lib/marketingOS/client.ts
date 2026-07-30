/**
 * Typed SPA client for /api/marketing-os.
 *
 * Same two-file shape as every other bespoke module (see src/lib/financing/client.ts):
 * a thin `call<T>` transport plus one typed wrapper per action. Components never
 * touch `supabase` directly and never build a fetch by hand.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

/** The five working roles, plus the two the database can also return. */
export type MosRole =
  | 'administrator'
  | 'ceo'
  | 'marketing_manager'
  | 'ops_supervisor'
  | 'writer'
  | 'montage'
  | 'viewer'
  | 'none';

export interface MosContentType {
  id: string;
  key: string;
  label_ar: string;
  label_en: string;
  prefix: string;
  workflow_id: string | null;
  field_schema: string[];
  sort_order: number;
}

/**
 * A row of `mos_content_v`. `status_key` and `current_role` are DERIVED from the
 * open task by the view — they are not columns anyone can set, which is why the
 * list can never disagree with the task queue.
 */
export interface MosContentRow {
  id: string;
  ref: string | null;
  title: string;
  content_type_key: string;
  content_type_label_ar: string;
  content_type_label_en: string;
  project_id: string | null;
  campaign_id: string | null;
  purpose: 'organic' | 'paid' | 'both';
  status_key: string;
  current_step_label_ar: string | null;
  current_step_label_en: string | null;
  current_role: MosRole | null;
  current_assignee_user_id: string | null;
  current_task_due_at: string | null;
  current_round: number | null;
  due_at: string | null;
  target_publish_at: string | null;
  updated_at: string;
}

export interface MosTask {
  id: string;
  content_id: string;
  step_id: string | null;
  role: MosRole;
  assignee_user_id: string | null;
  status: 'open' | 'done' | 'skipped';
  result: 'submitted' | 'approved' | 'changes_requested' | null;
  note: string | null;
  round: number;
  opened_at: string;
  due_at: string | null;
  closed_at: string | null;
}

export interface MosStep {
  id: string;
  workflow_id: string;
  position: number;
  key: string;
  label_ar: string;
  label_en: string;
  role: MosRole;
  due_days: number;
  is_approval: boolean;
  approval_kind: 'creative' | 'process' | 'budget' | null;
}

export interface MosScene {
  id: string;
  content_id: string;
  position: number;
  start_sec: number | null;
  end_sec: number | null;
  visual: string | null;
  voiceover: string | null;
  on_screen_text: string | null;
  footage_status: 'have' | 'to_make' | 'missing';
  note: string | null;
}

/* ------------------------------------------------------------------ */
/* transport                                                          */
/* ------------------------------------------------------------------ */

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/marketing-os', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; error_ar?: string };
    const isAr = useAppStore.getState().language === 'ar';
    throw new Error(
      (isAr ? b?.error_ar || b?.error : b?.error) ?? `marketing-os ${action} failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* actions                                                            */
/* ------------------------------------------------------------------ */

export const fetchBootstrap = () =>
  call<{ role: MosRole; app_user_id: string | null; content_types: MosContentType[] }>('bootstrap');

export const fetchContentList = (filters: Record<string, unknown> = {}) =>
  call<{ content: MosContentRow[] }>('content_list', filters);

export const fetchContentDetail = (id: string) =>
  call<{ item: MosContentRow; tasks: MosTask[]; scenes: MosScene[]; steps: MosStep[] }>(
    'content_detail',
    { id },
  );

export const createContent = (payload: Record<string, unknown>) =>
  call<{ item: MosContentRow }>('content_create', payload);

export const updateContent = (id: string, patch: Record<string, unknown>) =>
  call<{ item: MosContentRow }>('content_update', { id, patch });

export const completeTask = (
  taskId: string,
  result: 'submitted' | 'approved' | 'changes_requested',
  note?: string,
) => call<{ item: MosContentRow }>('task_complete', { task_id: taskId, result, note });

/* ------------------------------------------------------------------ */
/* bilingual labels — one map, never inline strings in JSX            */
/* ------------------------------------------------------------------ */

export const ROLE_LABELS: Record<MosRole, { ar: string; en: string }> = {
  administrator:     { ar: 'مدير النظام',    en: 'Administrator' },
  ceo:               { ar: 'الرئيس التنفيذي', en: 'CEO' },
  marketing_manager: { ar: 'مدير التسويق',   en: 'Marketing Manager' },
  ops_supervisor:    { ar: 'مشرف العمليات',  en: 'Operations Supervisor' },
  writer:            { ar: 'الكاتب',          en: 'Writer' },
  montage:           { ar: 'المونتير',        en: 'Video Editor' },
  viewer:            { ar: 'مطّلع',           en: 'Viewer' },
  none:              { ar: 'بلا دور',         en: 'No role' },
};

export const PURPOSE_LABELS: Record<string, { ar: string; en: string }> = {
  organic: { ar: 'عضوي',   en: 'Organic' },
  paid:    { ar: 'مدفوع',  en: 'Paid' },
  both:    { ar: 'الاثنان', en: 'Both' },
};

/** Statuses the VIEW can synthesise when no workflow step is open. */
export const SYNTHETIC_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  draft:      { ar: 'مسودة',       en: 'Draft' },
  done:       { ar: 'منجز',        en: 'Done' },
  unassigned: { ar: 'بلا مرحلة',   en: 'Unassigned' },
};

/**
 * The stage label to show for a row. Prefers the workflow step's own label and
 * falls back to the synthetic status, so a brand-new item reads "مسودة" rather
 * than an empty cell.
 */
export function statusLabel(row: MosContentRow, isAr: boolean): string {
  const stepLabel = isAr ? row.current_step_label_ar : row.current_step_label_en;
  if (stepLabel) return stepLabel;
  const synthetic = SYNTHETIC_STATUS_LABELS[row.status_key];
  if (synthetic) return isAr ? synthetic.ar : synthetic.en;
  return row.status_key;
}

/** Overdue = has a due date, it has passed, and the item is still open. */
export function isOverdue(row: MosContentRow): boolean {
  const due = row.current_task_due_at ?? row.due_at;
  if (!due) return false;
  if (row.status_key === 'done') return false;
  return new Date(due).getTime() < Date.now();
}
