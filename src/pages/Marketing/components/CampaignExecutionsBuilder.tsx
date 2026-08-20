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
import {
  MosContentRow, PLATFORM_LABELS, fetchContentList,
} from '@/lib/marketingOS/client';
import {
  PlatformSettings, defaultPlatformSettings, getPlatformSchema, objectiveKeyOf,
} from '@/lib/marketingOS/adPlatforms';
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
}

export default function CampaignExecutionsBuilder({ drafts, onChange, isAr }: Props): JSX.Element {
  const [editingKey, setEditingKey] = useState<string | null>(null);
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

  const add = (): void => {
    const d = newExecDraft('meta');
    onChange([...drafts, d]);
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
        <button type="button" className="fbtn on" onClick={add}>
          <IconPlus /> {isAr ? 'إضافة حملة إعلانية' : 'Add ad campaign'}
        </button>
      </div>

      {editing && (
        <ExecDraftEditor
          draft={editing}
          content={content}
          isAr={isAr}
          onClose={() => setEditingKey(null)}
          onSave={(next) => { replace(next); setEditingKey(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One execution's full plan → ad sets → ads, edited in memory        */
/* ------------------------------------------------------------------ */

function ExecDraftEditor({
  draft, content, isAr, onClose, onSave,
}: {
  draft: ExecDraft;
  content: MosContentRow[];
  isAr: boolean;
  onClose: () => void;
  onSave: (d: ExecDraft) => void;
}) {
  const [platform, setPlatform] = useState(draft.platform);
  const [settings, setSettings] = useState<PlatformSettings>(draft.settings);
  const [adSets, setAdSets] = useState<ExecAdSetDraft[]>(draft.adSets);

  const schema = getPlatformSchema(platform);

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

  return (
    <Modal
      title={isAr ? 'إعداد الحملة الإعلانية' : 'Configure ad campaign'}
      sub={isAr
        ? 'الخطة على المنصة، ثم المجموعات الإعلانية، ثم الإعلانات (محتوى + كابشن). المعرّفات تأتي من ميتا عند الإنشاء.'
        : 'The platform plan, then ad sets, then ads (content + caption). IDs come from Meta on create.'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
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
                  <input className="inp" value={s.name} onChange={(e) => patchSet(s.key, { name: e.target.value })} />
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
                        <input className="inp" value={a.label} onChange={(e) => patchAd(s.key, a.key, { label: e.target.value })} />
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
                      <span className="lbl">{isAr ? 'المحتوى — من القائمة أو المكتبة أو رفع جديد' : 'Content — list, library, or upload'}</span>
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
  );
}
