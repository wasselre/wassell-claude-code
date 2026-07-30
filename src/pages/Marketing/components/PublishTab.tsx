/**
 * Publishing — design screen 11.
 *
 * ONE ROW PER PLATFORM, never a multi-select. Each platform gets its own
 * caption, its own time, its own link and its own result, because that is what
 * actually happens: the same video is a Reel at 7pm and a TikTok at 8pm with a
 * different first line.
 *
 * Publishing is manual by decision (design answer 4: «النشر ليس تلقائي»). No
 * account here can publish until someone connects it, and the screen says so
 * rather than implying an automation that does not exist.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosAccount, MosPublication, PLATFORM_CLASS, PLATFORM_LABELS, PUB_STATUS_LABELS,
  savePublication,
} from '@/lib/marketingOS/client';
import { Field, Modal, Pill } from './kit';
import { IconPlus } from './icons';
import { dateTime, isoDateTimeLocal } from '../lib/format';

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'website'] as const;

const TONE: Record<string, 'idle' | 'go' | 'live' | 'wait'> = {
  draft: 'idle',
  scheduled: 'go',
  published: 'live',
  cancelled: 'wait',
};

export default function PublishTab({
  contentId, publications, accounts, canEdit, isAr, onChange,
}: {
  contentId: string;
  publications: MosPublication[];
  accounts: MosAccount[];
  canEdit: boolean;
  isAr: boolean;
  onChange: (pubs: MosPublication[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [editing, setEditing] = useState<MosPublication | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (payload: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const res = await savePublication(contentId, payload);
      onChange(res.publications);
      setEditing(null);
      setAdding(false);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const used = new Set(publications.map((p) => p.platform));
  const available = PLATFORMS.filter((p) => !used.has(p));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="card-h">
          <h4>{isAr ? 'خطة النشر' : 'Publishing plan'}</h4>
          <span className="r">
            {isAr
              ? `${publications.length} منصة · النشر يدوي`
              : `${publications.length} platforms · publishing is manual`}
          </span>
        </div>
        {publications.length === 0 ? (
          <p style={{ padding: 26, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
            {isAr
              ? 'لا منصات بعد. أضف صفًّا لكل مكان سيُنشر فيه.'
              : 'No platforms yet. Add a row for each place this goes out.'}
          </p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th style={{ width: 140 }}>{isAr ? 'الحساب' : 'Account'}</th>
                  <th style={{ width: 190 }}>{isAr ? 'التوقيت' : 'When'}</th>
                  <th style={{ width: 110 }}>{isAr ? 'الحالة' : 'Status'}</th>
                  <th>{isAr ? 'الكابشن' : 'Caption'}</th>
                  {canEdit && <th style={{ width: 92 }} />}
                </tr>
              </thead>
              <tbody>
                {publications.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span
                        className="tag"
                        style={{ borderInlineStartWidth: 3, borderInlineStartStyle: 'solid' }}
                        data-platform={PLATFORM_CLASS[p.platform]}
                      >
                        {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
                      </span>
                    </td>
                    <td className="ltr" style={{ color: 'var(--mute)' }}>
                      {p.account_handle ?? (isAr ? p.account_label_ar : p.account_label_en) ?? '—'}
                    </td>
                    <td style={{ color: 'var(--mute)' }}>
                      {p.published_at
                        ? dateTime(p.published_at, isAr)
                        : p.scheduled_at
                          ? dateTime(p.scheduled_at, isAr)
                          : isAr ? 'بلا موعد' : 'no time set'}
                    </td>
                    <td>
                      <Pill tone={TONE[p.status] ?? 'idle'}>
                        {(isAr ? PUB_STATUS_LABELS[p.status]?.ar : PUB_STATUS_LABELS[p.status]?.en) ?? p.status}
                      </Pill>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--mute)', maxWidth: 320 }}>
                      {p.caption
                        ? p.caption.slice(0, 90) + (p.caption.length > 90 ? '…' : '')
                        : isAr ? 'لم يُكتب بعد' : 'not written yet'}
                    </td>
                    {canEdit && (
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(p)}>
                          {isAr ? 'تعديل' : 'Edit'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canEdit && available.length > 0 && (
        <div>
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <IconPlus />
            {isAr ? 'إضافة منصة' : 'Add a platform'}
          </button>
        </div>
      )}

      <div className="notice">
        {isAr
          ? 'النشر يدوي بقرار: لا حساب هنا ينشر تلقائيًا. عند النشر فعليًا، علّم الصف «منشور» وضع الرابط — عندها تصبح الأرقام قابلة للإدخال.'
          : 'Publishing is manual by decision: no account here posts on its own. When you actually post, mark the row published and paste the link — that is what makes the numbers enterable.'}
      </div>

      {(editing || adding) && (
        <PublicationModal
          publication={editing}
          accounts={accounts}
          available={available}
          isAr={isAr}
          busy={busy}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSave={(payload) => void save(payload)}
        />
      )}
    </div>
  );
}

function PublicationModal({
  publication, accounts, available, isAr, busy, onClose, onSave,
}: {
  publication: MosPublication | null;
  accounts: MosAccount[];
  available: string[];
  isAr: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [platform, setPlatform] = useState(publication?.platform ?? available[0] ?? 'instagram');
  const [accountId, setAccountId] = useState(publication?.account_id ?? '');
  const [status, setStatus] = useState(publication?.status ?? 'draft');
  const [when, setWhen] = useState(isoDateTimeLocal(publication?.scheduled_at));
  const [caption, setCaption] = useState(publication?.caption ?? '');
  const [url, setUrl] = useState(publication?.external_url ?? '');

  const platformAccounts = accounts.filter((a) => a.platform === platform);

  return (
    <Modal
      title={publication
        ? isAr ? 'تعديل النشر' : 'Edit publication'
        : isAr ? 'إضافة منصة' : 'Add a platform'}
      sub={isAr
        ? 'كل منصة صفّ مستقل — كابشن وتوقيت ونتيجة خاصة بها.'
        : 'Each platform is its own row — its own caption, timing and result.'}
      onClose={onClose}
      footer={
        <>
          <span className="note">
            {isAr
              ? '«منشور» يسجّل الوقت ومَن نشر تلقائيًا.'
              : 'Marking published stamps the time and who posted it.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy}
            onClick={() => onSave({
              id: publication?.id,
              platform,
              account_id: accountId || null,
              status,
              scheduled_at: when ? new Date(when).toISOString() : null,
              caption: caption || null,
              external_url: url || null,
            })}
          >
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المنصة' : 'Platform'}>
          <select
            className="inp"
            value={platform}
            disabled={Boolean(publication)}
            onChange={(e) => { setPlatform(e.target.value); setAccountId(''); }}
          >
            {(publication ? [publication.platform] : available).map((p) => (
              <option key={p} value={p}>
                {(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}
              </option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'الحساب' : 'Account'}>
          <select className="inp" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{isAr ? 'بدون تحديد' : 'Not specified'}</option>
            {platformAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.handle ?? (isAr ? a.label_ar : a.label_en)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <select
            className="inp"
            value={status}
            onChange={(e) => setStatus(e.target.value as MosPublication['status'])}
          >
            {(['draft', 'scheduled', 'published', 'cancelled'] as const).map((s) => (
              <option key={s} value={s}>
                {isAr ? PUB_STATUS_LABELS[s]?.ar : PUB_STATUS_LABELS[s]?.en}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={isAr ? 'التوقيت' : 'When'}
          hint={status === 'scheduled' ? (isAr ? 'إلزامي للمجدول' : 'required to schedule') : undefined}
        >
          <input type="datetime-local" className="inp" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>

      <Field label={isAr ? 'الكابشن' : 'Caption'} hint={isAr ? 'خاص بهذه المنصة' : 'for this platform only'}>
        <textarea className="inp" rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </Field>

      <Field label={isAr ? 'رابط المنشور' : 'Post link'} hint={isAr ? 'بعد النشر' : 'after posting'}>
        <input className="inp ltr" value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" />
      </Field>
    </Modal>
  );
}
