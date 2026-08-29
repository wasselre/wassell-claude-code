/**
 * CampaignExecutionsBuilder — the gated execution editor used when CREATING a
 * new paid campaign.
 *
 * The rule (operator decision 2026-08-20): a paid parent campaign cannot be
 * created empty. You add one or more executions and must FULLY configure each
 * one — platform plan (objective/budget/conversion/dates) → ad set(s) → ad(s)
 * with content + caption — before the parent's "Create" unlocks. An incomplete
 * execution shows an "املأ الإعدادات / Fill settings" chip. On create the whole
 * tree (campaign → executions → ad sets → ads) is written together.
 *
 * This component owns only the in-memory drafts (the parent modal holds the
 * array and does the actual multi-step save). It reuses PlatformFieldsGrid for
 * the plan and ContentPicker for each ad's creative — the same controls the
 * per-execution editors on the detail page use.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow, PLATFORM_LABELS, fetchContentList,
  ExecutionTemplate, fetchExecutionTemplates, saveExecutionTemplate, deleteExecutionTemplate,
} from '@/lib/marketingOS/client';
import {
  PlatformSettings, defaultPlatformSettings, getPlatformSchema, objectiveKeyOf,
  platformOptionLabel,
} from '@/lib/marketingOS/adPlatforms';
import { adSetAutoName, adAutoName, executionAutoName } from '../lib/autoName';
import { Modal } from './kit';
import { PlatformFieldsGrid } from './PlatformSettingsForm';
import ContentPicker, { PickedAsset, ContentPickerValue } from './ContentPicker';
import { IconPlus, IconTrash } from './icons';

/** Platforms offered at creation — the ones with a structured plan schema. */
const EXEC_PLATFORMS = ['meta', 'instagram', 'snapchat', 'tiktok'] as const;

export interface ExecAdDraft {
  key: string;
  label: string;
  contentId: string;
  asset: PickedAsset | null;
  caption: string;
}
export interface ExecAdSetDraft {
  key: string;
  name: string;
  ads: ExecAdDraft[];
}
export interface ExecDraft {
  key: string;
  platform: string;
  settings: PlatformSettings;
  adSets: ExecAdSetDraft[];
}

let seq = 0;
const k = (): string => { seq += 1; return `e${seq}`; };

const blankAd = (): ExecAdDraft => ({ key: k(), label: '', contentId: '', asset: null, caption: '' });
const blankAdSet = (): ExecAdSetDraft => ({ key: k(), name: '', ads: [blankAd()] });

export const newExecDraft = (platform = 'meta'): ExecDraft => ({
  key: k(),
  platform,
  settings: defaultPlatformSettings(platform),
  adSets: [blankAdSet()],
});

/** The opaque template `setup` blob = the reusable ad-campaign SETTINGS. Content
 *  is per-project, so ads carry only their name + caption scaffold, never a
 *  content reference. */
export function execDraftToSetup(d: ExecDraft): Record<string, unknown> {
  return {
    platform: d.platform,
    settings: d.settings,
    adSets: d.adSets.map((s) => ({
      name: s.name,
      ads: s.ads.map((a) => ({ label: a.label, caption: a.caption })),
    })),
  };
}

/** Rehydrate a fresh, uniquely-keyed draft from a saved template's setup. Content
 *  picks start empty (they belong to the project this execution will serve). */
