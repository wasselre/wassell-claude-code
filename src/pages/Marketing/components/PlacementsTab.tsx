/**
 * The Placements tab — one creative, many placements (2026-08-28).
 *
 * A creative (mos_content) is a STANDALONE record. Its `campaign_id` is only
 * provenance ("where it was born") — it does NOT decide where the creative can
 * run. Each placement carries its OWN destination:
 *
 *   organic → an mos_publications row: platform + account + caption + schedule,
 *             optionally linked to an ORGANIC campaign (or none). This is the
 *             same row the Publishing board schedules and bundle.social posts —
 *             so adding one here is just a FASTER door into the organic section.
 *   paid    → an mos_execution_ads row under any paid campaign's execution +
 *             ad set. The old "must match the content's campaign" rule is gone.
 *
 * `purpose` is no longer chosen — it is derived (in mos_content_v) from the
 * placements that exist. Writes go through `write_content`-gated actions.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AdCreative, MosAccount, MosCampaign, MosPublication,
  PaidPlacement, PaidPlacementTarget, PLATFORM_LABELS,
  fetchCampaigns, fetchPaidAds, fetchPaidPlacementTargets,
  removePaidPlacement, removePublication, saveAdCreative, savePublication,
  saveCampaign,
} from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';
import { isoDateTimeLocal } from '../lib/format';

/** Platforms that publish ORGANICALLY (a caption lands verbatim). */
const ORGANIC_PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube'];
const AUTO_PLATFORMS = new Set(['instagram', 'tiktok', 'snapchat']);

const platformLabel = (p: string, isAr: boolean): string => {
  const l = PLATFORM_LABELS[p];
  return l ? (isAr ? l.ar : l.en) : p;
};

export default function PlacementsTab({
  contentId, hasHashtags, accounts, publications, hashtags,
  canEdit, isAr, onPublicationsChanged, onHashtagsChanged, onOrganicPlatformsChanged,
}: {
  contentId: string;
  hasHashtags: boolean;
  accounts: MosAccount[];
  publications: MosPublication[];
  hashtags: string;
  canEdit: boolean;
  isAr: boolean;
  onPublicationsChanged: (pubs: MosPublication[]) => void;
  onHashtagsChanged: (value: string) => void;
  /** Keep organic_platforms in sync with the platforms that have publications, so
   *  the derived purpose and every other reader stay correct. */
  onOrganicPlatformsChanged: (platforms: string[]) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <OrganicPlacements
        contentId={contentId}
        accounts={accounts}
        publications={publications}
        hashtags={hashtags}
        hasHashtags={hasHashtags}
        canEdit={canEdit}
        isAr={isAr}
        onPublicationsChanged={onPublicationsChanged}
        onHashtagsChanged={onHashtagsChanged}
        onOrganicPlatformsChanged={onOrganicPlatformsChanged}
      />
      <PaidPlacements contentId={contentId} canEdit={canEdit} isAr={isAr} />
    </div>
  );
}

/* ══════════════════════ organic ══════════════════════ */

