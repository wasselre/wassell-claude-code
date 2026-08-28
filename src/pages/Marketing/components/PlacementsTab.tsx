/**
 * The Placements tab — one creative, many placements (2026-08-28).
 *
 * A creative (mos_content) is a STANDALONE record. Its `campaign_id` is only
 * provenance ("where it was born") — it does NOT decide where the creative can
 * run. Each placement carries its OWN destination:
 *
 *   organic → an mos_publications row: platform + account + caption + schedule +
 *             the approved file + the publish/schedule action, optionally linked
 *             to an ORGANIC campaign (or none). This is the FULL publish surface
 *             (the old «النشر» tab, merged in here so a placement is one complete
 *             thing) — reused via <PublishTab>. The workspace Publishing Board
 *             stays as the cross-content calendar.
 *   paid    → an mos_execution_ads row under any paid campaign's execution + ad
 *             set. You attach to an existing (unlinked) ad or add a new one.
 *
 * `purpose` is derived (in mos_content_v) from the placements that exist.
 * Writes go through `write_content`- / `schedule`-gated actions.
 */
import { useEffect, useState } from 'react';
import {
  AdCreative, MosAccount, MosPublication, PaidPlacement, PaidPlacementTarget, PLATFORM_LABELS,
  fetchPaidAds, fetchPaidPlacementTargets, removePaidPlacement, saveAdCreative,
} from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';
import PublishTab from './PublishTab';

const platformLabel = (p: string, isAr: boolean): string => {
  const l = PLATFORM_LABELS[p];
  return l ? (isAr ? l.ar : l.en) : p;
};

export default function PlacementsTab({
  contentId, hasHashtags, accounts, publications, hashtags,
  canEdit, canPublish, isAr, onPublicationsChanged, onHashtagsChanged, onOrganicPlatformsChanged,
}: {
  contentId: string;
  hasHashtags: boolean;
  accounts: MosAccount[];
  publications: MosPublication[];
  hashtags: string;
  /** Author copy / paid placements (write_content). */
  canEdit: boolean;
  /** Publish / schedule the organic placements (schedule | publish). */
  canPublish: boolean;
  isAr: boolean;
  onPublicationsChanged: (pubs: MosPublication[]) => void;
  onHashtagsChanged: (value: string) => void;
  /** Keep organic_platforms in sync with the platforms that have publications, so
   *  the derived purpose and every other reader stay correct. */
  onOrganicPlatformsChanged: (platforms: string[]) => void;
}) {
  const handleOrganicChange = (pubs: MosPublication[]): void => {
    onPublicationsChanged(pubs);
    onOrganicPlatformsChanged([...new Set(pubs.map((p) => p.platform))]);
  };

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <div>
        <div className="doc-lbl" style={{ marginBottom: 8 }}>
          {isAr ? 'أماكن النشر العضوية' : 'Organic placements'}
        </div>
        {/* The full publish surface — caption, file, schedule, publish, status,
            and the organic-campaign link — so a placement is one complete thing. */}
        <PublishTab
          contentId={contentId}
          publications={publications}
          accounts={accounts}
          canEdit={canPublish || canEdit}
          isAr={isAr}
          onChange={handleOrganicChange}
        />
        {hasHashtags && publications.length > 0 && (
          <HashtagsEditor hashtags={hashtags} canEdit={canEdit} isAr={isAr} onChange={onHashtagsChanged} />
        )}
      </div>

      <PaidPlacements contentId={contentId} canEdit={canEdit} isAr={isAr} />
    </div>
  );
}

