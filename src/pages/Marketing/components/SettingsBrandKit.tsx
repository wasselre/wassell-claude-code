/**
 * Settings → Brand kit (عدة الهوية).
 *
 * The brand kit is DATA with a status: `draft` means ADVISORY (deviations are
 * listed on packages, never failed); a reviewer with `approve_creative` clicks
 * «اعتماد» and it flips to `reviewed` + CONSTRAINT (the validator enforces it)
 * with a bumped version (contracts §0.12). Everything the generator and the
 * validator read — palette, typography, logo rules, character, image treatment,
 * prohibitions — is edited here.
 *
 * Below the kit: the approved design examples registry (what "good" looks
 * like), with retire for reviewers.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  fetchBrandKit, listDesignExamples, reviewBrandKit, saveBrandKit, setDesignExample,
  type DesignExampleRow,
} from '@/lib/marketingOS/creativeClient';
import type { BrandKit } from '@/lib/creative/contracts';
import { Field, LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { dateStamp, num } from '../lib/format';

type ListKey = 'sources' | 'prohibited' | 'approved_example_ids';
type ComboKey = 'combinations_allowed' | 'combinations_avoid';

const lines = (v: string[]): string => v.join('\n');
const parseLines = (v: string): string[] => v.split('\n').map((s) => s.trim()).filter(Boolean);
const parseCombos = (v: string): string[][] =>
  parseLines(v).map((l) => l.split(/[+،,]/).map((s) => s.trim()).filter(Boolean));
const combosToLines = (v: string[][]): string => v.map((c) => c.join(' + ')).join('\n');

export default function SettingsBrandKit({
  canManage, canReview, isAr,
}: {
  canManage: boolean;
  /** approve_creative — the «اعتماد» button and example retirement. */
  canReview: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [kit, setKit] = useState<BrandKit | null>(null);
  const [examples, setExamples] = useState<DesignExampleRow[]>([]);
  const [examplePreviews, setExamplePreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [k, ex] = await Promise.all([fetchBrandKit(), listDesignExamples()]);
      setKit(k.kit);
      setExamples(ex.examples);
      setExamplePreviews(ex.previews);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = (p: Partial<BrandKit>): void => {
    if (!kit) return;
    setKit({ ...kit, ...p });
    setDirty(true);
  };
  const patchList = (key: ListKey, text: string): void => patch({ [key]: parseLines(text) } as Partial<BrandKit>);
  const patchCombo = (key: ComboKey, text: string): void => patch({ [key]: parseCombos(text) } as Partial<BrandKit>);

  const save = async (): Promise<void> => {
    if (!kit) return;
    setSaving(true);
    try {
      const res = await saveBrandKit(kit);
      setKit(res.kit);
      setDirty(false);
      addToast(isAr ? 'حُفظت عدة الهوية.' : 'Brand kit saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const review = async (): Promise<void> => {
    if (dirty) {
      addToast(isAr ? 'احفظ تعديلاتك أولًا ثم اعتمد.' : 'Save your edits first, then approve.', 'error');
      return;
    }
    setReviewing(true);
    try {
      const res = await reviewBrandKit();
      setKit(res.kit);
      addToast(
        isAr ? 'اعتُمدت العدة — أصبحت إلزامية على التوليد.' : 'Kit approved — it is now a constraint on generation.',
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setReviewing(false);
    }
  };

  const retire = async (ex: DesignExampleRow): Promise<void> => {
    try {
      await setDesignExample({ subject_kind: ex.subject_kind, subject_id: ex.subject_id, retire: true });
      setExamples((xs) => xs.filter((x) => x.id !== ex.id));
      addToast(isAr ? 'أُخرج المثال من السجل.' : 'Example retired.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const statusPill = kit && (
    kit.status === 'reviewed'
      ? <span className="pill p-go">{isAr ? 'معتمدة · إلزامية' : 'Reviewed · constraint'}</span>
      : <span className="pill p-wait">{isAr ? 'مسودة · استشارية' : 'Draft · advisory'}</span>
  );

  return (
    <>
      <PageHead
        title={isAr ? 'عدة الهوية' : 'Brand kit'}
        sub={isAr
          ? 'ما يلتزم به التوليد والتحقق — مسودة استشارية حتى الاعتماد، ثم إلزامية'
          : 'What generation and validation follow — advisory draft until approved, then a constraint'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {kit && (
          <>
            {canManage && (
              <button type="button" className="btn" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
              </button>
            )}
            {canReview && kit.status !== 'reviewed' && (
              <button type="button" className="btn btn-go" disabled={reviewing} onClick={() => void review()}>
                {reviewing ? (isAr ? 'يُعتمد…' : 'Approving…') : (isAr ? 'اعتماد العدة' : 'Approve the kit')}
              </button>
            )}
          </>
        )}
      </PageHead>
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={5} />}
        {!loading && !error && !kit && (
          <div className="notice">
            {isAr ? 'لا توجد عدة هوية بعد — تُزرع مسودة أولى من فريق الهوية.' : 'No brand kit yet — a first draft is seeded by the brand team.'}
          </div>
        )}
        {!loading && !error && kit && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {statusPill}
              <span className="tag">{isAr ? `الإصدار ${num(kit.version, true)}` : `v${kit.version}`}</span>
              {kit.reviewed_at && (
                <span className="tag">{isAr ? `اعتُمدت ${dateStamp(kit.reviewed_at, true)}` : `reviewed ${dateStamp(kit.reviewed_at, false)}`}</span>
              )}
              {!canManage && (
                <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'التعديل يتطلب صلاحية إدارة الإعدادات.' : 'Editing requires manage-settings.'}
                </span>
              )}
            </div>

            {/* ── palette ──────────────────────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'الألوان' : 'Palette'}</h4>
                {canManage && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => patch({ palette: [...kit.palette, { name: '', hex: '#000000', roles: [] }] })}
                  >
                    {isAr ? 'إضافة لون' : 'Add a color'}
                  </button>
                )}
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 8 }}>
                {kit.palette.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(p.hex) ? p.hex : '#000000'}
                      disabled={!canManage}
                      style={{ width: 34, height: 30, border: '1px solid var(--line)', borderRadius: 6, padding: 1, background: 'var(--paper)' }}
                      onChange={(e) => patch({ palette: kit.palette.map((x, xi) => (xi === i ? { ...x, hex: e.target.value } : x)) })}
                    />
                    <input
                      className="inp" style={{ width: 140 }}
                      placeholder={isAr ? 'الاسم' : 'Name'}
                      value={p.name}
                      disabled={!canManage}
                      onChange={(e) => patch({ palette: kit.palette.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)) })}
                    />
                    <input
                      className="inp ltr" style={{ width: 90 }}
                      value={p.hex}
                      disabled={!canManage}
                      onChange={(e) => patch({ palette: kit.palette.map((x, xi) => (xi === i ? { ...x, hex: e.target.value } : x)) })}
                    />
                    <input
                      className="inp" style={{ flex: 1, minWidth: 140 }}
                      placeholder={isAr ? 'الأدوار (مفصولة بفاصلة): أساسي، نص…' : 'Roles (comma-separated): primary, text…'}
                      value={p.roles.join('، ')}
                      disabled={!canManage}
                      onChange={(e) => patch({ palette: kit.palette.map((x, xi) => (xi === i ? { ...x, roles: e.target.value.split(/[،,]/).map((r) => r.trim()).filter(Boolean) } : x)) })}
                    />
                    {canManage && (
                      <button
                        type="button"
                        className="btn btn-d btn-sm"
                        onClick={() => patch({ palette: kit.palette.filter((_, xi) => xi !== i) })}
                      >
                        {isAr ? 'حذف' : 'Remove'}
                      </button>
                    )}
                  </div>
                ))}
                {kit.palette.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? 'لا ألوان بعد.' : 'No colors yet.'}</div>
                )}
              </div>
            </div>

            {/* ── typography + logo ────────────────────────────────── */}
            <div className="card">
              <div className="card-h"><h4>{isAr ? 'الخطوط والشعار' : 'Typography & logo'}</h4></div>
              <div className="card-b" style={{ display: 'grid', gap: 12 }}>
                <div className="grid g2" style={{ gap: 12 }}>
                  <Field label={isAr ? 'خط العناوين' : 'Display font'}>
                    <input className="inp" value={kit.typography.display} disabled={!canManage}
                      onChange={(e) => patch({ typography: { ...kit.typography, display: e.target.value } })} />
                  </Field>
                  <Field label={isAr ? 'خط المتن' : 'Body font'}>
                    <input className="inp" value={kit.typography.body} disabled={!canManage}
                      onChange={(e) => patch({ typography: { ...kit.typography, body: e.target.value } })} />
                  </Field>
                  <Field label={isAr ? 'الأرقام' : 'Numerals'}>
                    <select className="inp" value={kit.typography.numerals} disabled={!canManage}
                      onChange={(e) => patch({ typography: { ...kit.typography, numerals: e.target.value === 'western' ? 'western' : 'arabic_indic' } })}>
                      <option value="arabic_indic">{isAr ? 'عربية (٠١٢٣)' : 'Arabic-Indic (٠١٢٣)'}</option>
                      <option value="western">{isAr ? 'غربية (0123)' : 'Western (0123)'}</option>
                    </select>
                  </Field>
                  <Field label={isAr ? 'أقصى أحجام في الشريحة' : 'Max sizes per slide'}>
                    <input className="inp" type="number" min={1} max={6} value={kit.typography.max_sizes_per_slide} disabled={!canManage}
                      onChange={(e) => patch({ typography: { ...kit.typography, max_sizes_per_slide: Number(e.target.value) || 1 } })} />
                  </Field>
                </div>
                <Field label={isAr ? 'سياسة الحروف اللاتينية' : 'Latin policy'}>
                  <input className="inp" value={kit.typography.latin_policy} disabled={!canManage}
                    onChange={(e) => patch({ typography: { ...kit.typography, latin_policy: e.target.value } })} />
                </Field>
                <div className="grid g2" style={{ gap: 12 }}>
                  <Field label={isAr ? 'الشعار على الداكن' : 'Logo on dark'}>
                    <input className="inp" value={kit.logo.on_dark} disabled={!canManage}
                      onChange={(e) => patch({ logo: { ...kit.logo, on_dark: e.target.value } })} />
                  </Field>
                  <Field label={isAr ? 'الشعار على الفاتح' : 'Logo on light'}>
                    <input className="inp" value={kit.logo.on_light} disabled={!canManage}
                      onChange={(e) => patch({ logo: { ...kit.logo, on_light: e.target.value } })} />
                  </Field>
                  <Field label={isAr ? 'الموضع الافتراضي' : 'Default position'}>
                    <input className="inp" value={kit.logo.default_position} disabled={!canManage}
                      onChange={(e) => patch({ logo: { ...kit.logo, default_position: e.target.value } })} />
                  </Field>
                  <Field label={isAr ? 'المساحة الصافية' : 'Clear space'}>
                    <input className="inp" value={kit.logo.clear_space} disabled={!canManage}
                      onChange={(e) => patch({ logo: { ...kit.logo, clear_space: e.target.value } })} />
                  </Field>
                </div>
              </div>
            </div>

            {/* ── character + treatment + prohibited ───────────────── */}
            <div className="card">
              <div className="card-h"><h4>{isAr ? 'الشخصية والمعالجة والممنوعات' : 'Character, treatment & prohibitions'}</h4></div>
              <div className="card-b" style={{ display: 'grid', gap: 12 }}>
                <Field label={isAr ? 'بيان الشخصية' : 'Character statement'}>
                  <textarea className="inp" rows={2} value={kit.character.statement} disabled={!canManage}
                    onChange={(e) => patch({ character: { ...kit.character, statement: e.target.value } })} />
                </Field>
                <div className="grid g2" style={{ gap: 12 }}>
                  <Field label={isAr ? 'الزخارف المميزة (سطر لكل واحدة)' : 'Motifs (one per line)'}>
                    <textarea className="inp" rows={3} value={lines(kit.character.motifs)} disabled={!canManage}
                      onChange={(e) => patch({ character: { ...kit.character, motifs: parseLines(e.target.value) } })} />
                  </Field>
                  <Field label={isAr ? 'المساحة السالبة' : 'Negative space'}>
                    <textarea className="inp" rows={3} value={kit.character.negative_space} disabled={!canManage}
                      onChange={(e) => patch({ character: { ...kit.character, negative_space: e.target.value } })} />
                  </Field>
                  <Field label={isAr ? 'معالجة الصور — مسموح (سطر لكل واحدة)' : 'Image treatment — allowed (one per line)'}>
                    <textarea className="inp" rows={3} value={lines(kit.image_treatment.allowed)} disabled={!canManage}
                      onChange={(e) => patch({ image_treatment: { ...kit.image_treatment, allowed: parseLines(e.target.value) } })} />
                  </Field>
                  <Field label={isAr ? 'معالجة الصور — تجنّب (سطر لكل واحدة)' : 'Image treatment — avoid (one per line)'}>
                    <textarea className="inp" rows={3} value={lines(kit.image_treatment.avoid)} disabled={!canManage}
                      onChange={(e) => patch({ image_treatment: { ...kit.image_treatment, avoid: parseLines(e.target.value) } })} />
                  </Field>
                </div>
                <Field
                  label={isAr ? 'الممنوعات (سطر لكل واحدة)' : 'Prohibited (one per line)'}
                  hint={isAr ? 'عبارات وممارسات لا تظهر في أي تصميم' : 'phrases and practices that never appear in a design'}
                >
                  <textarea className="inp" rows={4} value={lines(kit.prohibited)} disabled={!canManage}
                    onChange={(e) => patchList('prohibited', e.target.value)} />
                </Field>
                <div className="grid g2" style={{ gap: 12 }}>
                  <Field label={isAr ? 'تركيبات مسموحة (لون + لون في السطر)' : 'Allowed combinations (color + color per line)'}>
                    <textarea className="inp" rows={3} value={combosToLines(kit.combinations_allowed)} disabled={!canManage}
                      onChange={(e) => patchCombo('combinations_allowed', e.target.value)} />
                  </Field>
                  <Field label={isAr ? 'تركيبات متجنَّبة' : 'Avoided combinations'}>
                    <textarea className="inp" rows={3} value={combosToLines(kit.combinations_avoid)} disabled={!canManage}
                      onChange={(e) => patchCombo('combinations_avoid', e.target.value)} />
                  </Field>
                </div>
                <Field label={isAr ? 'المصادر (سطر لكل واحدة)' : 'Sources (one per line)'}>
                  <textarea className="inp" rows={2} value={lines(kit.sources)} disabled={!canManage}
                    onChange={(e) => patchList('sources', e.target.value)} />
                </Field>
              </div>
            </div>

            {/* ── approved design examples ─────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'أمثلة التصميم المعتمدة' : 'Approved design examples'}</h4>
                <span className="r">{isAr ? 'ما يُحتذى — تُضاف من مرصد المنافسين' : 'what “good” looks like — added from Competitor Watch'}</span>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 10 }}>
                {examples.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--mute)' }}>
                    {isAr ? 'لا أمثلة بعد — تُضاف بزر «مثال للدراسة» في مكتبة المحتوى.' : 'No examples yet — added via the “study example” action in the content library.'}
                  </div>
                )}
                {examples.map((ex) => {
                  const url = examplePreviews[ex.subject_id] ?? null;
                  return (
                    <div key={ex.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      {url && (
                        <img src={url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} loading="lazy" />
                      )}
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span className="tag">{ex.subject_kind === 'competitor_post' ? (isAr ? 'منشور منافس' : 'Competitor post') : ex.subject_kind === 'wassel_content' ? (isAr ? 'محتوى وصل' : 'Wassel content') : (isAr ? 'ملف وصل' : 'Wassel file')}</span>
                          <span className="tag tag-t">{ex.example_kind === 'approved_wassel' ? (isAr ? 'معتمد لوصل' : 'Approved for Wassel') : (isAr ? 'للدراسة فقط' : 'Study only')}</span>
                        </div>
                        {ex.strengths.length > 0 && (
                          <div style={{ fontSize: 12, marginTop: 4 }}><b>{isAr ? 'نقاط القوة: ' : 'Strengths: '}</b>{ex.strengths.join(isAr ? '، ' : ', ')}</div>
                        )}
                        {ex.caveats.length > 0 && (
                          <div style={{ fontSize: 12, color: 'var(--late)' }}><b>{isAr ? 'محاذير: ' : 'Caveats: '}</b>{ex.caveats.join(isAr ? '، ' : ', ')}</div>
                        )}
                        {ex.note && <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>{ex.note}</div>}
                      </div>
                      {canReview && (
                        <button type="button" className="btn btn-d btn-sm" onClick={() => void retire(ex)}>
                          {isAr ? 'إخراج' : 'Retire'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