export function execDraftFromSetup(setup: Record<string, unknown>): ExecDraft {
  const platform = typeof setup.platform === 'string' && setup.platform ? setup.platform : 'meta';
  const rawSettings = setup.settings;
  const settings: PlatformSettings = rawSettings && typeof rawSettings === 'object'
    ? { ...(rawSettings as PlatformSettings) }
    : defaultPlatformSettings(platform);
  const rawSets = Array.isArray(setup.adSets) ? (setup.adSets as Array<Record<string, unknown>>) : [];
  const adSets: ExecAdSetDraft[] = rawSets.length > 0
    ? rawSets.map((s) => ({
      key: k(),
      name: typeof s.name === 'string' ? s.name : '',
      ads: (Array.isArray(s.ads) ? (s.ads as Array<Record<string, unknown>>) : []).map((a) => ({
        key: k(),
        label: typeof a.label === 'string' ? a.label : '',
        contentId: '',
        asset: null,
        caption: typeof a.caption === 'string' ? a.caption : '',
      })),
    }))
    : [blankAdSet()];
  // Guarantee at least one ad in every set (the create gate + editor expect it).
  for (const s of adSets) if (s.ads.length === 0) s.ads.push(blankAd());
  return { key: k(), platform, settings, adSets };
}

/** A draft is complete when it has a platform + an objective + at least one ad
 *  set with a name + every ad named. This is exactly the parent's create gate. */
export function execDraftComplete(d: ExecDraft): boolean {
  if (!d.platform) return false;
  const sch = getPlatformSchema(d.platform);
  const objKey = sch ? objectiveKeyOf(sch) : '';
  const hasObjective = objKey ? Boolean(d.settings[objKey]) : true;
  const setsOk = d.adSets.length > 0 && d.adSets.every((s) => s.name.trim() !== '');
  const adsOk = d.adSets.length > 0
    && d.adSets.every((s) => s.ads.length > 0 && s.ads.every((a) => a.label.trim() !== ''));
  return hasObjective && setsOk && adsOk;
}

/** The plan budget the execution.budget column mirrors (what lists show). */
export function execPlanBudget(d: ExecDraft): number | null {
  const key = d.settings.budget_mode === 'LIFETIME' ? 'lifetime_budget' : 'daily_budget';
  const v = d.settings[key];
  return typeof v === 'number' ? v : null;
}

interface Props {
  drafts: ExecDraft[];
  onChange: (drafts: ExecDraft[]) => void;
  isAr: boolean;
  /** The parent campaign's (auto/edited) name — embedded in the lineage names
   *  seeded for each execution's ad sets and ads. */
  campaignName?: string;
}

