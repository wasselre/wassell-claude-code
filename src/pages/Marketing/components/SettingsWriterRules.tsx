/**
 * Settings → Writer rules (قواعد الكاتب).
 *
 * The shared rulebook every AI writer (post + video) is constrained by —
 * prohibited phrases, tone decisions, claim discipline — seeded from both
 * skills' Decisions Logs and editable here as DATA. The decisions log is
 * append-only history; the rule lists are the live text.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { fetchWriterRules, saveWriterRules } from '@/lib/marketingOS/creativeClient';
import type { WriterRules } from '@/lib/creative/contracts';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num, shortDate } from '../lib/format';

/** One editable list of rule lines (textarea, one rule per line). */
function RuleList({
  label, hint, value, disabled, onChange,
}: {
  label: string;
  hint: string;
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <label style={{ display: 'block' }}>
      <span className="lbl">
        {label}
        <span style={{ fontWeight: 400, color: 'var(--mute)' }}> · {hint}</span>
      </span>
      <textarea
        className="inp"
        rows={Math.max(4, Math.min(12, value.length + 1))}
        style={{ marginTop: 6 }}
        value={value.join('\n')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.split('\n'))}
      />
    </label>
  );
}

export default function SettingsWriterRules({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [rules, setRules] = useState<WriterRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWriterRules();
      setRules(res.rules);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (): Promise<void> => {
    if (!rules) return;
    setSaving(true);
    try {
      // Empty lines are editing artifacts, never rules.
      const cleaned: WriterRules = {
        ...rules,
        shared: rules.shared.map((r) => r.trim()).filter(Boolean),
        post: rules.post.map((r) => r.trim()).filter(Boolean),
        video: (rules.video ?? []).map((r) => r.trim()).filter(Boolean),
      };
      const res = await saveWriterRules(cleaned);
      setRules(res.rules);
      setDirty(false);
      addToast(isAr ? 'حُفظت القواعد.' : 'Rules saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'قواعد الكاتب' : 'Writer rules'}
        sub={isAr
          ? 'القواعد التي يلتزم بها كل كاتب ذكاء — قاعدة في كل سطر'
          : 'The rules every AI writer is bound by — one rule per line'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && rules && (
          <button type="button" className="btn btn-p" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
          </button>
        )}
      </PageHead>
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={4} />}
        {!loading && !error && rules && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div className="card">
              <div className="card-b" style={{ display: 'grid', gap: 14 }}>
                <RuleList
                  label={isAr ? 'قواعد مشتركة' : 'Shared rules'}
                  hint={isAr ? 'تسري على المنشورات والفيديو معًا' : 'apply to posts and video alike'}
                  value={rules.shared}
                  disabled={!canManage}
                  onChange={(next) => { setRules({ ...rules, shared: next }); setDirty(true); }}
                />
                <RuleList
                  label={isAr ? 'قواعد المنشورات' : 'Post rules'}
                  hint={isAr ? 'مدير إبداع المنشورات فقط' : 'the post creative director only'}
                  value={rules.post}
                  disabled={!canManage}
                  onChange={(next) => { setRules({ ...rules, post: next }); setDirty(true); }}
                />
                <RuleList
                  label={isAr ? 'قواعد الفيديو' : 'Video rules'}
                  hint={isAr ? 'كاتب سكربت الفيديو' : 'the video script writer'}
                  value={rules.video ?? []}
                  disabled={!canManage}
                  onChange={(next) => { setRules({ ...rules, video: next }); setDirty(true); }}
                />
                {!canManage && (
                  <div className="notice" style={{ fontSize: 12 }}>
                    {isAr ? 'التعديل يتطلب صلاحية إدارة الإعدادات.' : 'Editing requires manage-settings.'}
                  </div>
                )}
              </div>
            </div>

            {rules.decisions_log.length > 0 && (
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'سجل القرارات' : 'Decisions log'}</h4>
                  <span className="r">{isAr ? 'تاريخ — لا يُحرَّر' : 'history — not editable'}</span>
                </div>
                <div className="card-b" style={{ display: 'grid', gap: 8 }}>
                  {rules.decisions_log.map((d, i) => (
                    <div key={i} style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                      <span className="tag" style={{ marginInlineEnd: 6 }}>{shortDate(d.date, isAr)}</span>
                      {d.note}
                      {d.source && <span style={{ color: 'var(--mute)' }}> · {d.source}</span>}
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                    {isAr ? `${num(rules.decisions_log.length, true)} قرارًا` : `${rules.decisions_log.length} decisions`}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
