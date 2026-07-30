/**
 * Publishing — design screen 11.
 *
 * One row per platform, each with its own caption, time and result. The screen
 * is honest about two decided facts:
 *   - No platform is connected, and none will be for publishing. "Scheduled"
 *     means the system reminds the responsible role at the time; a person posts.
 *   - Metrics are typed by hand at first, so a number carries the date it was
 *     entered and the word "manual" rather than looking measured.
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import {
  fetchPublications,
  recordMetrics,
  savePublication,
  MosAccount,
  MosPublication,
  PUB_STATUS_LABELS,
} from '@/lib/marketingOS/client';

interface Props {
  contentId: string;
  isAr: boolean;
}

export default function PublishingTab({ contentId, isAr }: Props) {
  const addToast = useAppStore((s) => s.addToast);
  const [pubs, setPubs] = useState<MosPublication[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [metricsFor, setMetricsFor] = useState<MosPublication | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchPublications(contentId);
      setPubs(res.publications);
      setAccounts(res.accounts);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId]);

  const patch = async (pub: MosPublication, changes: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await savePublication(contentId, { id: pub.id, ...changes });
      setPubs(res.publications);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const addFor = async (account: MosAccount) => {
    setBusy(true);
    try {
      const res = await savePublication(contentId, {
        platform: account.platform,
        account_id: account.id,
        status: 'draft',
      });
      setPubs(res.publications);
      setAdding(false);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (v: string | null) =>
    v
      ? new Date(v).toLocaleString(isAr ? 'ar-SA' : 'en-GB', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        })
      : '—';

  if (loading) {
    return (
      <div className="rounded-xl border border-sand bg-white p-8 text-center text-sm text-charcoal/50">
        {isAr ? 'جارٍ التحميل…' : 'Loading…'}
      </div>
    );
  }

  const unused = accounts.filter((a) => !pubs.some((p) => p.account_id === a.id));

  return (
    <div className="space-y-3">
      {pubs.length === 0 && (
        <div className="rounded-xl border border-dashed border-sand bg-white p-8 text-center">
          <p className="text-sm text-charcoal/60">
            {isAr
              ? 'لا توجد عمليات نشر بعد. أضف منصة لتبدأ.'
              : 'No publications yet. Add a platform to start.'}
          </p>
        </div>
      )}

      {pubs.map((p) => (
        <div key={p.id} className="rounded-xl border border-sand bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-sand/60 px-4 py-3">
            <span className="text-sm font-bold">
              {isAr ? p.account_label_ar ?? p.platform : p.account_label_en ?? p.platform}
            </span>
            {p.account_handle && (
              <span className="font-mono text-xs text-charcoal/50" dir="ltr">
                {p.account_handle}
              </span>
            )}
            <span
              className={`ms-auto rounded px-2 py-1 text-xs font-semibold ${
                p.status === 'published'
                  ? 'bg-chocolate text-cream'
                  : p.status === 'scheduled'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-cream text-charcoal/60'
              }`}
            >
              {isAr ? PUB_STATUS_LABELS[p.status]?.ar : PUB_STATUS_LABELS[p.status]?.en}
            </span>
          </div>

          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <div>
              <div className="text-[11px] font-semibold text-charcoal/50">
                {isAr ? 'الموعد' : 'When'}
              </div>
              <div className="mt-1 text-sm">
                {p.status === 'published' ? fmt(p.published_at) : fmt(p.scheduled_at)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.status !== 'published' && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const when = window.prompt(
                          isAr ? 'موعد النشر (YYYY-MM-DD HH:MM)' : 'Schedule time (YYYY-MM-DD HH:MM)',
                        );
                        if (!when) return;
                        const d = new Date(when);
                        if (Number.isNaN(d.getTime())) {
                          addToast(isAr ? 'تاريخ غير صالح' : 'Invalid date', 'error');
                          return;
                        }
                        void patch(p, { status: 'scheduled', scheduled_at: d.toISOString() });
                      }}
                      className="rounded border border-sand px-2 py-1 text-xs"
                    >
                      {isAr ? 'جدولة' : 'Schedule'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const url = window.prompt(
                          isAr ? 'رابط المنشور (اختياري)' : 'Post link (optional)',
                        );
                        void patch(p, {
                          status: 'published',
                          published_at: new Date().toISOString(),
                          external_url: url || null,
                        });
                      }}
                      className="rounded border border-green-600 bg-green-50 px-2 py-1 text-xs font-semibold text-green-800"
                    >
                      {isAr ? 'تعليمه كمنشور' : 'Mark published'}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-charcoal/50">
                {isAr ? 'الكابشن' : 'Caption'}
              </div>
              <textarea
                defaultValue={p.caption ?? ''}
                onBlur={(e) => {
                  if (e.target.value !== (p.caption ?? '')) {
                    void patch(p, { caption: e.target.value || null });
                  }
                }}
                rows={3}
                className="form-input mt-1 w-full text-xs"
                placeholder={isAr ? 'كابشن خاص بهذه المنصة' : 'Caption for this platform'}
              />
            </div>

            <div>
              <div className="text-[11px] font-semibold text-charcoal/50">
                {isAr ? 'الأرقام' : 'Numbers'}
              </div>
              {p.snapshot_count === 0 ? (
                <p className="mt-1 text-xs text-charcoal/50">
                  {p.status === 'published'
                    ? isAr ? 'لم تُدخل بعد' : 'Not entered yet'
                    : isAr ? 'بعد النشر' : 'After it publishes'}
                </p>
              ) : (
                <div className="mt-1 text-xs">
                  <div className="flex gap-3">
                    <span><b>{p.latest_views ?? '—'}</b> {isAr ? 'مشاهدة' : 'views'}</span>
                    <span><b>{p.latest_enquiries ?? '—'}</b> {isAr ? 'استفسار' : 'enq.'}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-charcoal/45">
                    {isAr ? 'آخر إدخال ' : 'last '}
                    {fmt(p.latest_captured_at)}
                    {p.latest_source === 'manual' && (
                      <span className="ms-1 rounded bg-cream px-1 py-px">
                        {isAr ? 'يدوي' : 'manual'}
                      </span>
                    )}
                    {' · '}
                    {p.snapshot_count} {isAr ? 'قراءة' : 'readings'}
                  </div>
                </div>
              )}
              {p.status === 'published' && (
                <button
                  type="button"
                  onClick={() => setMetricsFor(p)}
                  className="mt-2 rounded border border-sand px-2 py-1 text-xs"
                >
                  {isAr ? 'إدخال أرقام' : 'Enter numbers'}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {unused.length > 0 && (
        <Button variant="secondary" onClick={() => setAdding(true)} disabled={busy}>
          <Plus className="h-4 w-4" />
          {isAr ? 'إضافة منصة' : 'Add platform'}
        </Button>
      )}

      <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2.5 text-xs leading-relaxed text-charcoal/75">
        {isAr
          ? 'لا توجد منصة مربوطة، والنشر يبقى يدويًا بقرار. «مجدول» تعني أن النظام يذكّر الدور المسؤول في وقته، فينشر بنفسه ويؤكد.'
          : 'No platform is connected, and publishing stays manual by decision. "Scheduled" means the system reminds the responsible role at the time; a person posts and confirms.'}
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={isAr ? 'إضافة منصة' : 'Add platform'}
      >
        <div className="space-y-2">
          {unused.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={busy}
              onClick={() => void addFor(a)}
              className="flex w-full items-center gap-3 rounded-lg border border-sand p-3 text-start hover:border-copper"
            >
              <span className="text-sm font-semibold">{isAr ? a.label_ar : a.label_en}</span>
              {a.handle && (
                <span className="font-mono text-xs text-charcoal/50" dir="ltr">{a.handle}</span>
              )}
              <span className="ms-auto text-xs text-charcoal/45">
                {a.is_connected
                  ? isAr ? 'مربوط' : 'connected'
                  : isAr ? 'غير مربوط' : 'not connected'}
              </span>
            </button>
          ))}
        </div>
      </Modal>

      {metricsFor && (
        <MetricsModal
          pub={metricsFor}
          isAr={isAr}
          onClose={() => setMetricsFor(null)}
          onSaved={() => {
            setMetricsFor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function MetricsModal({
  pub, isAr, onClose, onSaved,
}: {
  pub: MosPublication;
  isAr: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [views, setViews] = useState('');
  const [engagement, setEngagement] = useState('');
  const [enquiries, setEnquiries] = useState('');
  const [busy, setBusy] = useState(false);

  const numOrNull = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  const save = async () => {
    setBusy(true);
    try {
      await recordMetrics(pub.id, {
        views: numOrNull(views),
        engagement: numOrNull(engagement),
        enquiries: numOrNull(enquiries),
      });
      addToast(isAr ? 'أُضيفت قراءة جديدة' : 'New reading recorded', 'success');
      onSaved();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isAr ? 'إدخال أرقام' : 'Enter numbers'}
      footer={
        <div className="flex items-center gap-2">
          <p className="me-auto max-w-xs text-xs text-charcoal/50">
            {isAr
              ? 'تُضاف كقراءة جديدة بتاريخها — لا تستبدل السابقة.'
              : 'Saved as a new dated reading — it never overwrites the last one.'}
          </p>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {isAr ? 'حفظ القراءة' : 'Save reading'}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        {[
          { label: isAr ? 'المشاهدات' : 'Views', v: views, set: setViews },
          { label: isAr ? 'التفاعل' : 'Engagement', v: engagement, set: setEngagement },
          { label: isAr ? 'الاستفسارات' : 'Enquiries', v: enquiries, set: setEnquiries },
        ].map((f) => (
          <div key={f.label}>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{f.label}</label>
            <input
              value={f.v}
              onChange={(e) => f.set(e.target.value)}
              inputMode="numeric"
              className="form-input w-full"
              placeholder={isAr ? 'اتركه فارغًا إن لم تعرفه' : 'Leave blank if unknown'}
            />
          </div>
        ))}
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'الحقل الفارغ يبقى فارغًا — لا يُحفظ صفرًا. الصفر يعني «قِسنا ولم نجد شيئًا».'
            : 'A blank field stays blank — it is not saved as zero. Zero would mean "measured, and it was nothing".'}
        </p>
      </div>
    </Modal>
  );
}