function HashtagsEditor({
  hashtags, canEdit, isAr, onChange,
}: {
  hashtags: string;
  canEdit: boolean;
  isAr: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(hashtags);
  useEffect(() => { setDraft(hashtags); }, [hashtags]);

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
      <div className="k" style={{ marginBottom: 4 }}>
        {isAr ? 'الوسوم (تُضاف لكل المنصات عند النشر)' : 'Hashtags (added to every platform at publish)'}
      </div>
      {canEdit ? (
        <input
          className="inp"
          dir="rtl"
          style={{ fontSize: 12.5 }}
          value={draft}
          placeholder={isAr ? '#الوسوم مفصولة بمسافة' : '#hashtags separated by spaces'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== hashtags) onChange(draft); }}
        />
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {hashtags.split(/\s+/).filter(Boolean).map((t) => <span key={t} className="tag">{t}</span>)}
          {!hashtags.trim() && <span style={{ color: 'var(--mute)', fontSize: 13 }}>—</span>}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════ paid ══════════════════════ */

function PaidPlacements({
  contentId, canEdit, isAr,
}: {
  contentId: string;
  canEdit: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [placements, setPlacements] = useState<PaidPlacement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchPaidAds(contentId)
      .then((r) => { if (alive) setPlacements(r.placements); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [contentId]);

  return (
    <div className="write">
      <div className="doc-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{isAr ? 'أماكن الإعلان المدفوع' : 'Paid placements'}</span>
        {canEdit && !adding && (
          <button
            type="button"
            className="btn btn-p btn-sm"
            style={{ marginInlineStart: 'auto' }}
            onClick={() => setAdding(true)}
          >
            {isAr ? '+ إضافة إعلان مدفوع' : '+ Add paid'}
          </button>
        )}
      </div>

      {error && <div className="notice">{error}</div>}

      {placements && placements.length === 0 && !adding && (
        <p style={{ color: 'var(--mute)', fontSize: 13, lineHeight: 1.9 }}>
          {canEdit
            ? (isAr ? 'أضِف إعلانًا مدفوعًا لتشغيل هذا المحتوى ضمن حملة إعلانية ومجموعة إعلانية.'
                    : 'Add a paid placement to run this creative inside a paid ad campaign + ad set.')
            : (isAr ? 'لا توجد أماكن إعلان مدفوع بعد.' : 'No paid placements yet.')}
        </p>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {(placements ?? []).map((p) => (
          <PaidCard
            key={p.id}
            contentId={contentId}
            placement={p}
            canEdit={canEdit}
            isAr={isAr}
            onChanged={setPlacements}
            addToast={addToast}
          />
        ))}
      </div>

      {adding && (
        <AddPaid
          contentId={contentId}
          isAr={isAr}
          onCancel={() => setAdding(false)}
          onSaved={(pls) => { setPlacements(pls); setAdding(false); }}
          addToast={addToast}
        />
      )}
    </div>
  );
}

function PaidCard({
  contentId, placement, canEdit, isAr, onChanged, addToast,
}: {
  contentId: string;
  placement: PaidPlacement;
  canEdit: boolean;
  isAr: boolean;
  onChanged: (pls: PaidPlacement[]) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [text, setText] = useState(placement.creative?.primary_text ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(placement.creative?.primary_text ?? ''); }, [placement]);
  const dirty = text !== (placement.creative?.primary_text ?? '');

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const creative: AdCreative = { primary_text: text };
      const res = await saveAdCreative(contentId, { adId: placement.id }, creative);
      onChanged(res.placements);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm(isAr ? 'إزالة هذا الإعلان المدفوع؟' : 'Remove this paid placement?')) return;
    setBusy(true);
    try {
      const res = await removePaidPlacement(contentId, placement.id);
      onChanged(res.placements);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="tag" style={{ borderColor: 'var(--copper)', color: 'var(--copper)' }}>
          {platformLabel(placement.execution.platform, isAr)}
        </span>
        {placement.execution.campaign_name && (
          <span style={{ fontSize: 12, color: 'var(--mute)' }}>{placement.execution.campaign_name}</span>
        )}
        {placement.ad_set_name && (
          <span className="tag tag-t" style={{ fontSize: 10 }}>{placement.ad_set_name}</span>
        )}
        {canEdit && (
          <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
            {dirty && (
              <button type="button" className="btn btn-p btn-sm" onClick={() => void save()} disabled={busy}>
                {busy ? '…' : (isAr ? 'حفظ' : 'Save')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              style={{ color: 'var(--danger, #b04242)' }}
              onClick={() => void remove()}
              disabled={busy}
              title={isAr ? 'إزالة' : 'Remove'}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <div className="fld">
        <div className="k">{isAr ? 'نص الإعلان' : 'Ad text'}</div>
        {canEdit ? (
          <textarea
            className="inp"
            rows={3}
            style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div className="v" style={{ whiteSpace: 'pre-line', lineHeight: 1.9 }}>{placement.creative?.primary_text || '—'}</div>
        )}
      </div>
    </div>
  );
}

function AddPaid({
  contentId, isAr, onCancel, onSaved, addToast,
}: {
  contentId: string;
  isAr: boolean;
  onCancel: () => void;
  onSaved: (pls: PaidPlacement[]) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [targets, setTargets] = useState<PaidPlacementTarget[] | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [executionId, setExecutionId] = useState('');
  const [adSetChoice, setAdSetChoice] = useState(''); // an ad-set id, '__new__', or '' (none)
  const [newSetName, setNewSetName] = useState('');
  const [adChoice, setAdChoice] = useState('__new__'); // an existing UNLINKED ad id, or '__new__'
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchPaidPlacementTargets()
      .then((r) => { if (alive) setTargets(r.campaigns); })
      .catch((e) => { if (alive) addToast(e instanceof Error ? e.message : String(e), 'error'); });
    return () => { alive = false; };
  }, [addToast]);

  const campaign = targets?.find((c) => c.id === campaignId) ?? null;
  const execution = campaign?.executions.find((e) => e.id === executionId) ?? null;
  const adSet = adSetChoice && adSetChoice !== '__new__'
    ? execution?.ad_sets.find((s) => s.id === adSetChoice) ?? null
    : null;
  // Attaching to an existing ad only makes sense for a real (existing) ad set.
  const attachableAds = adSet?.ads.filter((a) => !a.linked) ?? [];

  const save = async (): Promise<void> => {
    if (!executionId) { addToast(isAr ? 'اختر حملة ومنصة إعلانية' : 'Pick a campaign and ad platform', 'error'); return; }
    if (adSetChoice === '__new__' && !newSetName.trim()) {
      addToast(isAr ? 'اكتب اسم المجموعة الإعلانية' : 'Name the new ad set', 'error'); return;
    }
    setBusy(true);
    try {
      // Attach to an existing ad, OR add a new ad (optionally in a new set).
      const target = adChoice !== '__new__'
        ? { adId: adChoice }
        : {
            executionId,
            ...(adSetChoice === '__new__'
              ? { newAdSetName: newSetName.trim() }
              : adSetChoice ? { adSetId: adSetChoice } : {}),
          };
      const res = await saveAdCreative(contentId, target, text ? { primary_text: text } : {});
      onSaved(res.placements);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px dashed var(--copper)', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div className="k" style={{ marginBottom: 8 }}>{isAr ? 'إعلان مدفوع جديد' : 'New paid placement'}</div>
      {targets === null ? (
        <p style={{ color: 'var(--mute)', fontSize: 13 }}>{isAr ? 'جارٍ التحميل…' : 'Loading…'}</p>
      ) : targets.length === 0 ? (
        <p style={{ color: 'var(--mute)', fontSize: 13, lineHeight: 1.9 }}>
          {isAr ? 'لا توجد حملات مدفوعة بعد — أنشئ حملة مدفوعة أولًا.' : 'No paid campaigns yet — create a paid campaign first.'}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="fld">
            <div className="k">{isAr ? 'الحملة الإعلانية المدفوعة' : 'Paid ad campaign'}</div>
            <select
              className="inp"
              style={{ marginTop: 4 }}
              value={campaignId}
              onChange={(e) => { setCampaignId(e.target.value); setExecutionId(''); setAdSetChoice(''); setAdChoice('__new__'); }}
            >
              <option value="">{isAr ? '— اختر —' : '— pick —'}</option>
              {targets.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {campaign && (
            <div className="fld">
              <div className="k">{isAr ? 'المنصة الإعلانية (التنفيذ)' : 'Ad platform (execution)'}</div>
              {campaign.executions.length === 0 ? (
                <p style={{ color: 'var(--mute)', fontSize: 12.5 }}>
                  {isAr ? 'لا توجد منصات إعلانية في هذه الحملة — أضِفها من صفحة الحملة.' : 'This campaign has no ad platforms — add one on the campaign page.'}
                </p>
              ) : (
                <select
                  className="inp"
                  style={{ marginTop: 4 }}
                  value={executionId}
                  onChange={(e) => { setExecutionId(e.target.value); setAdSetChoice(''); setAdChoice('__new__'); }}
                >
                  <option value="">{isAr ? '— اختر —' : '— pick —'}</option>
                  {campaign.executions.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {platformLabel(ex.platform, isAr)}{ex.label ? ` · ${ex.label}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {execution && (
            <div className="fld">
              <div className="k">{isAr ? 'المجموعة الإعلانية' : 'Ad set'}</div>
              <select
                className="inp"
                style={{ marginTop: 4 }}
                value={adSetChoice}
                onChange={(e) => { setAdSetChoice(e.target.value); setAdChoice('__new__'); }}
              >
                <option value="">{isAr ? 'بدون مجموعة' : 'No ad set'}</option>
                {execution.ad_sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value="__new__">{isAr ? '＋ مجموعة إعلانية جديدة' : '＋ New ad set'}</option>
              </select>
              {adSetChoice === '__new__' && (
                <input
                  className="inp"
                  style={{ marginTop: 6, fontSize: 12.5 }}
                  value={newSetName}
                  placeholder={isAr ? 'اسم المجموعة الإعلانية' : 'Ad set name'}
                  onChange={(e) => setNewSetName(e.target.value)}
                />
              )}
            </div>
          )}

          {/* Attach to an existing ad, or add a new one — only when a real ad set
              with unlinked ads is chosen. */}
          {adSet && attachableAds.length > 0 && (
            <div className="fld">
              <div className="k">{isAr ? 'الإعلان' : 'Ad'}</div>
              <select
                className="inp"
                style={{ marginTop: 4 }}
                value={adChoice}
                onChange={(e) => setAdChoice(e.target.value)}
              >
                <option value="__new__">{isAr ? '＋ إعلان جديد' : '＋ New ad'}</option>
                {attachableAds.map((a) => (
                  <option key={a.id} value={a.id}>
                    {isAr ? 'ربط بـ: ' : 'Attach to: '}{a.label || (a.platform_ad_id ? `#${a.platform_ad_id}` : a.id.slice(0, 8))}
                  </option>
                ))}
              </select>
            </div>
          )}

          {execution && (
            <div className="fld">
              <div className="k">{isAr ? 'نص الإعلان (اختياري)' : 'Ad text (optional)'}</div>
              <textarea
                className="inp"
                rows={3}
                style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8 }}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button type="button" className="btn btn-p btn-sm" onClick={() => void save()} disabled={busy || !executionId}>
              {busy ? '…' : (isAr ? 'إضافة' : 'Add')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