export default function CampaignExecutionsBuilder({ drafts, onChange, isAr, campaignName = '' }: Props): JSX.Element {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [content, setContent] = useState<MosContentRow[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchContentList({ limit: 300 });
        setContent(res.content);
      } catch {
        // Non-fatal: library + upload still work without the content list.
        setContent([]);
      }
    })();
  }, []);

  const addDraft = (d: ExecDraft): void => {
    onChange([...drafts, d]);
    setPicking(false);
    setEditingKey(d.key);
  };
  const remove = (key: string): void => onChange(drafts.filter((d) => d.key !== key));
  const replace = (next: ExecDraft): void => onChange(drafts.map((d) => (d.key === next.key ? next : d)));

  const platformLabel = (p: string): string => (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;
  const editing = drafts.find((d) => d.key === editingKey) ?? null;

  return (
    <div>
      <div className="lbl" style={{ marginBottom: 7 }}>
        {isAr ? 'الحملات الإعلانية (لكلٍّ مجموعات وإعلانات)' : 'Ad campaigns (each with ad sets & ads)'}
      </div>

      {drafts.length === 0 ? (
        <div style={{
          fontSize: 12, color: 'var(--mute)', padding: '10px 12px',
          border: '1px dashed var(--line)', borderRadius: 8, lineHeight: 1.8,
        }}>
          {isAr
            ? 'أضف حملة إعلانية واحدة على الأقل، واملأ إعداداتها (المنصة، المجموعة، الإعلان) قبل الإنشاء.'
            : 'Add at least one ad campaign and fill its settings (platform, ad set, ad) before creating.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {drafts.map((d) => {
            const done = execDraftComplete(d);
            const adCount = d.adSets.reduce((n, s) => n + s.ads.length, 0);
            return (
              <div
                key={d.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  border: '1px solid var(--line)', borderRadius: 8,
                }}
              >
                <span style={{ fontWeight: 700 }}>{platformLabel(d.platform)}</span>
                <span
                  className={`pill ${done ? 'p-go' : 'p-wait'}`}
                  style={{ padding: '3px 8px', fontSize: 11 }}
                >
                  {done
                    ? (isAr ? `جاهزة · ${d.adSets.length} مجموعة · ${adCount} إعلان` : `Ready · ${d.adSets.length} set(s) · ${adCount} ad(s)`)
                    : (isAr ? 'املأ الإعدادات' : 'Fill settings')}
                </span>
                <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => setEditingKey(d.key)}>
                    {isAr ? 'تعديل' : 'Edit'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-d btn-sm"
                    title={isAr ? 'إزالة' : 'Remove'}
                    onClick={() => remove(d.key)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 9 }}>
        <button type="button" className="fbtn on" onClick={() => setPicking(true)}>
          <IconPlus /> {isAr ? 'إضافة حملة إعلانية' : 'Add ad campaign'}
        </button>
      </div>

      {picking && (
        <ExecStartChooser
          isAr={isAr}
          onScratch={() => addDraft(newExecDraft('meta'))}
          onPick={(tpl) => addDraft(execDraftFromSetup(tpl.setup))}
          onClose={() => setPicking(false)}
        />
      )}

      {editing && (
        <ExecDraftEditor
          draft={editing}
          content={content}
          isAr={isAr}
          campaignName={campaignName}
          onClose={() => setEditingKey(null)}
          onSave={(next) => { replace(next); setEditingKey(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New-execution chooser: start blank, or from a saved settings        */
/* template that prefills platform + plan + ad-set/ad scaffold.        */
/* ------------------------------------------------------------------ */

function ExecStartChooser({
  isAr, onScratch, onPick, onClose,
}: {
  isAr: boolean;
  onScratch: () => void;
  onPick: (t: ExecutionTemplate) => void;
  onClose: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [templates, setTemplates] = useState<ExecutionTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchExecutionTemplates()
      .then((r) => { if (alive) setTemplates(r.templates); })
      .catch((e) => { if (alive) console.error('[mos] exec templates load failed', e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const del = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await deleteExecutionTemplate(id);
      setTemplates(r.templates);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'حملة إعلانية جديدة' : 'New ad campaign'}
      sub={isAr
        ? 'ابدأ من الصفر، أو من قالب إعدادات محفوظ (المنصة، الميزانية، الهدف، المجموعات) فتُملأ الإعدادات وتضيف المحتوى فقط.'
        : 'Start blank, or from a saved settings template (platform, budget, objective, ad sets) so the setup is prefilled and you only add content.'}
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</button>}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <button
          type="button"
          className="btn btn-p"
          style={{ justifyContent: 'center', padding: '12px' }}
          onClick={onScratch}
        >
          {isAr ? '+ حملة إعلانية من الصفر' : '+ Ad campaign from scratch'}
        </button>

        <div className="lbl">{isAr ? 'أو من قالب إعدادات' : 'Or from a settings template'}</div>
        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--mute)' }}>{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>
        ) : templates.length === 0 ? (
          <div style={{
            fontSize: 12.5, color: 'var(--mute)', padding: '10px 12px', lineHeight: 1.8,
            border: '1px dashed var(--line)', borderRadius: 8,
          }}>
            {isAr
              ? 'لا قوالب بعد. أعدّ حملة إعلانية ثم «حفظ كقالب» لإعادة استخدام إعداداتها.'
              : 'No templates yet. Configure an ad campaign, then «Save as template» to reuse its settings.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {templates.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  border: '1px solid var(--line)', borderRadius: 10,
                }}
              >
                <span style={{ flex: 1, fontWeight: 700 }}>{t.name}</span>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onPick(t)}>
                  {isAr ? 'استخدم' : 'Use'}
                </button>
                <button type="button" className="btn btn-d btn-sm" disabled={busy} title={isAr ? 'حذف' : 'Delete'} onClick={() => void del(t.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One execution's full plan → ad sets → ads, edited in memory        */
/* ------------------------------------------------------------------ */

function ExecDraftEditor({
  draft, content, isAr, campaignName, onClose, onSave,
}: {
  draft: ExecDraft;
  content: MosContentRow[];
  isAr: boolean;
  campaignName: string;
  onClose: () => void;
  onSave: (d: ExecDraft) => void;
}) {
  const [platform, setPlatform] = useState(draft.platform);
  const [settings, setSettings] = useState<PlatformSettings>(draft.settings);
  const [adSets, setAdSets] = useState<ExecAdSetDraft[]>(draft.adSets);

  const schema = getPlatformSchema(platform);

  /* ── auto-naming (lineage) — seed blanks, never clobber edits ────── */

  const platformLabel = (isAr ? PLATFORM_LABELS[platform]?.ar : PLATFORM_LABELS[platform]?.en) ?? platform;
  const execName = executionAutoName({ platformLabel, parentName: campaignName, isAr });
  const conversion = typeof settings.destination_type === 'string' && settings.destination_type
    ? platformOptionLabel(platform, 'destination_type', settings.destination_type, isAr)
    : null;
  const setSuggest = (): string => adSetAutoName({
    conversionLabel: conversion, audienceLabel: null, executionName: execName, isAr,
  });
  const contentTypeLabel = (contentId: string): string | null => {
    const c = content.find((x) => x.id === contentId);
    return c ? (isAr ? c.content_type_label_ar : c.content_type_label_en) : null;
  };
  const adSuggest = (setName: string, contentId: string): string => adAutoName({
    creativeLabel: contentTypeLabel(contentId),
    adSetName: setName.trim() || setSuggest(),
    isAr,
  });

  // Fill EMPTY ad-set / ad names with the current lineage suggestion. Keyed off
  // STRUCTURE + inputs (platform, conversion, content picks, parent name) — NOT
  // the name values — so it never re-runs when a human clears a name to retype,
  // and never overwrites a name someone typed. Picking content for a still-blank
  // ad refreshes its suggested creative type in place.
  const structSig = adSets
    .map((s) => `${s.key}:${s.ads.map((a) => `${a.key}=${a.contentId}`).join(',')}`)
    .join('|');
  useEffect(() => {
    setAdSets((cur) => {
      let changed = false;
      const next = cur.map((s) => {
        const name = s.name.trim() === '' ? setSuggest() : s.name;
        if (name !== s.name) changed = true;
        const ads = s.ads.map((a) => {
          if (a.label.trim() !== '') return a;
          changed = true;
          return { ...a, label: adSuggest(name, a.contentId) };
        });
        return name !== s.name || ads !== s.ads ? { ...s, name, ads } : s;
      });
      return changed ? next : cur;
    });
    // setSuggest/adSuggest close over platform/conversion/content/campaignName,
    // all captured in structSig + the primitive deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig, platform, conversion, campaignName, isAr]);

  const patchSet = (key: string, over: Partial<Omit<ExecAdSetDraft, 'key' | 'ads'>>): void =>
    setAdSets((cur) => cur.map((s) => (s.key === key ? { ...s, ...over } : s)));
  const addSet = (): void => setAdSets((cur) => [...cur, blankAdSet()]);
  const removeSet = (key: string): void => setAdSets((cur) => cur.filter((s) => s.key !== key));
  const addAd = (setKey: string): void =>
    setAdSets((cur) => cur.map((s) => (s.key === setKey ? { ...s, ads: [...s.ads, blankAd()] } : s)));
  const removeAd = (setKey: string, adKey: string): void =>
    setAdSets((cur) => cur.map((s) => (s.key === setKey ? { ...s, ads: s.ads.filter((a) => a.key !== adKey) } : s)));
  const patchAd = (setKey: string, adKey: string, over: Partial<Omit<ExecAdDraft, 'key'>>): void =>
    setAdSets((cur) => cur.map((s) => (
      s.key === setKey ? { ...s, ads: s.ads.map((a) => (a.key === adKey ? { ...a, ...over } : a)) } : s
    )));

  const commit = (): void => onSave({ ...draft, platform, settings, adSets });

  // In-app discard-guard (not window.confirm) when the plan was edited.
  const [closeConfirm, setCloseConfirm] = useState(false);
  const dirty = JSON.stringify({ platform, settings, adSets })
    !== JSON.stringify({ platform: draft.platform, settings: draft.settings, adSets: draft.adSets });
  const requestClose = (): void => { if (dirty) setCloseConfirm(true); else onClose(); };

  // Save these settings as a reusable template (name-prompt sub-modal).
  const addToast = useAppStore((s) => s.addToast);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplBusy, setTplBusy] = useState(false);
  const saveAsTemplate = async (): Promise<void> => {
    const name = tplName.trim();
    if (!name) return;
    setTplBusy(true);
    try {
      await saveExecutionTemplate({ name, setup: execDraftToSetup({ ...draft, platform, settings, adSets }) });
      addToast(isAr ? 'حُفظ القالب' : 'Template saved', 'success');
      setSavingTpl(false);
      setTplName('');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setTplBusy(false);
    }
  };

  return (
    <>
    <Modal
      title={isAr ? 'إعداد الحملة الإعلانية' : 'Configure ad campaign'}
      sub={isAr
        ? 'الخطة على المنصة، ثم المجموعات الإعلانية، ثم الإعلانات (محتوى + كابشن). المعرّفات تأتي من ميتا عند الإنشاء.'
        : 'The platform plan, then ad sets, then ads (content + caption). IDs come from Meta on create.'}
      onClose={requestClose}
      wide
      footer={
        <>
          <button
            type="button"
            className="btn"
            style={{ marginInlineEnd: 'auto' }}
            onClick={() => { setTplName(''); setSavingTpl(true); }}
          >
            {isAr ? 'حفظ كقالب' : 'Save as template'}
          </button>
          <button type="button" className="btn" onClick={requestClose}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={commit}>
            {isAr ? 'تم' : 'Done'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'grid', gap: 3, maxWidth: 260 }}>
          <span className="lbl">{isAr ? 'المنصة' : 'Platform'}</span>
          <select
            className="inp"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              setSettings(defaultPlatformSettings(e.target.value));
            }}
          >
            {EXEC_PLATFORMS.map((p) => (
              <option key={p} value={p}>{(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}</option>
            ))}
          </select>
        </label>

        {schema && (
          <PlatformFieldsGrid
            schema={schema}
            sections={schema.sections}
            draft={settings}
            disabled={false}
            isAr={isAr}
            onChange={setSettings}
          />
        )}

        {/* Ad sets → ads */}
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="lbl">{isAr ? 'المجموعات الإعلانية' : 'Ad sets'}</div>
          {adSets.map((s) => (
            <div key={s.key} style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(140px,1fr) 34px', gap: 8,
                alignItems: 'end', padding: '10px 11px', background: 'var(--panel, rgba(255,255,255,0.03))',
              }}>
                <label style={{ display: 'grid', gap: 3 }}>
                  <span className="lbl">{isAr ? 'اسم المجموعة الإعلانية' : 'Ad set name'}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="inp" style={{ flex: 1 }} value={s.name} onChange={(e) => patchSet(s.key, { name: e.target.value })} />
                    <button
                      type="button"
                      className="fbtn"
                      style={{ padding: '0 10px' }}
                      title={isAr ? 'توليد الاسم تلقائيًا' : 'Auto-generate the name'}
                      onClick={() => patchSet(s.key, { name: setSuggest() })}
                    >
                      ↻
                    </button>
                  </div>
                </label>
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  title={isAr ? 'حذف المجموعة' : 'Remove ad set'}
                  onClick={() => removeSet(s.key)}
                >
                  <IconTrash />
                </button>
              </div>
              <div style={{ display: 'grid', gap: 8, padding: 11 }}>
                {s.ads.map((a) => (
                  <div key={a.key} style={{
                    display: 'grid', gap: 7, padding: 9, borderRadius: 8,
                    border: '1px solid var(--line, rgba(255,255,255,0.08))',
                  }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px,1fr) 34px', gap: 8, alignItems: 'end' }}>
                      <label style={{ display: 'grid', gap: 3 }}>
                        <span className="lbl">{isAr ? 'اسم الإعلان' : 'Ad name'}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input className="inp" style={{ flex: 1 }} value={a.label} onChange={(e) => patchAd(s.key, a.key, { label: e.target.value })} />
                          <button
                            type="button"
                            className="fbtn"
                            style={{ padding: '0 10px' }}
                            title={isAr ? 'توليد الاسم تلقائيًا' : 'Auto-generate the name'}
                            onClick={() => patchAd(s.key, a.key, { label: adSuggest(s.name, a.contentId) })}
                          >
                            ↻
                          </button>
                        </div>
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
                        onChange={(v: ContentPickerValue) => patchAd(s.key, a.key, { contentId: v.contentId, asset: v.asset })}
                      />
                    </div>
                    <label style={{ display: 'grid', gap: 3 }}>
                      <span className="lbl">{isAr ? 'النص الإعلاني (الكابشن)' : 'Caption'}</span>
                      <textarea
                        className="inp"
                        rows={2}
                        value={a.caption}
                        onChange={(e) => patchAd(s.key, a.key, { caption: e.target.value })}
                      />
                    </label>
                  </div>
                ))}
                <div>
                  <button type="button" className="fbtn" onClick={() => addAd(s.key)}>
                    {isAr ? '+ إضافة إعلان' : '+ Add ad'}
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div>
            <button type="button" className="fbtn on" onClick={addSet}>
              <IconPlus /> {isAr ? 'إضافة مجموعة إعلانية' : 'Add ad set'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
    {savingTpl && (
      <Modal
        title={isAr ? 'حفظ كقالب' : 'Save as template'}
        sub={isAr
          ? 'يُحفظ إعداد الحملة الإعلانية (المنصة، الميزانية، الهدف، المجموعات) لإعادة استخدامه. المحتوى لا يُحفظ — يُضاف لكل مشروع.'
          : 'Saves the ad-campaign setup (platform, budget, objective, ad sets) for reuse. Content is not saved — it is added per project.'}
        onClose={() => setSavingTpl(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setSavingTpl(false)}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={tplBusy || tplName.trim() === ''}
              onClick={() => void saveAsTemplate()}
            >
              {tplBusy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
            </button>
          </>
        }
      >
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="lbl">{isAr ? 'اسم القالب' : 'Template name'}</span>
          <input
            className="inp"
            autoFocus
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && tplName.trim()) void saveAsTemplate(); }}
            placeholder={isAr ? 'مثال: ميتا — رسائل — ميزانية يومية' : 'e.g. Meta — Messages — daily budget'}
          />
        </label>
      </Modal>
    )}
    {closeConfirm && (
      <Modal
        title={isAr ? 'تجاهل التغييرات؟' : 'Discard changes?'}
        sub={isAr ? 'لديك تغييرات غير محفوظة في هذه الحملة الإعلانية.' : 'You have unsaved changes on this ad campaign.'}
        onClose={() => setCloseConfirm(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCloseConfirm(false)}>
              {isAr ? 'متابعة التحرير' : 'Keep editing'}
            </button>
            <button type="button" className="btn btn-d" onClick={() => { setCloseConfirm(false); onClose(); }}>
              {isAr ? 'تجاهل وإغلاق' : 'Discard & close'}
            </button>
          </>
        }
      >
        <div style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.9 }}>
          {isAr ? 'سيُفقد ما لم يُحفظ إن أغلقت الآن.' : 'Anything unsaved will be lost if you close now.'}
        </div>
      </Modal>
    )}
    </>
  );
}
