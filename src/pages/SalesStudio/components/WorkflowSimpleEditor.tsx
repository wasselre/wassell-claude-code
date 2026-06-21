import { useMemo, useState } from 'react';
import { X, MessageCircle, UserCog, Target, ShieldAlert, Info, PhoneCall, UserCheck, Bell, ArrowRight, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { WorkflowCard, BranchActionLine } from '@/lib/salesStudio';
import type { SalesWorkflowOverlay, SalesAssignmentStrategy } from '@/types';
import { ASSIGNMENT_STRATEGY_LABELS, pick } from '../lib/labels';

const STRATEGIES: SalesAssignmentStrategy[] = ['same_sales_rep', 'current_user', 'fixed_user', 'role_least_workload'];

function actionIcon(kind: BranchActionLine['kind']) {
  switch (kind) {
    case 'create_followup': return <PhoneCall size={13} />;
    case 'update_client': return <UserCheck size={13} />;
    case 'send_whatsapp': return <MessageCircle size={13} />;
    case 'notify': return <Bell size={13} />;
    case 'assign': return <UserCog size={13} />;
    default: return <ArrowRight size={13} />;
  }
}

/**
 * Safe, business-level editor organized as OUTCOME → ACTIONS. Each outcome is a
 * self-contained block: its actions, and each action's timing / assignment /
 * max-attempts / message inline — so a manager reads "if this outcome happens,
 * here's exactly what runs" instead of matching scattered fields. Edits the
 * draft version; NEVER triggers, target models, raw mappings, or JSON.
 */
export default function WorkflowSimpleEditor({
  card,
  editingActive,
  onClose,
  onSave,
}: {
  card: WorkflowCard;
  editingActive: boolean;
  onClose: () => void;
  onSave: (next: SalesWorkflowOverlay) => void;
}) {
  const { language, users } = useAppStore();
  const isAr = language === 'ar';

  const allTimings = useMemo(() => card.branches.flatMap((b) => b.timings), [card.branches]);
  const allMax = useMemo(() => card.branches.flatMap((b) => b.max_attempts), [card.branches]);
  const allMsgs = useMemo(() => card.branches.flatMap((b) => b.messages), [card.branches]);
  const allAssign = useMemo(() => card.branches.flatMap((b) => b.assignments), [card.branches]);

  const [objAr, setObjAr] = useState(card.objective_ar);
  const [objEn, setObjEn] = useState(card.objective_en);
  const [branches, setBranches] = useState(() =>
    Object.fromEntries(card.branches.map((b) => [b.branch_id, {
      enabled: b.enabled,
      label_ar: b.label_ar ?? '',
      label_en: b.label_en ?? '',
      primary_success: b.primary_success,
    }])),
  );
  const [timings, setTimings] = useState(() => Object.fromEntries(allTimings.map((t) => [t.action_id, t.current_value])));
  const [maxAttempts, setMaxAttempts] = useState(() => Object.fromEntries(allMax.map((m) => [m.action_id, m.current_value])));
  const [messages, setMessages] = useState(() => Object.fromEntries(allMsgs.map((m) => [m.action_id, { ar: m.current_ar, en: m.current_en }])));
  const [assignments, setAssignments] = useState(() =>
    Object.fromEntries(allAssign.map((a) => [a.action_id, {
      strategy: (STRATEGIES.includes(a.current_strategy as SalesAssignmentStrategy) ? a.current_strategy : 'same_sales_rep') as SalesAssignmentStrategy,
      fixed_user_id: a.current_fixed_user_id ?? null,
    }])),
  );

  const activeUsers = useMemo(() => users.filter((u) => u.is_active), [users]);

  const save = () => {
    const next: SalesWorkflowOverlay = {
      objective_ar: objAr.trim() || null,
      objective_en: objEn.trim() || null,
      branches: Object.fromEntries(Object.entries(branches).map(([id, b]) => [id, {
        enabled: b.enabled,
        label_ar: b.label_ar.trim() || null,
        label_en: b.label_en.trim() || null,
        primary_success: b.primary_success,
      }])),
      timings: Object.fromEntries(Object.entries(timings).filter(([, v]) => (v ?? '').trim()).map(([id, v]) => [id, v])),
      max_attempts: Object.fromEntries(Object.entries(maxAttempts).filter(([, v]) => typeof v === 'number').map(([id, v]) => [id, v as number])),
      messages: Object.fromEntries(Object.entries(messages).map(([id, m]) => [id, { ar: m.ar.trim() || null, en: m.en.trim() || null }])),
      assignments: Object.fromEntries(Object.entries(assignments).map(([id, a]) => [id, { strategy: a.strategy, fixed_user_id: a.strategy === 'fixed_user' ? a.fixed_user_id : null }])),
    };
    onSave(next);
  };

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
      <div className="flex-1 bg-chocolate/30 backdrop-blur-sm" onClick={onClose} />
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-2 border-b border-sand/50 p-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-chocolate">{isAr ? card.label_ar : card.label_en}</h3>
            <p className="text-xs text-charcoal/55">{isAr ? 'لكل نتيجة: ما الذي سينفّذه النظام' : 'Per outcome: what the system will run'}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream"><X size={18} /></button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {editingActive && (
            <div className="flex items-start gap-2 rounded-xl bg-copper/10 p-3 text-xs text-charcoal/80">
              <Info size={15} className="mt-0.5 shrink-0 text-copper" />
              <span>{isAr ? 'هذا الإصدار نشط — سيتم إنشاء مسودة وتطبيق تعديلاتك عليها دون المساس بالإصدار الحي.' : 'This version is active — a draft will be created and your edits applied there, leaving the live version untouched.'}</span>
            </div>
          )}

          {/* Objective (per-workflow) */}
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50">
              <Target size={14} className="text-copper" /> {isAr ? 'الهدف' : 'Objective'}
            </h4>
            <textarea value={objAr} onChange={(e) => setObjAr(e.target.value)} rows={2} dir="rtl" className="form-input w-full text-sm" placeholder={isAr ? 'الهدف بالعربية' : 'Goal (Arabic)'} />
            <textarea value={objEn} onChange={(e) => setObjEn(e.target.value)} rows={2} dir="ltr" className="form-input mt-2 w-full text-sm" placeholder="Goal (English)" />
          </section>

          {/* OUTCOME → ACTIONS blocks */}
          <section>
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-charcoal/50">{isAr ? 'النتائج والإجراءات' : 'Outcomes & actions'}</h4>
            <div className="space-y-3">
              {card.branches.map((b) => {
                const st = branches[b.branch_id]!;
                return (
                  <div key={b.branch_id} className={`rounded-xl border p-3 ${st.enabled ? 'border-sand/50' : 'border-sand/40 bg-cream/30'}`}>
                    {/* outcome header */}
                    <div className="flex items-center justify-between gap-2">
                      <span className={`min-w-0 flex-1 truncate text-xs font-bold text-chocolate ${st.enabled ? '' : 'line-through opacity-60'}`}>{pick(b.summary, isAr)}</span>
                      <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-charcoal/60">
                        <input type="checkbox" checked={st.enabled} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, enabled: e.target.checked } }))} />
                        {isAr ? 'مفعّل' : 'On'}
                      </label>
                    </div>
                    {b.condition_summary && <p className="mt-0.5 text-[10px] text-charcoal/45">{pick(b.condition_summary, isAr)}</p>}

                    {/* per-action inline settings */}
                    {b.action_lines.length === 0 ? (
                      <p className="mt-2 text-[11px] text-charcoal/40">{isAr ? 'لا إجراء — تنتهي المتابعة هنا.' : 'No action — the follow-up ends here.'}</p>
                    ) : (
                      <div className="mt-2 space-y-2.5">
                        {b.action_lines.map((line) => {
                          const timing = b.timings.find((t) => t.action_id === line.action_id);
                          const maxA = b.max_attempts.find((m) => m.action_id === line.action_id);
                          const assign = b.assignments.find((a) => a.action_id === line.action_id);
                          const msg = b.messages.find((m) => m.action_id === line.action_id);
                          return (
                            <div key={line.action_id} className="rounded-lg bg-cream/40 p-2">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-charcoal/80">
                                <span className="text-copper">{actionIcon(line.kind)}</span>
                                <span className="truncate">{pick(line.label, isAr)}{line.sets ? ` → ${pick(line.sets, isAr)}` : ''}</span>
                              </div>
                              <div className="mt-1.5 space-y-1.5 ps-5">
                                {timing && (
                                  <Field label={isAr ? 'الموعد' : 'Schedule'}>
                                    <input value={timings[line.action_id] ?? ''} onChange={(e) => setTimings((s) => ({ ...s, [line.action_id]: e.target.value }))} dir="ltr" className="form-input w-full !py-1.5 text-xs" placeholder={isAr ? 'مثال: +1d (فوري إن تُرك فارغًا)' : 'e.g. +1d (immediate if blank)'} />
                                  </Field>
                                )}
                                {assign && (
                                  <Field label={isAr ? 'الإسناد' : 'Assign to'}>
                                    <select value={assignments[line.action_id]?.strategy ?? 'same_sales_rep'} onChange={(e) => setAssignments((s) => ({ ...s, [line.action_id]: { ...s[line.action_id]!, strategy: e.target.value as SalesAssignmentStrategy } }))} className="form-input w-full !py-1.5 text-xs">
                                      {STRATEGIES.map((str) => <option key={str} value={str}>{pick(ASSIGNMENT_STRATEGY_LABELS[str], isAr)}</option>)}
                                    </select>
                                    {assignments[line.action_id]?.strategy === 'fixed_user' && (
                                      <select value={assignments[line.action_id]?.fixed_user_id ?? ''} onChange={(e) => setAssignments((s) => ({ ...s, [line.action_id]: { ...s[line.action_id]!, fixed_user_id: e.target.value || null } }))} className="form-input mt-1 w-full !py-1.5 text-xs">
                                        <option value="">{isAr ? 'اختر مستخدمًا' : 'Select user'}</option>
                                        {activeUsers.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>)}
                                      </select>
                                    )}
                                  </Field>
                                )}
                                {maxA && (
                                  <Field label={<><ShieldAlert size={10} className="me-1 inline" />{isAr ? 'حد المحاولات' : 'Max attempts'}</>}>
                                    <input type="number" min={0} value={maxAttempts[line.action_id] ?? ''} onChange={(e) => setMaxAttempts((s) => ({ ...s, [line.action_id]: e.target.value === '' ? null : Number(e.target.value) }))} dir="ltr" className="form-input w-28 !py-1.5 text-xs" placeholder={isAr ? 'بلا حد' : 'no cap'} />
                                  </Field>
                                )}
                                {msg && (
                                  <Field label={isAr ? 'الرسالة' : 'Message'}>
                                    <textarea value={messages[line.action_id]?.ar ?? ''} onChange={(e) => setMessages((s) => ({ ...s, [line.action_id]: { ...s[line.action_id]!, ar: e.target.value } }))} rows={2} dir="rtl" className="form-input w-full text-xs" placeholder={isAr ? 'الرسالة بالعربية' : 'Message (Arabic)'} />
                                    <textarea value={messages[line.action_id]?.en ?? ''} onChange={(e) => setMessages((s) => ({ ...s, [line.action_id]: { ...s[line.action_id]!, en: e.target.value } }))} rows={2} dir="ltr" className="form-input mt-1 w-full text-xs" placeholder="Message (English)" />
                                  </Field>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* outcome-level toggles */}
                    <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-sand/30 pt-2">
                      {!b.is_else && (
                        <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-charcoal/60">
                          <input type="checkbox" checked={st.primary_success} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, primary_success: e.target.checked } }))} />
                          <CheckCircle2 size={11} className="text-[#10B981]" /> {isAr ? 'النتيجة الرئيسية' : 'Primary success'}
                        </label>
                      )}
                      <div className="flex items-center gap-1.5">
                        <input value={st.label_en} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, label_en: e.target.value } }))} dir="ltr" className="form-input !w-28 !py-1 text-[11px]" placeholder={isAr ? 'تسمية (EN)' : 'Rename (EN)'} />
                        <input value={st.label_ar} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, label_ar: e.target.value } }))} dir="rtl" className="form-input !w-28 !py-1 text-[11px]" placeholder={isAr ? 'تسمية' : 'Rename'} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="rounded-xl bg-cream/70 p-3 text-[11px] leading-relaxed text-charcoal/55">
            {isAr
              ? 'للتغييرات المتقدمة (المحفّزات، النماذج، الشروط المعقّدة) استخدم «فتح في محرر سير العمل». استوديو المبيعات يحرّر القيم الآمنة فقط.'
              : 'For advanced changes (triggers, models, complex conditions) use “Open in Workflow Builder”. Sales Studio edits safe values only.'}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-sand/50 p-4">
          <button type="button" onClick={onClose} className="rounded-xl border border-sand px-4 py-2 text-sm font-semibold text-charcoal hover:bg-cream">{isAr ? 'إلغاء' : 'Cancel'}</button>
          <button type="button" onClick={save} className="rounded-xl bg-copper px-4 py-2 text-sm font-bold text-white hover:bg-terracotta">{isAr ? 'حفظ في المسودة' : 'Save to draft'}</button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/50">{label}</label>
      {children}
    </div>
  );
}
