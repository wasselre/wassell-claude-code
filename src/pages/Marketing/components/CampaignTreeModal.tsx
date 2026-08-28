/**
 * CampaignTreeModal — one-page nested Campaign → Ad Set → Ad entry.
 *
 * A fast bulk-entry path that lives ALONGSIDE the per-ad AdModal on the
 * execution detail page: instead of opening one ad at a time, a manager sets
 * up the platform campaign id, all its ad sets, and every ad under them in a
 * single form and saves the whole tree at once.
 *
 * Shape borrowed verbatim from CampaignContentBuilder: the component owns the
 * arrays, each row carries a local `key` from a useRef counter (the server
 * assigns real ids on save), and add / remove(key) / patch(key, over) helpers
 * mutate through onChange-style setState. Ad sets are child rows; each holds a
 * grandchild list of ads.
 *
 * Full-replace save: the WHOLE tree is sent every time (rows absent from the
 * payload are soft-archived server-side), so on save we send everything and
 * refresh from the returned payload.
 *
 * The important field is each ad's Ad ID (`platform_ad_id`, the Meta Ad ID) —
 * that is what inbound WhatsApp attribution resolves against, so it is marked
 * clearly and its uniqueness is validated before save.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  CampaignTree, MosApiError, MosContentRow, PLATFORM_LABELS,
  fetchCampaignTree, fetchContentList, saveCampaignTree,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { LoadError, Modal, Pill, Skeleton } from './kit';
import { IconPlus, IconTrash } from './icons';
import ContentPicker, { PickedAsset, ContentPickerValue } from './ContentPicker';

/** One ad row in local (controlled) state. `key` is local-only. */
interface AdRow {
  key: string;
  id?: string;
  label: string;
  platformAdId: string;
  contentId: string;
  /** LEGACY library asset carried in creative.asset_* (pre-2026-08-28 ads).
   *  Display-only in the picker; picking content clears it. */
  asset: PickedAsset | null;
  status: string;
  /** The ad's caption (creative.message). */
  caption: string;
  /** The rest of the ad's creative jsonb (format/CTA/…) preserved verbatim so a
   *  caption/asset edit here never clobbers fields set in the per-ad AdModal. */
  creativeExtra: Record<string, unknown>;
}

/** One ad-set row, holding its ads. `key` is local-only. */
interface AdSetRow {
  key: string;
  id?: string;
  name: string;
  platformAdsetId: string;
  ads: AdRow[];
}

/**
 * The middle-level vocabulary per platform. Meta (and Instagram, which rides
 * the Meta schema) → "Ad Set"; everything else → "Ad Group". The execution's
 * platform decides which.
 */
function midLevel(platform: string): {
  one_ar: string; one_en: string; id_ar: string; id_en: string; add_ar: string; add_en: string;
} {
  const isMeta = platform === 'meta' || platform === 'instagram';
  return isMeta
    ? {
        one_ar: 'مجموعة إعلانية', one_en: 'Ad Set',
        id_ar: 'معرّف المجموعة الإعلانية', id_en: 'Ad Set ID',
        add_ar: '+ إضافة مجموعة إعلانية', add_en: '+ Add Ad Set',
      }
    : {
        one_ar: 'المجموعة الإعلانية', one_en: 'Ad Group',
        id_ar: 'معرّف المجموعة الإعلانية', id_en: 'Ad Group ID',
        add_ar: '+ إضافة مجموعة إعلانية', add_en: '+ Add Ad Group',
      };
}

interface CampaignTreeModalProps {
  executionId: string;
  platform: string;
  onClose: () => void;
  onSaved?: () => void;
}

