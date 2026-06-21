import { useMemo, useState } from 'react';
import { X, Clock, MessageCircle, UserCog, GitBranch, Target, ShieldAlert, Info } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { WorkflowCard } from '@/lib/salesStudio';
import type { SalesWorkflowOverlay, SalesAssignmentStrategy } from '@/types';
import { ASSIGNMENT_STRATEGY_LABELS, pick } from '../lib/labels';

const STRATEGIES: SalesAssignmentStrategy[] = ['same_sales_rep', 'current_user', 'fixed_user', 'role_least_workload'];

/**
 * Safe, business-level editor for ONE workflow's overlay. Edits objective text,
 * branch enable/labels, timing expressions, WhatsApp templates, max attempts, and
 * assignment strategy — NEVER triggers, target models, raw mappings, or JSON.
 * Saves into the draft version (the parent guarantees we're editing a draft).
 */
export default function WorkflowSimpleEditor({
  card,
  overlay,
  editingActive,
  onClose,
  onSave,
}: {
  card: WorkflowCard;
  overlay: SalesWorkflowOverlay;
  /** True when the manager opened this from an ACTIVE version (we'll fork a draft). */
  editingActive: boolean;
  onClose: () => void;
  onSave: (next: SalesWorkflowOverlay) => void;
}) {
  const { language, users } = useAppStore();
  const isAr = language === 'ar';

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
  const [timings, setTimings] = useState(() =>
    Object.fromEntries(card.timings.map((t) => [t.action_id, t.current_value])),
  );
  const [maxAttempts, setMaxAttempts] = useState(() =>
    Object.fromEntries(card.max_attempts.map((m) => [m.action_id, m.current_value])),
  );
  const [messages, setMessages] = useState(() =>
    Object.fromEntries(card.messages.map((m) => [m.action_id, { ar: m.current_ar, en: m.current_en }])),
  );
  const [assignments, setAssignments] = useState(() =>
    Object.fromEntries(card.assignments.map((a) => [a.action_id, {
      strategy: (STRATEGIES.includes(a.current_strategy as SalesAssignmentStrategy) ? a.current_strategy : 'same_sales_rep') as SalesAssignmentStrategy,
      fixed_user_id: overlay.assignments?.[a.action_id]?.fixed_user_id ?? null,
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
            <p className="text-xs text-charcoal/55">{isAr ? 'تحرير الإعدادات الأساسية الآمنة' : 'Edit safe business-level settings'}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream"><X size={18} /></button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {editingActive && (
            <div className="flex items-start gap-2 rounded-xl bg-copper/10 p-3 text-xs text-charcoal/80">
              <Info size={15} className="mt-0.5 shrink-0 text-copper" />
              <span>{isAr ? 'هذا الإصدار نشط — سيتم إنشاء مسودة وتطبيق تعديلاتك عليها دون المساس بالإصدار الحي.' : 'This version is active — a draft will be created and your edits applied there, leaving the live version untouched.'}</span>
            </div>
          )}

          {/* Objective */}
          <Section icon={<Target size={14} />} title={isAr ? 'الهدف' : 'Objective'}>
            <textarea value={objAr} onChange={(e) => setObjAr(e.target.value)} rows={2} dir="rtl" className="form-input w-full text-sm" placeholder={isAr ? 'الهدف بالعربية' : 'Goal (Arabic)'} />
            <textarea value={objEn} onChange={(e) => setObjEn(e.target.value)} rows={2} dir="ltr" className="form-input mt-2 w-full text-sm" placeholder="Goal (English)" />
          </Section>

          {/* Branches */}
          {card.branches.length > 0 && (
            <Section icon={<GitBranch size={14} />} title={isAr ? 'المسارات والنتائج' : 'Branches & outcomes'}>
              <div className="space-y-2">
                {card.branches.map((b) => {
                  const st = branches[b.branch_id]!;
                  return (
                    <div key={b.branch_id} className="rounded-lg border border-sand/40 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-charcoal">{pick(b.summary, isAr)}</span>
                        <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-charcoal/60">
                          <input type="checkbox" checked={st.enabled} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, enabled: e.target.checked } }))} />
                          {isAr ? 'مفعّل' : 'Enabled'}
                        </label>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <input value={st.label_en} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, label_en: e.target.value } }))} dir="ltr" className="form-input flex-1 !py-1.5 text-xs" placeholder={b.label_en || 'Label (EN)'} />
                        <input value={st.label_ar} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, label_ar: e.target.value } }))} dir="rtl" className="form-input flex-1 !py-1.5 text-xs" placeholder={b.label_ar || 'التسمية'} />
                      </div>
                      {!b.is_else && (
                        <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] text-charcoal/60">
                          <input type="checkbox" checked={st.primary_success} onChange={(e) => setBranches((s) => ({ ...s, [b.branch_id]: { ...st, primary_success: e.target.checked } }))} />
                          {isAr ? 'النتيجة الرئيسية الناجحة' : 'Primary success outcome'}
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Timings + max attempts */}
          {card.timings.length > 0 && (
            <Section icon={<Clock size={14} />} title={isAr ? 'توقيتات المتابعة' : 'Follow-up timing'}>
              <p className="mb-2 text-[11px] text-charcoal/50">{isAr ? 'صيغ مثل: +0d ، +1d ، +2d @10:00 ، +5d' : 'Expressions like: +0d, +1d, +2d @10:00, +5d'}</p>
              <div className="space-y-2">
                {card.timings.map((t) => (
                  <div key={t.action_id} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-xs text-charcoal/65">{pick(t.label, isAr)}</span>
                    <input value={timings[t.action_id] ?? ''} onChange={(e) => setTimings((s) => ({ ...s, [t.action_id]: e.target.value }))} dir="ltr" className="form-input flex-1 !py-1.5 text-xs" placeholder={t.default_value ?? '+1d'} />
                  </div>
                ))}
              </div>
              {card.max_attempts.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] font-semibold text-charcoal/55"><ShieldAlert size={11} className="me-1 inline" />{isAr ? 'حد المحاولات (إيقاف إعادة المحاولة)' : 'Max attempts (stops the retry)'}</p>
                  {card.max_attempts.map((m) => (
                    <div key={m.action_id} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 truncate text-xs text-charcoal/65">{pick(m.label, isAr)}</span>
                      <input
                        type="number" min={0}
                        value={maxAttempts[m.action_id] ?? ''}
                        onChange={(e) => setMaxAttempts((s) => ({ ...s, [m.action_id]: e.target.value === '' ? null : Number(e.target.value) }))}
                        dir="ltr" className="form-input w-24 !py-1.5 text-xs" placeholder={isAr ? 'بلا حد' : 'no cap'}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Messages */}
          {card.messages.length > 0 && (
            <Section icon={<MessageCircle size={14} />} title={isAr ? 'قوالب رسائل واتساب' : 'WhatsApp templates'}>
              <div className="space-y-3">
                {card.messages.map((m) => {
                  const st = messages[m.action_id]!;
                  return (
                    <div key={m.action_id}>
                      <textarea value={st.ar} onChange={(e) => setMessages((s) => ({ ...s, [m.action_id]: { ...st, ar: e.target.value } }))} rows={2} dir="rtl" className="form-input w-full text-xs" placeholder={isAr ? 'الرسالة بالعربية' : 'Message (Arabic)'} />
                      <textarea value={st.en} onChange={(e) => setMessages((s) => ({ ...s, [m.action_id]: { ...st, en: e.target.value } }))} rows={2} dir="ltr" className="form-input mt-1.5 w-full text-xs" placeholder="Message (English)" />
                    </div>
                  );
                })}
                <p className="text-[11px] text-charcoal/45">{isAr ? 'يمكنك استخدام رموز مثل {client_name} وتُستبدل تلقائيًا.' : 'You can use tokens like {client_name} — resolved automatically.'}</p>
              </div>
            </Section>
          )}

          {/* Assignment */}
          {card.assignments.length > 0 && (
            <Section icon={<UserCog size={14} />} title={isAr ? 'استراتيجية الإسناد' : 'Assignment strategy'}>
              <div className="space-y-2">
                {card.assignments.map((a) => {
                  const st = assignments[a.action_id]!;
                  return (
                    <div key={a.action_id} className="space-y-1.5">
                      <select value={st.strategy} onChange={(e) => setAssignments((s) => ({ ...s, [a.action_id]: { ...st, strategy: e.target.value as SalesAssignmentStrategy } }))} className="form-input w-full !py-1.5 text-xs">
                        {STRATEGIES.map((str) => <option key={str} value={str}>{pick(ASSIGNMENT_STRATEGY_LABELS[str], isAr)}</option>)}
                      </select>
                      {st.strategy === 'fixed_user' && (
                        <select value={st.fixed_user_id ?? ''} onChange={(e) => setAssignments((s) => ({ ...s, [a.action_id]: { ...st, fixed_user_id: e.target.value || null } }))} className="form-input w-full !py-1.5 text-xs">
                          <option value="">{isAr ? 'اختر مستخدمًا' : 'Select user'}</option>
                          {activeUsers.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>)}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

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

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50">
        <span className="text-copper">{icon}</span> {title}
      </h4>
      {children}
    </section>
  );
}