function OrganicPlacements({
  contentId, accounts, publications, hashtags, hasHashtags,
  canEdit, isAr, onPublicationsChanged, onHashtagsChanged, onOrganicPlatformsChanged,
}: {
  contentId: string;
  accounts: MosAccount[];
  publications: MosPublication[];
  hashtags: string;
  hasHashtags: boolean;
  canEdit: boolean;
  isAr: boolean;
  onPublicationsChanged: (pubs: MosPublication[]) => void;
  onHashtagsChanged: (value: string) => void;
  onOrganicPlatformsChanged: (platforms: string[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [orgCampaigns, setOrgCampaigns] = useState<MosCampaign[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchCampaigns()
      .then((r) => { if (alive) setOrgCampaigns(r.campaigns.filter((c) => c.kind === 'organic' && c.status !== 'cancelled')); })
      .catch(() => { /* the picker just shows "no campaign" — non-fatal */ });
    return () => { alive = false; };
  }, []);

  // The organic platforms with an account on file — the pickable universe.
  const organicAccounts = useMemo(
    () => accounts
      .filter((a) => ORGANIC_PLATFORMS.includes(a.platform))
      .sort((a, b) => ORGANIC_PLATFORMS.indexOf(a.platform) - ORGANIC_PLATFORMS.indexOf(b.platform)),
    [accounts],
  );

  const syncPlatforms = (pubs: MosPublication[]): void => {
    onPublicationsChanged(pubs);
    onOrganicPlatformsChanged([...new Set(pubs.map((p) => p.platform))]);
  };

  const [tagDraft, setTagDraft] = useState(hashtags);
  useEffect(() => { setTagDraft(hashtags); }, [hashtags]);

  const created = (r: { campaign: MosCampaign }): void => setOrgCampaigns((prev) => [r.campaign, ...prev]);

  return (
    <div className="write">
      <div className="doc-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{isAr ? 'أماكن النشر العضوية' : 'Organic placements'}</span>
        {canEdit && !adding && organicAccounts.length > 0 && (
          <button
            type="button"
            className="btn btn-p btn-sm"
            style={{ marginInlineStart: 'auto' }}
            onClick={() => setAdding(true)}
          >
            {isAr ? '+ إضافة منصة عضوية' : '+ Add organic'}
          </button>
        )}
      </div>

      {publications.length === 0 && !adding && (
        <p style={{ color: 'var(--mute)', fontSize: 13, lineHeight: 1.9 }}>
          {canEdit
            ? (isAr ? 'أضِف منصة عضوية لنشر هذا المحتوى — كل منصة لها كابشن وموعد وحملة عضوية (اختيارية).'
                    : 'Add an organic placement to post this creative — each platform gets its own caption, schedule and optional organic campaign.')
            : (isAr ? 'لا توجد أماكن نشر عضوية بعد.' : 'No organic placements yet.')}
        </p>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {publications.map((pub) => (
          <OrganicCard
            key={pub.id}
            contentId={contentId}
            pub={pub}
            orgCampaigns={orgCampaigns}
            canEdit={canEdit}
            isAr={isAr}
            onSaved={syncPlatforms}
            onCampaignCreated={created}
            addToast={addToast}
          />
        ))}
      </div>

      {adding && (
        <AddOrganic
          contentId={contentId}
          accounts={organicAccounts}
          existingPlatforms={publications.map((p) => p.platform)}
          orgCampaigns={orgCampaigns}
          isAr={isAr}
          onCancel={() => setAdding(false)}
          onSaved={(pubs) => { syncPlatforms(pubs); setAdding(false); }}
          onCampaignCreated={created}
          addToast={addToast}
        />
      )}

      {hasHashtags && publications.length > 0 && (
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

function OrganicCard({
  contentId, pub, orgCampaigns, canEdit, isAr, onSaved, onCampaignCreated, addToast,
}: {
  contentId: string;
  pub: MosPublication;
  orgCampaigns: MosCampaign[];
  canEdit: boolean;
  isAr: boolean;
  onSaved: (pubs: MosPublication[]) => void;
  onCampaignCreated: (r: { campaign: MosCampaign }) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [caption, setCaption] = useState(pub.caption ?? '');
  const [scheduledAt, setScheduledAt] = useState(pub.scheduled_at ?? '');
  const [campaignId, setCampaignId] = useState(pub.campaign_id ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCaption(pub.caption ?? ''); setScheduledAt(pub.scheduled_at ?? ''); setCampaignId(pub.campaign_id ?? ''); }, [pub]);

  const dirty = caption !== (pub.caption ?? '')
    || (scheduledAt || '') !== (pub.scheduled_at ?? '')
    || (campaignId || '') !== (pub.campaign_id ?? '');
  const manual = !AUTO_PLATFORMS.has(pub.platform);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await savePublication(contentId, {
        id: pub.id,
        caption,
        scheduled_at: scheduledAt || null,
        campaign_id: campaignId || null,
        // Setting a time promotes a draft to scheduled; clearing it drops back.
        status: scheduledAt ? (pub.status === 'published' ? 'published' : 'scheduled') : 'draft',
      });
      onSaved(res.publications);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm(isAr ? 'إزالة هذه المنصة العضوية؟' : 'Remove this organic placement?')) return;
    setBusy(true);
    try {
      const res = await removePublication(contentId, pub.id);
      onSaved(res.publications);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="tag" style={{ borderColor: 'var(--copper)', color: 'var(--copper)' }}>
          {platformLabel(pub.platform, isAr)}
        </span>
        {manual && <span className="tag tag-t" style={{ fontSize: 10 }}>{isAr ? 'يدوي' : 'manual'}</span>}
        {pub.status === 'published' && (
          <span className="tag tag-t" style={{ fontSize: 10 }}>{isAr ? 'نُشر' : 'published'}</span>
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

      <div style={{ display: 'grid', gap: 8 }}>
        <div className="fld">
          <div className="k">{isAr ? 'الكابشن' : 'Caption'}</div>
          {canEdit ? (
            <textarea
              className="inp"
              rows={2}
              style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8 }}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          ) : (
            <div className="v" style={{ whiteSpace: 'pre-line', lineHeight: 1.9 }}>{pub.caption || '—'}</div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="fld">
            <div className="k">{isAr ? 'الموعد' : 'Schedule'}</div>
            {canEdit ? (
              <input
                className="inp"
                type="datetime-local"
                dir="ltr"
                style={{ marginTop: 4, fontSize: 12.5 }}
                value={scheduledAt ? isoDateTimeLocal(scheduledAt) : ''}
                onChange={(e) => setScheduledAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
              />
            ) : (
              <div className="v">{pub.scheduled_at ? new Date(pub.scheduled_at).toLocaleString() : '—'}</div>
            )}
          </div>
          <div className="fld">
            <div className="k">{isAr ? 'الحملة العضوية' : 'Organic campaign'}</div>
            {canEdit ? (
              <CampaignSelect
                value={campaignId}
                orgCampaigns={orgCampaigns}
                isAr={isAr}
                onChange={setCampaignId}
                onCampaignCreated={onCampaignCreated}
                addToast={addToast}
              />
            ) : (
              <div className="v">{orgCampaigns.find((c) => c.id === pub.campaign_id)?.name ?? (isAr ? 'بدون حملة' : 'no campaign')}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AddOrganic({
  contentId, accounts, existingPlatforms, orgCampaigns, isAr, onCancel, onSaved, onCampaignCreated, addToast,
}: {
  contentId: string;
  accounts: MosAccount[];
  existingPlatforms: string[];
  orgCampaigns: MosCampaign[];
  isAr: boolean;
  onCancel: () => void;
  onSaved: (pubs: MosPublication[]) => void;
  onCampaignCreated: (r: { campaign: MosCampaign }) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const openPlatforms = accounts.filter((a) => !existingPlatforms.includes(a.platform));
  const [accountId, setAccountId] = useState(openPlatforms[0]?.id ?? '');
  const [caption, setCaption] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);

  const account = accounts.find((a) => a.id === accountId) ?? null;

  const save = async (): Promise<void> => {
    if (!account) { addToast(isAr ? 'اختر منصة' : 'Pick a platform', 'error'); return; }
    setBusy(true);
    try {
      const res = await savePublication(contentId, {
        platform: account.platform,
        account_id: account.id,
        caption,
        scheduled_at: scheduledAt || null,
        campaign_id: campaignId || null,
        status: scheduledAt ? 'scheduled' : 'draft',
      });
      onSaved(res.publications);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px dashed var(--copper)', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div className="k" style={{ marginBottom: 8 }}>{isAr ? 'منصة عضوية جديدة' : 'New organic placement'}</div>
      {openPlatforms.length === 0 ? (
        <p style={{ color: 'var(--mute)', fontSize: 13 }}>
          {isAr ? 'كل المنصات العضوية المتاحة مضافة بالفعل.' : 'Every available organic platform is already added.'}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="fld">
            <div className="k">{isAr ? 'المنصة والحساب' : 'Platform & account'}</div>
            <select className="inp" style={{ marginTop: 4 }} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {openPlatforms.map((a) => (
                <option key={a.id} value={a.id}>
                  {platformLabel(a.platform, isAr)}{a.handle ? ` · ${a.handle}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <div className="k">{isAr ? 'الكابشن' : 'Caption'}</div>
            <textarea
              className="inp"
              rows={2}
              style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8 }}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="fld">
              <div className="k">{isAr ? 'الموعد' : 'Schedule'}</div>
              <input
                className="inp"
                type="datetime-local"
                dir="ltr"
                style={{ marginTop: 4, fontSize: 12.5 }}
                value={scheduledAt ? isoDateTimeLocal(scheduledAt) : ''}
                onChange={(e) => setScheduledAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
              />
            </div>
            <div className="fld">
              <div className="k">{isAr ? 'الحملة العضوية' : 'Organic campaign'}</div>
              <CampaignSelect
                value={campaignId}
                orgCampaigns={orgCampaigns}
                isAr={isAr}
                onChange={setCampaignId}
                onCampaignCreated={onCampaignCreated}
                addToast={addToast}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button type="button" className="btn btn-p btn-sm" onClick={() => void save()} disabled={busy}>
              {busy ? '…' : (isAr ? 'إضافة' : 'Add')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** existing-organic-campaign picker with an inline "＋ new" that creates one. */
function CampaignSelect({
  value, orgCampaigns, isAr, onChange, onCampaignCreated, addToast,
}: {
  value: string;
  orgCampaigns: MosCampaign[];
  isAr: boolean;
  onChange: (id: string) => void;
  onCampaignCreated: (r: { campaign: MosCampaign }) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await saveCampaign({ name: name.trim(), kind: 'organic' });
      onCampaignCreated({ campaign: res.item });
      onChange(res.item.id);
      setCreating(false);
      setName('');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  if (creating) {
    return (
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input
          className="inp"
          style={{ fontSize: 12.5 }}
          value={name}
          placeholder={isAr ? 'اسم الحملة العضوية' : 'Organic campaign name'}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <button type="button" className="btn btn-p btn-sm" onClick={() => void create()} disabled={busy}>
          {busy ? '…' : (isAr ? 'إنشاء' : 'Create')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setCreating(false)} disabled={busy}>×</button>
      </div>
    );
  }

  return (
    <select
      className="inp"
      style={{ marginTop: 4 }}
      value={value}
      onChange={(e) => { if (e.target.value === '__new__') setCreating(true); else onChange(e.target.value); }}
    >
      <option value="">{isAr ? 'بدون حملة' : 'No campaign'}</option>
      {orgCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      <option value="__new__">{isAr ? '＋ حملة عضوية جديدة' : '＋ New organic campaign'}</option>
    </select>
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
  const [adSetChoice, setAdSetChoice] = useState(''); // an ad-set id, or '__new__', or '' (none)
  const [newSetName, setNewSetName] = useState('');
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

  const save = async (): Promise<void> => {
    if (!executionId) { addToast(isAr ? 'اختر حملة ومنصة إعلانية' : 'Pick a campaign and ad platform', 'error'); return; }
    if (adSetChoice === '__new__' && !newSetName.trim()) {
      addToast(isAr ? 'اكتب اسم المجموعة الإعلانية' : 'Name the new ad set', 'error'); return;
    }
    setBusy(true);
    try {
      const res = await saveAdCreative(
        contentId,
        {
          executionId,
          ...(adSetChoice === '__new__'
            ? { newAdSetName: newSetName.trim() }
            : adSetChoice ? { adSetId: adSetChoice } : {}),
        },
        text ? { primary_text: text } : {},
      );
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
              onChange={(e) => { setCampaignId(e.target.value); setExecutionId(''); setAdSetChoice(''); }}
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
                  onChange={(e) => { setExecutionId(e.target.value); setAdSetChoice(''); }}
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
                onChange={(e) => setAdSetChoice(e.target.value)}
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
