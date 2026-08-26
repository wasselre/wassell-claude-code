/**
 * The distribution-copy surface on the content tab (Option A, 2026-08-26).
 *
 * A caption belongs to the PLACEMENT it runs on, not to the creative — so this
 * card is driven by the item's `purpose` and by the platforms actually in play,
 * NOT by four hard-coded caption boxes:
 *
 *   organic  → one caption editor per SELECTED organic platform, each bound to
 *              that platform's publication row (the same row the Publish tab
 *              schedules and bundle.social posts). A platform picker declares the
 *              targets (mos_content.organic_platforms). Shared hashtags once.
 *   paid     → one ad-copy card per campaign execution (primary text / headline /
 *              description / CTA / destination URL) → the ad's `creative`.
 *   both     → both blocks, under clear headers.
 *
 * Writes go through `write_content`-gated actions that touch only the copy text;
 * scheduling (publications) and ad structure/metrics stay gated by their own
 * capabilities. Save is per-placement, on an explicit Save button when the card
 * is dirty — the same posture as the creative-prose card.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AdCreative, MosAccount, MosPublication, PaidAdExecItem, PaidAdsResult,
  PLATFORM_LABELS, fetchPaidAds, saveAdCreative, saveContentCaption,
} from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';

/** Platforms that publish ORGANICALLY (a caption lands verbatim). Paid channels
 *  (meta/google) are authored in the paid block, not here. */
const ORGANIC_PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube'];
/** Platforms bundle.social can auto-post; the rest (x/youtube) are manual. */
const AUTO_PLATFORMS = new Set(['instagram', 'tiktok', 'snapchat']);

const platformLabel = (p: string, isAr: boolean): string => {
  const l = PLATFORM_LABELS[p];
  return l ? (isAr ? l.ar : l.en) : p;
};

export default function PlacementCaptions({
  contentId, purpose, campaignId, hasCaption, hasHashtags, accounts, publications,
  hashtags, organicPlatforms, canEdit, isAr,
  onPublicationsChanged, onHashtagsChanged, onOrganicPlatformsChanged,
}: {
  contentId: string;
  purpose: 'organic' | 'paid' | 'both';
  campaignId: string | null;
  hasCaption: boolean;
  hasHashtags: boolean;
  accounts: MosAccount[];
  publications: MosPublication[];
  hashtags: string;
  organicPlatforms: string[];
  canEdit: boolean;
  isAr: boolean;
  onPublicationsChanged: (pubs: MosPublication[]) => void;
  onHashtagsChanged: (value: string) => void;
  onOrganicPlatformsChanged: (platforms: string[]) => void;
}) {
  const showOrganic = purpose !== 'paid' && hasCaption;
  const showPaid = purpose !== 'organic';

  if (!showOrganic && !showPaid) return null;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {showOrganic && (
        <OrganicBlock
          contentId={contentId}
          accounts={accounts}
          publications={publications}
          hashtags={hashtags}
          hasHashtags={hasHashtags}
          organicPlatforms={organicPlatforms}
          canEdit={canEdit}
          isAr={isAr}
          labelledForBoth={purpose === 'both'}
          onPublicationsChanged={onPublicationsChanged}
          onHashtagsChanged={onHashtagsChanged}
          onOrganicPlatformsChanged={onOrganicPlatformsChanged}
        />
      )}
      {showPaid && (
        <PaidBlock
          contentId={contentId}
          campaignId={campaignId}
          canEdit={canEdit}
          isAr={isAr}
          labelledForBoth={purpose === 'both'}
        />
      )}
    </div>
  );
}

/* ══════════════════════ organic ══════════════════════ */

