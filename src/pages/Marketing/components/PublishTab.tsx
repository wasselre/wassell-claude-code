/**
 * Publishing — design screen 11, rebuilt as one CARD per publication.
 *
 * ONE ROW PER PLATFORM, never a multi-select: «V-002 خرج» is not one fact about
 * the video but three separate facts about three platforms — each publication
 * carries its own file, its own caption, its own account, its own timing and
 * its own result. The three cards deliberately read differently by state:
 * published (facts + first numbers), scheduled (who posts, manually), and
 * incomplete (the gaps named out loud — «بحاجة لموعد» يعطّل «جاهز»).
 *
 * THE FILE PICKER OFFERS ONLY APPROVED FILES — assets linked to this item with
 * role 'final' (Materials band 4). That single rule is what ends «أي نسخة
 * خرجت؟» forever, and it is enforced here in code, not by convention.
 *
 * Publishing is manual by decision (design answer 4: «النشر ليس تلقائي»). No
 * account here can publish until someone connects it, and the screen says so
 * rather than implying an automation that does not exist.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosAccount, MosAsset, MosPublication, PLATFORM_LABELS, PUB_STATUS_LABELS,
  fetchAssets, savePublication,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Field, Modal, Pill } from './kit';
import { IconPlus } from './icons';
import { dateTimeShort, isoDateTimeLocal, num, shortDate } from '../lib/format';

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'website'] as const;

/** The platforms' own colours — the mockup's header dots and account badges. */
const PLATFORM_COLOR: Record<string, string> = {
  instagram: '#C13584',
  tiktok: 'var(--ink)',
  snapchat: '#C8B400',
  x: 'var(--ink)',
  youtube: '#B03A2E',
  website: 'var(--copper)',
};
const PLATFORM_INITIALS: Record<string, string> = {
  instagram: 'IG', tiktok: 'TT', snapchat: 'SC', x: 'X', youtube: 'YT', website: 'WEB',
};

/**
 * TODO(client): `mos_publication_v` also returns `file_id` and
 * `published_by_user_id` — add both to MosPublication in
 * src/lib/marketingOS/client.ts. Local read-side extension until then.
 */