export default function CampaignTreeModal({
  executionId, platform, onClose, onSaved,
}: CampaignTreeModalProps): JSX.Element {
  const addToast = useAppStore((s) => s.addToast);
  const { isAr } = useWorkspace();
  const term = midLevel(platform);

  const seq = useRef(0);
  const newKey = (): string => { seq.current += 1; return `t${seq.current}`; };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tree, setTree] = useState<CampaignTree | null>(null);
  const [adSets, setAdSets] = useState<AdSetRow[]>([]);
  /** Ads with ad_set_id === null — shown in a non-deletable "Unassigned" group. */
  const [looseAds, setLooseAds] = useState<AdRow[]>([]);
  const [content, setContent] = useState<MosContentRow[]>([]);
  /** Ad `key`s whose Ad ID collides with another ad — inline error markers. */
  const [dupKeys, setDupKeys] = useState<Set<string>>(new Set());

  const toAdRow = useCallback((a: CampaignTree['ads'][number]): AdRow => {
    const cr = (a.creative ?? {}) as Record<string, unknown>;
    const caption = typeof cr.message === 'string' ? cr.message : '';
    const asset: PickedAsset | null = typeof cr.asset_id === 'string'
      ? {
          id: cr.asset_id,
          title: typeof cr.asset_title === 'string' ? cr.asset_title : cr.asset_id,
          url: typeof cr.asset_url === 'string' ? cr.asset_url : null,
          thumb: typeof cr.asset_thumb === 'string' ? cr.asset_thumb : null,
        }
      : null;
    const creativeExtra = { ...cr };
    delete creativeExtra.message;
    delete creativeExtra.asset_id;
    delete creativeExtra.asset_title;
    delete creativeExtra.asset_url;
    delete creativeExtra.asset_thumb;
    return {
      key: newKey(),
      id: a.id,
      label: a.label ?? '',
      platformAdId: a.platform_ad_id ?? '',
      contentId: a.content_id ?? '',
      asset,
      status: a.status ?? 'waiting',
      caption,
      creativeExtra,
    };
  }, []);

  const hydrate = useCallback((t: CampaignTree): void => {
    setTree(t);
    const sets = [...t.ad_sets].sort((a, b) => a.sort_order - b.sort_order).map<AdSetRow>((s) => ({
      key: newKey(),
      id: s.id,
      name: s.name ?? '',
      platformAdsetId: s.platform_adset_id ?? '',
      ads: t.ads.filter((a) => a.ad_set_id === s.id).map(toAdRow),
    }));
    setAdSets(sets);
    setLooseAds(t.ads.filter((a) => a.ad_set_id === null).map(toAdRow));
    setDupKeys(new Set());
  }, [toAdRow]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [t, list] = await Promise.all([
        fetchCampaignTree(executionId),
        fetchContentList({ limit: 300 }).catch(() => ({ content: [] as MosContentRow[] })),
      ]);
      hydrate(t);
      // Favor this campaign's content in the picker, then the rest (same order
      // as the per-ad AdModal).
      const cid = t.execution.campaign_id;
      const mine = list.content.filter((c) => c.campaign_id === cid);
      const rest = list.content.filter((c) => c.campaign_id !== cid);
      setContent([...mine, ...rest]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [executionId, hydrate]);

  useEffect(() => { void load(); }, [load]);

  /* ── ad-set + ad mutations ─────────────────────────────────────── */

  const blankAd = (): AdRow => ({
    key: newKey(), label: '', platformAdId: '', contentId: '', asset: null,
    status: 'waiting', caption: '', creativeExtra: {},
  });

  const addAdSet = (): void => setAdSets((cur) => [
    ...cur,
    { key: newKey(), name: '', platformAdsetId: '', ads: [blankAd()] },
  ]);
  const removeAdSet = (key: string): void =>
    setAdSets((cur) => cur.filter((s) => s.key !== key));
  const patchAdSet = (key: string, over: Partial<Omit<AdSetRow, 'key' | 'ads'>>): void =>
    setAdSets((cur) => cur.map((s) => (s.key === key ? { ...s, ...over } : s)));

  const addAd = (setKey: string): void =>
    setAdSets((cur) => cur.map((s) => (s.key === setKey ? { ...s, ads: [...s.ads, blankAd()] } : s)));
  const removeAd = (setKey: string, adKey: string): void =>
    setAdSets((cur) => cur.map((s) => (
      s.key === setKey ? { ...s, ads: s.ads.filter((a) => a.key !== adKey) } : s
    )));
  const patchAd = (setKey: string, adKey: string, over: Partial<Omit<AdRow, 'key'>>): void =>
    setAdSets((cur) => cur.map((s) => (
      s.key === setKey
        ? { ...s, ads: s.ads.map((a) => (a.key === adKey ? { ...a, ...over } : a)) }
        : s
    )));

  /** Move a loose ad into an ad set — preserves its id so the server just
   *  reassigns ad_set_id (no data loss). */
  const moveLooseTo = (adKey: string, setKey: string): void => {
    const ad = looseAds.find((a) => a.key === adKey);
    if (!ad) return;
    setLooseAds((cur) => cur.filter((a) => a.key !== adKey));
    setAdSets((cur) => cur.map((s) => (s.key === setKey ? { ...s, ads: [...s.ads, ad] } : s)));
  };
  const patchLoose = (adKey: string, over: Partial<Omit<AdRow, 'key'>>): void =>
    setLooseAds((cur) => cur.map((a) => (a.key === adKey ? { ...a, ...over } : a)));

  /* ── validation + save ─────────────────────────────────────────── */

  /** Ad-id collisions across EVERY ad (sets + loose). Non-empty ids only. */
  const computeDupKeys = (): Set<string> => {
    const byId = new Map<string, string[]>();
    const push = (a: AdRow): void => {
      const v = a.platformAdId.trim();
      if (!v) return;
      byId.set(v, [...(byId.get(v) ?? []), a.key]);
    };
    adSets.forEach((s) => s.ads.forEach(push));
    looseAds.forEach(push);
    const dup = new Set<string>();
    byId.forEach((keys) => { if (keys.length > 1) keys.forEach((k) => dup.add(k)); });
    return dup;
  };

  const dups = useMemo(computeDupKeys, [adSets, looseAds]);

  const save = async (): Promise<void> => {
    // Names required per set and per ad.
    const namelessSet = adSets.find((s) => s.name.trim() === '');
    if (namelessSet) {
      addToast(
        isAr ? `${term.one_ar}: الاسم مطلوب.` : `${term.one_en}: a name is required.`,
        'error',
      );
      return;
    }
    const anySetNamelessAd = adSets.some((s) => s.ads.some((a) => a.label.trim() === ''));
    const anyLooseNamelessAd = looseAds.some((a) => a.label.trim() === '');
    if (anySetNamelessAd || anyLooseNamelessAd) {
      addToast(isAr ? 'كل إعلان يحتاج اسمًا.' : 'Every ad needs a name.', 'error');
      return;
    }
    if (dups.size > 0) {
      setDupKeys(dups);
      addToast(
        isAr ? 'يوجد معرّف إعلان مكرّر — يجب أن يكون كل معرّف فريدًا.'
          : 'A duplicate Ad ID exists — each Ad ID must be unique.',
        'error',
      );
      return;
    }
    setDupKeys(new Set());

    setBusy(true);
    try {
      const t = await saveCampaignTree({
        execution_id: executionId,
        // platform_campaign_id is Meta-owned (set by the push) — not sent from
        // here, so this save never touches it.
        ad_sets: adSets.map((s, i) => ({
          ...(s.id ? { id: s.id } : {}),
          name: s.name.trim(),
          platform_adset_id: s.platformAdsetId.trim() || null,
          sort_order: i,
          ads: s.ads.map((a) => {
            const cap = a.caption.trim();
            // Fold caption + the chosen library asset back into the preserved
            // creative jsonb; only send `creative` when there's something to
            // store (so we never write an empty object over a null).
            const assetKeys = a.asset
              ? {
                  asset_id: a.asset.id,
                  asset_title: a.asset.title,
                  ...(a.asset.url ? { asset_url: a.asset.url } : {}),
                  ...(a.asset.thumb ? { asset_thumb: a.asset.thumb } : {}),
                }
              : {};
            const merged = { ...a.creativeExtra, ...(cap ? { message: cap } : {}), ...assetKeys };
            const creative = Object.keys(merged).length > 0 ? merged : undefined;
            return {
              ...(a.id ? { id: a.id } : {}),
              label: a.label.trim(),
              platform_ad_id: a.platformAdId.trim() || null,
              content_id: a.contentId || null,
              status: a.status,
              ...(creative ? { creative } : {}),
            };
          }),
        })),
      });
      hydrate(t);
      addToast(isAr ? 'حُفظت الحملة.' : 'Campaign saved.', 'success');
      onSaved?.();
      onClose();
    } catch (e) {
      // Surface the server's own uniqueness / validation error too — never swallow.
      const msg = e instanceof MosApiError
        ? e.message
        : e instanceof Error ? e.message : String(e);
      addToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── render ────────────────────────────────────────────────────── */

  const platformLabel = (isAr ? PLATFORM_LABELS[platform]?.ar : PLATFORM_LABELS[platform]?.en) ?? platform;
  const execLabel = tree?.execution.label || platformLabel;

  const contentOptions = (
    <>
      <option value="">{isAr ? 'بدون محتوى' : 'No content'}</option>
      {content.map((c) => (
        <option key={c.id} value={c.id}>{c.ref ? `${c.ref} · ${c.title}` : c.title}</option>
      ))}
    </>
  );

  const totalAds = adSets.reduce((n, s) => n + s.ads.length, 0) + looseAds.length;

  return (
    <Modal
      title={isAr ? 'المجموعات والإعلانات' : 'Ad sets & ads'}
      sub={isAr
        ? 'حملة ← مجموعات إعلانية ← إعلانات (المحتوى + الكابشن)، كلها في صفحة واحدة. يُحفظ الشجرة كاملة في كل مرة.'
        : 'Campaign → ad sets → ads (content + caption), all on one page. The whole tree is saved every time.'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="note">
            {isAr
              ? 'معرّف الإعلان هو ما تُنسب إليه رسائل واتساب الواردة — اجعله مطابقًا لمعرّف ميتا.'
              : 'The Ad ID is what inbound WhatsApp is attributed to — make it match the Meta Ad ID.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            onClick={() => void save()}
            disabled={busy || loading || !!error}
          >
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ الحملة' : 'Save campaign'}
          </button>
        </>
      }
    >
      {loading ? (
        <Skeleton rows={6} />
      ) : error ? (
        <LoadError message={error} onRetry={() => void load()} isAr={isAr} />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* ── Campaign (execution) row ─────────────────────────── */}
          <div
            style={{
              display: 'grid', gap: 9, padding: 12, borderRadius: 10,
              border: '1px solid var(--line, rgba(255,255,255,0.10))',
              background: 'var(--panel, rgba(255,255,255,0.03))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>{isAr ? 'الحملة' : 'Campaign'}</span>
              <b style={{ fontSize: 14 }}>{execLabel}</b>
              <Pill tone="live">{platformLabel}</Pill>
            </div>
            {/* The Meta campaign id is NOT a planning input — it's created by
                «الإنشاء في ميتا» and synced back. Show it read-only; before the
                push it simply doesn't exist yet. */}
            <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
              {tree?.execution.platform_campaign_id
                ? <>{isAr ? 'مربوطة بميتا' : 'Linked to Meta'}{' '}<span className="ltr">#{tree.execution.platform_campaign_id}</span></>
                : (isAr
                    ? 'تُنشأ في ميتا عند «الإنشاء في ميتا» — لا حاجة لإدخال معرّف هنا.'
                    : 'Created in Meta on «Create in Meta» — no id to enter here.')}
            </div>
          </div>

          {/* ── Unassigned (loose) ads ───────────────────────────── */}
          {looseAds.length > 0 && (
            <div style={{ border: '1px solid var(--line, rgba(255,255,255,0.10))', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '9px 11px', background: 'var(--panel, rgba(255,255,255,0.03))' }}>
                <b style={{ fontSize: 13 }}>{isAr ? 'إعلانات غير مصنّفة' : 'Unassigned ads'}</b>
                <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 3 }}>
                  {isAr
                    ? `هذه الإعلانات ليست ضمن ${term.one_ar}. انقلها إلى مجموعة قبل الحفظ — وإلا فستُؤرشف.`
                    : `These ads are not in an ${term.one_en.toLowerCase()}. Move them into one before saving — otherwise they are archived.`}
                </div>
              </div>
              <div style={{ display: 'grid', gap: 8, padding: 11 }}>
                {looseAds.map((a) => (
                  <div
                    key={a.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(120px,1fr) 150px 160px 190px',
                      gap: 8, alignItems: 'end',
                    }}
                  >
                    <label style={{ display: 'grid', gap: 3 }}>
                      <span className="lbl">{isAr ? 'اسم الإعلان' : 'Ad name'}</span>
                      <input
                        className="inp"
                        value={a.label}
                        onChange={(e) => patchLoose(a.key, { label: e.target.value })}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 3 }}>
                      <span className="lbl">{isAr ? 'معرّف الإعلان' : 'Ad ID'}</span>
                      <input
                        className={`inp ltr${dupKeys.has(a.key) ? ' bad' : ''}`}
                        style={dupKeys.has(a.key) ? { borderColor: 'var(--late)' } : undefined}
                        value={a.platformAdId}
                        onChange={(e) => patchLoose(a.key, { platformAdId: e.target.value })}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 3 }}>
                      <span className="lbl">{isAr ? 'المحتوى' : 'Content'}</span>
                      <select
                        className="inp"
                        value={a.contentId}
                        onChange={(e) => patchLoose(a.key, { contentId: e.target.value })}
                      >
                        {contentOptions}
                      </select>
                    </label>
                    <label style={{ display: 'grid', gap: 3 }}>
                      <span className="lbl">{isAr ? 'انقل إلى' : 'Move into'}</span>
                      <select
                        className="inp"
                        value=""
                        disabled={adSets.length === 0}
                        onChange={(e) => { if (e.target.value) moveLooseTo(a.key, e.target.value); }}
                      >
                        <option value="">
                          {adSets.length === 0
                            ? (isAr ? `أضف ${term.one_ar} أولًا` : `Add an ${term.one_en.toLowerCase()} first`)
                            : (isAr ? `اختر ${term.one_ar}…` : `Choose an ${term.one_en.toLowerCase()}…`)}
                        </option>
                        {adSets.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.name.trim() || (isAr ? '(بلا اسم)' : '(unnamed)')}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Ad Sets ──────────────────────────────────────────── */}
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="lbl">
              {isAr ? `المجموعات الإعلانية · ${totalAds} إعلان` : `Ad sets · ${totalAds} ads`}
            </div>

            {adSets.length === 0 && looseAds.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--mute)', padding: '4px 2px' }}>
                {isAr
                  ? `لا توجد ${term.one_ar} بعد. أضف واحدة للبدء.`
                  : `No ${term.one_en.toLowerCase()}s yet. Add one to begin.`}
              </div>
            )}

            {adSets.map((s) => (
              <div
                key={s.key}
                style={{ border: '1px solid var(--line, rgba(255,255,255,0.10))', borderRadius: 10, overflow: 'hidden' }}
              >
                <div
                  style={{
                    display: 'grid', gridTemplateColumns: 'minmax(140px,1fr) 34px',
                    gap: 8, alignItems: 'end', padding: '10px 11px',
                    background: 'var(--panel, rgba(255,255,255,0.03))',
                  }}
                >
                  {/* The ad set's Meta id (platform_adset_id) is filled by the
                      push, not entered here — only the name is a planning input. */}
                  <label style={{ display: 'grid', gap: 3 }}>
                    <span className="lbl">{isAr ? `اسم ${term.one_ar}` : `${term.one_en} name`}</span>
                    <input
                      className="inp"
                      value={s.name}
                      onChange={(e) => patchAdSet(s.key, { name: e.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-d btn-sm"
                    title={isAr ? `حذف ${term.one_ar}` : `Remove ${term.one_en.toLowerCase()}`}
                    onClick={() => removeAdSet(s.key)}
                  >
                    <IconTrash />
                  </button>
                </div>

                {/* Ads under this set */}
                <div style={{ display: 'grid', gap: 8, padding: 11 }}>
                  {s.ads.length === 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                      {isAr ? 'لا إعلانات في هذه المجموعة.' : 'No ads in this set.'}
                    </div>
                  )}
                  {s.ads.map((a) => (
                    <div
                      key={a.key}
                      style={{
                        display: 'grid', gap: 7, padding: 9, borderRadius: 8,
                        border: '1px solid var(--line, rgba(255,255,255,0.08))',
                        background: 'var(--paper, transparent)',
                      }}
                    >
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(110px,1fr) 34px',
                          gap: 8, alignItems: 'end',
                        }}
                      >
                        <label style={{ display: 'grid', gap: 3 }}>
                          <span className="lbl">{isAr ? 'اسم الإعلان' : 'Ad name'}</span>
                          <input
                            className="inp"
                            value={a.label}
                            onChange={(e) => patchAd(s.key, a.key, { label: e.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-d btn-sm"
                          title={isAr ? 'إزالة الإعلان' : 'Remove ad'}
                          onClick={() => removeAd(s.key, a.key)}
                        >
                          <IconTrash />
                        </button>
                      </div>
                      <div style={{ display: 'grid', gap: 3 }}>
                        <span className="lbl">{isAr ? 'المحتوى — سجل من قائمة المحتوى' : 'Content — a record from the content list'}</span>
                        <ContentPicker
                          value={{ contentId: a.contentId, asset: a.asset }}
                          contentOptions={content}
                          isAr={isAr}
                          onChange={(v: ContentPickerValue) =>
                            patchAd(s.key, a.key, { contentId: v.contentId, asset: v.asset })}
                        />
                      </div>
                      <label style={{ display: 'grid', gap: 3 }}>
                        <span className="lbl">{isAr ? 'النص الإعلاني (الكابشن)' : 'Caption'}</span>
                        <textarea
                          className="inp"
                          rows={2}
                          value={a.caption}
                          placeholder={isAr ? 'نص الإعلان الظاهر مع المحتوى' : 'the ad copy shown with the content'}
                          onChange={(e) => patchAd(s.key, a.key, { caption: e.target.value })}
                        />
                      </label>
                      {/* Meta Ad ID — OPTIONAL, and a LATER step: it exists only
                          after the ad is created in Meta, and it's what inbound
                          WhatsApp attribution resolves against. Not a planning
                          input, so it's small and clearly optional here. */}
                      <label style={{ display: 'grid', gap: 3 }}>
                        <span className="lbl" style={{ color: 'var(--mute)' }}>
                          {isAr ? 'معرّف إعلان ميتا · اختياري (للنسب)' : 'Meta Ad ID · optional (attribution)'}
                        </span>
                        <input
                          className="inp ltr"
                          style={dupKeys.has(a.key) ? { borderColor: 'var(--late)' } : undefined}
                          placeholder={isAr ? 'يُضاف بعد إنشاء الإعلان في ميتا' : 'added after the ad exists in Meta'}
                          value={a.platformAdId}
                          onChange={(e) => patchAd(s.key, a.key, { platformAdId: e.target.value })}
                        />
                      </label>
                    </div>
                  ))}
                  {dupKeys.size > 0 && s.ads.some((a) => dupKeys.has(a.key)) && (
                    <div style={{ fontSize: 11.5, color: 'var(--late)' }}>
                      {isAr ? 'معرّف إعلان مكرّر في هذه المجموعة.' : 'A duplicate Ad ID is highlighted above.'}
                    </div>
                  )}
                  <div>
                    <button type="button" className="fbtn" onClick={() => addAd(s.key)}>
                      {isAr ? '+ إضافة إعلان' : '+ Add Ad'}
                    </button>
                  </div>
                </div>
              </div>
            ))}

            <div>
              <button type="button" className="fbtn on" onClick={addAdSet}>
                <IconPlus /> {isAr ? term.add_ar : term.add_en}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