function OrganicBlock({
  contentId, accounts, publications, hashtags, hasHashtags, organicPlatforms,
  canEdit, isAr, labelledForBoth, onPublicationsChanged, onHashtagsChanged, onOrganicPlatformsChanged,
}: {
  contentId: string;
  accounts: MosAccount[];
  publications: MosPublication[];
  hashtags: string;
  hasHashtags: boolean;
  organicPlatforms: string[];
  canEdit: boolean;
  isAr: boolean;
  labelledForBoth: boolean;
  onPublicationsChanged: (pubs: MosPublication[]) => void;
  onHashtagsChanged: (value: string) => void;
  onOrganicPlatformsChanged: (platforms: string[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);

  // The organic platforms with an account on file (connected or manual). This is
  // the pickable universe; X/YouTube show a «يدوي» tag but are still authorable.
  const available = useMemo(
    () => accounts
      .filter((a) => ORGANIC_PLATFORMS.includes(a.platform))
      .sort((a, b) => ORGANIC_PLATFORMS.indexOf(a.platform) - ORGANIC_PLATFORMS.indexOf(b.platform)),
    [accounts],
  );
  const selected = organicPlatforms.filter((p) => available.some((a) => a.platform === p));
  const unselected = available.filter((a) => !selected.includes(a.platform));

  const captionOf = (platform: string): string => {
    const pub = publications.find((p) => p.platform === platform);
    return pub?.caption ?? '';
  };

  const togglePlatform = (platform: string, on: boolean): void => {
    const next = on
      ? [...selected, platform]
      : selected.filter((p) => p !== platform);
    onOrganicPlatformsChanged(next);
  };

  const [tagDraft, setTagDraft] = useState(hashtags);
  useEffect(() => { setTagDraft(hashtags); }, [hashtags]);

  return (
    <div className="write">
      <div className="doc-lbl">
        {labelledForBoth ? (isAr ? 'الكابشن — للنشر العضوي' : 'Caption — for organic') : (isAr ? 'الكابشن' : 'Caption')}
      </div>

      {/* platform picker — captions show only for the platforms in play */}
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {selected.map((p) => (
            <button
              key={p}
              type="button"
              className="tag"
              style={{ cursor: 'pointer', borderColor: 'var(--copper)', color: 'var(--copper)' }}
              onClick={() => togglePlatform(p, false)}
              title={isAr ? 'إزالة هذه المنصة' : 'Remove this platform'}
            >
              {platformLabel(p, isAr)} ×
            </button>
          ))}
          {unselected.map((a) => (
            <button
              key={a.platform}
              type="button"
              className="tag tag-t"
              style={{ cursor: 'pointer' }}
              onClick={() => togglePlatform(a.platform, true)}
              title={isAr ? 'إضافة هذه المنصة' : 'Add this platform'}
            >
              + {platformLabel(a.platform, isAr)}
            </button>
          ))}
        </div>
      )}

      {selected.length === 0 ? (
        <p style={{ color: 'var(--mute)', fontSize: 13 }}>
          {canEdit
            ? (isAr ? 'اختر المنصات التي سيُنشر عليها هذا المحتوى.' : 'Pick the platforms this content will publish to.')
            : (isAr ? 'لم تُختَر منصات بعد.' : 'No platforms selected yet.')}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {selected.map((p) => (
            <CaptionRow
              key={p}
              contentId={contentId}
              platform={p}
              label={platformLabel(p, isAr)}
              manual={!AUTO_PLATFORMS.has(p)}
              value={captionOf(p)}
              canEdit={canEdit}
              isAr={isAr}
              onSaved={onPublicationsChanged}
              addToast={addToast}
            />
          ))}
        </div>
      )}

      {hasHashtags && selected.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
          <div className="k" style={{ marginBottom: 4 }}>
            {isAr ? 'الوسوم (تُضاف لكل المنصات عند النشر)' : 'Hashtags (added to every platform at publish)'}
          </div>
          {canEdit ? (
            <input
              className="inp"
              dir="rtl"
              style={{ fontSize: 12.5 }}
              value={tagDraft}
              placeholder={isAr ? '#الوسوم مفصولة بمسافة' : '#hashtags separated by spaces'}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={() => { if (tagDraft !== hashtags) onHashtagsChanged(tagDraft); }}
            />
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {hashtags.split(/\s+/).filter(Boolean).map((t) => <span key={t} className="tag">{t}</span>)}
              {!hashtags.trim() && <span style={{ color: 'var(--mute)', fontSize: 13 }}>—</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CaptionRow({
  contentId, platform, label, manual, value, canEdit, isAr, onSaved, addToast,
}: {
  contentId: string;
  platform: string;
  label: string;
  manual: boolean;
  value: string;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (pubs: MosPublication[]) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  const dirty = draft !== value;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await saveContentCaption(contentId, platform, draft);
      onSaved(res.publications);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fld">
      <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{label}</span>
        {manual && (
          <span className="tag tag-t" style={{ fontSize: 10 }}>{isAr ? 'يدوي' : 'manual'}</span>
        )}
        {canEdit && dirty && (
          <button
            type="button"
            className="btn btn-p btn-sm"
            style={{ marginInlineStart: 'auto' }}
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? (isAr ? '…' : '…') : (isAr ? 'حفظ' : 'Save')}
          </button>
        )}
      </div>
      {canEdit ? (
        <textarea
          className="inp"
          rows={2}
          style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <div className="v" style={{ whiteSpace: 'pre-line', lineHeight: 1.9 }}>{value || '—'}</div>
      )}
    </div>
  );
}

/* ══════════════════════ paid ══════════════════════ */

function PaidBlock({
  contentId, campaignId, canEdit, isAr, labelledForBoth,
}: {
  contentId: string;
  campaignId: string | null;
  canEdit: boolean;
  isAr: boolean;
  labelledForBoth: boolean;
}) {
  const [result, setResult] = useState<PaidAdsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchPaidAds(contentId)
      .then((r) => { if (alive) setResult(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [contentId, campaignId]);

  return (
    <div className="write">
      <div className="doc-lbl">
        {labelledForBoth ? (isAr ? 'نص الإعلان — للإعلانات المدفوعة' : 'Ad copy — for paid') : (isAr ? 'نص الإعلان المدفوع' : 'Paid ad copy')}
      </div>

      {loading && <p style={{ color: 'var(--mute)', fontSize: 13 }}>{isAr ? 'جارٍ التحميل…' : 'Loading…'}</p>}
      {error && <div className="notice">{error}</div>}

      {!loading && !error && !result?.campaign && (
        <p style={{ color: 'var(--mute)', fontSize: 13, lineHeight: 1.9 }}>
          {isAr
            ? 'اربط هذا المحتوى بحملة مدفوعة لكتابة نص الإعلان — يُكتب نص كل إعلان على مستوى تنفيذ الحملة.'
            : 'Link this content to a paid campaign to author ad copy — each ad’s copy is written at the campaign’s execution level.'}
        </p>
      )}

      {!loading && result?.campaign && result.items.length === 0 && (
        <p style={{ color: 'var(--mute)', fontSize: 13, lineHeight: 1.9 }}>
          {isAr
            ? 'لا توجد منصات إعلانية في هذه الحملة بعد — أضِف تنفيذًا في صفحة الحملة أولًا.'
            : 'This campaign has no ad platforms yet — add an execution on the campaign page first.'}
        </p>
      )}

      {!loading && result?.campaign && result.items.length > 0 && (
        <div style={{ display: 'grid', gap: 12 }}>
          {result.items.map((item) => (
            <AdCard
              key={item.execution.id}
              contentId={contentId}
              item={item}
              defaultDestination={result.campaign?.destination_url ?? ''}
              canEdit={canEdit}
              isAr={isAr}
              onSaved={setResult}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const AD_FIELDS: Array<{ key: keyof AdCreative; ar: string; en: string; long?: boolean }> = [
  { key: 'primary_text', ar: 'النص الأساسي', en: 'Primary text', long: true },
  { key: 'headline', ar: 'العنوان', en: 'Headline' },
  { key: 'description', ar: 'الوصف', en: 'Description' },
  { key: 'cta', ar: 'زر الحث (CTA)', en: 'Call to action' },
  { key: 'destination_url', ar: 'رابط الوجهة', en: 'Destination URL' },
];

function AdCard({
  contentId, item, defaultDestination, canEdit, isAr, onSaved,
}: {
  contentId: string;
  item: PaidAdExecItem;
  defaultDestination: string;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (r: PaidAdsResult) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const initial = useMemo<AdCreative>(() => ({
    primary_text: item.ad?.creative?.primary_text ?? '',
    headline: item.ad?.creative?.headline ?? '',
    description: item.ad?.creative?.description ?? '',
    cta: item.ad?.creative?.cta ?? '',
    destination_url: item.ad?.creative?.destination_url ?? (item.ad ? '' : defaultDestination),
  }), [item.ad, defaultDestination]);

  const [draft, setDraft] = useState<AdCreative>(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(initial); }, [initial]);
  const dirty = AD_FIELDS.some((f) => (draft[f.key] ?? '') !== (initial[f.key] ?? ''));

  const platform = platformLabel(item.execution.platform, isAr);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await saveAdCreative(contentId, item.execution.id, draft);
      onSaved(res);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="tag" style={{ borderColor: 'var(--copper)', color: 'var(--copper)' }}>{platform}</span>
        {item.execution.label && <span style={{ fontSize: 12, color: 'var(--mute)' }}>{item.execution.label}</span>}
        {canEdit && dirty && (
          <button
            type="button"
            className="btn btn-p btn-sm"
            style={{ marginInlineStart: 'auto' }}
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? '…' : (isAr ? 'حفظ' : 'Save')}
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {AD_FIELDS.map((f) => (
          <div key={f.key} className="fld">
            <div className="k">{isAr ? f.ar : f.en}</div>
            {canEdit ? (
              f.long ? (
                <textarea
                  className="inp"
                  rows={3}
                  style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8 }}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              ) : (
                <input
                  className="inp"
                  dir={f.key === 'destination_url' ? 'ltr' : undefined}
                  style={{ marginTop: 4, fontSize: 13 }}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              )
            ) : (
              <div className="v" style={{ whiteSpace: 'pre-line', lineHeight: 1.9 }}>{initial[f.key] || '—'}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