type PubRow = MosPublication & {
  file_id?: string | null;
  published_by_user_id?: string | null;
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
  const { people } = useWorkspace();
  const [editing, setEditing] = useState<MosPublication | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finalAssets, setFinalAssets] = useState<MosAsset[]>([]);
  const [allAssets, setAllAssets] = useState<MosAsset[]>([]);

  // The approved files — band 4 of the Materials tab: links with role 'final'.
  // Non-fatal on failure: the picker shows the empty-rule copy and the error
  // is logged, never swallowed.
  const loadFinals = useCallback(async () => {
    try {
      const res = await fetchAssets();
      setAllAssets(res.assets);
      const finalIds = new Set(
        res.links.filter((l) => l.content_id === contentId && l.role === 'final').map((l) => l.asset_id),
      );
      setFinalAssets(res.assets.filter((a) => finalIds.has(a.id)));
    } catch (e) {
      console.error('[marketing] approved-file list unavailable', e);
    }
  }, [contentId]);
  useEffect(() => { void loadFinals(); }, [loadFinals]);

  const nameOf = (userId: string | null | undefined): string | null => {
    if (!userId) return null;
    const u = people.find((x) => x.user_id === userId);
    if (!u) return null;
    return (isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar;
  };

  const save = async (payload: Record<string, unknown>, pickedAsset: MosAsset | null): Promise<void> => {
    setBusy(true);
    try {
      const res = await savePublication(contentId, payload);
      onChange(res.publications);
      setEditing(null);
      setAdding(false);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
      // The file pick must not fail silently: verify the server actually kept
      // it. TODO(server): publication_save's whitelist lacks 'file_id' — the
      // mos_publications.file_id column exists; add the key server-side.
      if (pickedAsset) {
        const savedRow = (res.publications as PubRow[]).find(
          (p) => p.id === payload.id || (!payload.id && p.platform === payload.platform),
        );
        if (!pickedAsset.file_id || savedRow?.file_id !== pickedAsset.file_id) {
          console.error('[marketing] publication file link not persisted', {
            picked: pickedAsset.id, file_id: pickedAsset.file_id ?? null, saved: savedRow?.file_id ?? null,
          });
          addToast(
            isAr
              ? 'حُفظ النشر، لكن ربط الملف المعتمد لم يُحفظ بعد — القدرة قيد الإكمال في الخادم.'
              : 'The publication saved, but the approved-file link did not persist yet — server support pending.',
            'error',
          );
        }
      }
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const used = new Set(publications.map((p) => p.platform));
  const available = PLATFORMS.filter((p) => !used.has(p));

  const platformLabel = (p: string): string =>
    (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;

  /** The approved asset a publication actually carries, resolved by file id. */
  const fileAssetOf = (pub: PubRow): MosAsset | null => {
    if (!pub.file_id) return null;
    return allAssets.find((a) => a.file_id === pub.file_id) ?? null;
  };

  const igCaption = publications.find((p) => p.platform === 'instagram' && p.caption)?.caption ?? null;

  const pubCard = (pubRaw: MosPublication) => {
    const pub = pubRaw as PubRow;
    const color = PLATFORM_COLOR[pub.platform] ?? 'var(--copper)';
    const fileAsset = fileAssetOf(pub);
    const needsTime = pub.status === 'draft' && !pub.scheduled_at;
    const publisher = nameOf(pub.published_by_user_id);
    const captionDiffers = pub.platform !== 'instagram' && igCaption !== null
      && pub.caption !== null && pub.caption !== '' && pub.caption !== igCaption;

    const pill = pub.status === 'published'
      ? <Pill tone="live">{isAr ? PUB_STATUS_LABELS.published?.ar : PUB_STATUS_LABELS.published?.en}</Pill>
      : pub.status === 'scheduled'
        ? <Pill tone="go">{isAr ? PUB_STATUS_LABELS.scheduled?.ar : PUB_STATUS_LABELS.scheduled?.en}</Pill>
        : pub.status === 'cancelled'
          ? <Pill tone="wait">{isAr ? PUB_STATUS_LABELS.cancelled?.ar : PUB_STATUS_LABELS.cancelled?.en}</Pill>
          : needsTime
            ? <Pill tone="idle">{isAr ? 'بحاجة لموعد' : 'Needs a time'}</Pill>
            : <Pill tone="idle">{isAr ? PUB_STATUS_LABELS.draft?.ar : PUB_STATUS_LABELS.draft?.en}</Pill>;

    const fileCell = fileAsset ? (
      <>
        <span className="ltr">{fileAsset.title}</span>{' '}
        <span className="ver" style={{ marginInlineStart: 5 }}>{isAr ? 'معتمد' : 'approved'}</span>
      </>
    ) : (
      <span style={{ color: pub.status === 'published' ? 'var(--ink-2)' : 'var(--mute)' }}>
        {isAr ? 'لم يُختر ملف' : 'No file chosen'}{' '}
        <span className="tag" style={{ marginInlineStart: 5 }}>
          {isAr ? 'معتمد فقط' : 'approved only'}
        </span>
      </span>
    );

    return (
      <div key={pub.id} className="card">
        <div
          className="card-h cd2-pub-h"
          style={pub.status === 'published'
            ? { background: `color-mix(in srgb, ${color} 7%, transparent)` }
            : pub.status === 'scheduled' ? { background: 'var(--sand-2)' } : undefined}
        >
          <span className="cd2-pdot" style={{ background: color }} />
          <h4>{platformLabel(pub.platform)}</h4>
          {(pub.account_handle || pub.account_label_ar) && (
            <span className={pub.account_handle ? 'tag ltr' : 'tag'}>
              {pub.account_handle ?? (isAr ? pub.account_label_ar : pub.account_label_en)}
            </span>
          )}
          <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 7, alignItems: 'center' }}>
            {pill}
            {canEdit && (
              <button type="button" className="btn btn-d btn-sm" onClick={() => setEditing(pubRaw)}>
                {isAr ? 'تعديل' : 'Edit'}
              </button>
            )}
          </span>
        </div>
        <div className="card-b cd2-pub-grid">
          <div>
            {pub.status === 'published' ? (
              <div className="fld">
                <div className="k">{isAr ? 'تاريخ النشر' : 'Published'}</div>
                <div className="v">
                  {dateTimeShort(pub.published_at, isAr)}
                  {publisher && <> · {isAr ? `بواسطة ${publisher}` : `by ${publisher}`}</>}
                </div>
              </div>
            ) : (
              <div className="fld">
                <div className="k">{isAr ? 'موعد الجدولة' : 'Scheduled for'}</div>
                <div className="v" style={needsTime ? { color: 'var(--late)' } : undefined}>
                  {pub.scheduled_at
                    ? dateTimeShort(pub.scheduled_at, isAr)
                    : isAr ? 'غير محدد — يعطّل «جاهز»' : 'not set — blocks “ready”'}
                </div>
              </div>
            )}
            <div className="fld">
              <div className="k">{isAr ? 'الملف المستخدم' : 'File used'}</div>
              <div className="v">{fileCell}</div>
            </div>
            {pub.status === 'published' && pub.external_url && (
              <div className="fld">
                <div className="k">{isAr ? 'الرابط' : 'Link'}</div>
                <div className="v ltr" style={{ color: 'var(--copper)', overflowWrap: 'anywhere' }}>
                  <a href={pub.external_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                    {pub.external_url.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              </div>
            )}
            {pub.status === 'scheduled' && (
              <div className="fld">
                <div className="k">{isAr ? 'من ينشر' : 'Who posts'}</div>
                <div className="v">
                  {pub.account_connected
                    ? isAr ? 'يدويًا — عند التذكير' : 'manually — on the reminder'
                    : isAr
                      ? `يدويًا — ${platformLabel(pub.platform)} غير مربوط`
                      : `manually — ${platformLabel(pub.platform)} is not connected`}
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="fld">
              <div className="k">
                {pub.caption
                  ? isAr ? 'الكابشن المستخدم' : 'Caption used'
                  : isAr ? 'الكابشن' : 'Caption'}
              </div>
              {pub.caption ? (
                <>
                  <div className="v" style={{ lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{pub.caption}</div>
                  {captionDiffers && (
                    <div className="cd2-caption-diff">
                      {isAr ? 'يختلف عن انستقرام' : 'differs from Instagram'}
                    </div>
                  )}
                </>
              ) : (
                <div className="v" style={{ color: 'var(--mute)' }}>
                  {isAr ? 'لم يُكتب' : 'not written'}
                </div>
              )}
            </div>
          </div>
          <div>
            {pub.status === 'published' ? (
              <>
                <div className="fld">
                  <div className="k">{isAr ? 'آخر قراءة' : 'Latest reading'}</div>
                  {pub.latest_captured_at ? (
                    <div className="v" style={{ display: 'flex', gap: 14 }}>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_views, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'مشاهدة' : 'views'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_engagement, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'تفاعل' : 'engagement'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_enquiries, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'استفسار' : 'enquiries'}</span>
                      </span>
                    </div>
                  ) : (
                    <div className="v" style={{ color: 'var(--mute)' }}>
                      {isAr ? 'لا قراءات بعد' : 'no readings yet'}
                    </div>
                  )}
                </div>
                {pub.latest_captured_at && (
                  <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 6 }}>
                    {isAr ? 'آخر إدخال ' : 'entered '}{shortDate(pub.latest_captured_at, isAr)}
                  </div>
                )}
              </>
            ) : pub.status === 'scheduled' ? (
              <div className="fld">
                <div className="k">{isAr ? 'النتائج' : 'Results'}</div>
                <div className="v" style={{ color: 'var(--mute)' }}>
                  {isAr ? 'بعد النشر' : 'after it goes out'}
                </div>
              </div>
            ) : (
              canEdit && (
                <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                  <button type="button" className="btn btn-p btn-sm" onClick={() => setEditing(pubRaw)}>
                    {isAr ? 'حدد الموعد والنسخة' : 'Set the time and the file'}
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="cd2-split">
      <div style={{ display: 'grid', gap: 13, minWidth: 0 }}>
        {publications.length === 0 ? (
          <div className="card">
            <p style={{ padding: 26, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
              {isAr
                ? 'لا عمليات نشر بعد. صفّ لكل منصة — كابشنها وملفها وتوقيتها ونتيجتها.'
                : 'No publications yet. One row per platform — its caption, its file, its time, its result.'}
            </p>
          </div>
        ) : (
          publications.map(pubCard)
        )}

        {canEdit && available.length > 0 && (
          <div>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <IconPlus />
              {isAr ? 'إضافة نشر' : 'Add a publication'}
            </button>
          </div>
        )}

        <div className="notice">
          {isAr
            ? 'النشر يدوي بقرار: لا حساب هنا ينشر تلقائيًا. عند النشر فعليًا، علّم الصف «منشور» وضع الرابط — عندها تصبح الأرقام قابلة للإدخال.'
            : 'Publishing is manual by decision: no account here posts on its own. When you actually post, mark the row published and paste the link — that is what makes the numbers enterable.'}
        </div>
      </div>

      {/* ── the tab's own side column — الربط بالمنصات ────────────────── */}
      <div>
        <div className="lbl" style={{ marginBottom: 11 }}>
          {isAr ? 'الربط بالمنصات' : 'Platform connections'}
        </div>
        {accounts.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
            {isAr ? 'لا حسابات معرّفة — تُدار من الإعدادات.' : 'No accounts defined — managed from Settings.'}
          </div>
        ) : (
          accounts.map((a) => (
            <div key={a.id} className="file" style={{ padding: '9px 10px' }}>
              <div
                className="cd2-acct-badge"
                style={{
                  background: PLATFORM_COLOR[a.platform] ?? 'var(--copper)',
                  color: a.platform === 'snapchat' ? '#3F3F3F' : 'var(--paper, #fff)',
                }}
              >
                {PLATFORM_INITIALS[a.platform] ?? a.platform.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="nm" style={{ fontSize: 12 }}>{platformLabel(a.platform)}</div>
                <div className="mt" style={{ fontSize: 10.5 }}>
                  {a.handle && <span className="ltr">{a.handle} · </span>}
                  {a.is_connected ? (isAr ? 'مربوط' : 'connected') : (isAr ? 'غير مربوط' : 'not connected')}
                </div>
              </div>
            </div>
          ))
        )}
        <div className="cd2-gold-note">
          {isAr ? (
            <>
              <b style={{ fontWeight: 700 }}>قبل ربط المنصة، «مجدول» تعني تذكيرًا</b> — يُنبّه النظام
              من ينشر عند الموعد، فينشر يدويًا ويؤكد. الشاشة صادقة في ذلك بدل الإيحاء بنشر تلقائي غير موجود.
            </>
          ) : (
            <>
              <b style={{ fontWeight: 700 }}>Until a platform is connected, “scheduled” means a reminder</b>{' '}
              — the system nudges whoever posts at the slot, they post manually and confirm. The screen is
              honest about that instead of implying an automation that does not exist.
            </>
          )}
        </div>
      </div>

      {(editing || adding) && (
        <PublicationModal
          publication={editing}
          accounts={accounts}
          available={available}
          finalAssets={finalAssets}
          isAr={isAr}
          busy={busy}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSave={(payload, picked) => void save(payload, picked)}
        />
      )}
    </div>
  );
}

function PublicationModal({
  publication, accounts, available, finalAssets, isAr, busy, onClose, onSave,
}: {
  publication: MosPublication | null;
  accounts: MosAccount[];
  available: string[];
  /** ONLY assets linked to this item with role 'final' — the band-4 rule. */
  finalAssets: MosAsset[];
  isAr: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>, pickedAsset: MosAsset | null) => void;
}) {
  const pubRow = publication as PubRow | null;
  const [platform, setPlatform] = useState(publication?.platform ?? available[0] ?? 'instagram');
  const [accountId, setAccountId] = useState(publication?.account_id ?? '');
  const [status, setStatus] = useState(publication?.status ?? 'draft');
  const [when, setWhen] = useState(isoDateTimeLocal(publication?.scheduled_at));
  const [caption, setCaption] = useState(publication?.caption ?? '');
  const [url, setUrl] = useState(publication?.external_url ?? '');
  const [assetId, setAssetId] = useState(
    () => finalAssets.find((a) => a.file_id && a.file_id === pubRow?.file_id)?.id ?? '',
  );

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const picked = finalAssets.find((a) => a.id === assetId) ?? null;

  return (
    <Modal
      title={publication
        ? isAr ? 'تعديل النشر' : 'Edit publication'
        : isAr ? 'إضافة نشر' : 'Add a publication'}
      sub={isAr
        ? 'كل منصة صفّ مستقل — كابشن وتوقيت ونسخة ونتيجة خاصة بها.'
        : 'Each platform is its own row — its own caption, timing, file and result.'}
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
              file_id: picked?.file_id ?? null,
            }, picked)}
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

      {/* The band-4 rule, enforced: the picker lists ONLY approved files. */}
      <Field
        label={isAr ? 'الملف المستخدم' : 'File used'}
        hint={isAr ? 'المعتمد فقط' : 'approved files only'}
      >
        {finalAssets.length === 0 ? (
          <div className="inp" style={{ color: 'var(--mute)', fontSize: 12 }}>
            {isAr
              ? 'لا شيء معتمد بعد — الملفات المعتمدة وحدها يمكن ربطها بعملية نشر.'
              : 'Nothing approved yet — only approved files can be attached to a publication.'}
          </div>
        ) : (
          <select className="inp" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">{isAr ? 'بدون تحديد' : 'Not specified'}</option>
            {finalAssets.map((a) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
        )}
      </Field>

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
