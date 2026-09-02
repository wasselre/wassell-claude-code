/**
 * Settings → AI roles (أدوار الذكاء).
 *
 * `mos_settings.ai_roles` as an admin table: every model call in the system is
 * a ROLE resolved from this data (contracts §0.2 — no vendor lock-in in code).
 * Edit a role's provider/model/params; the save is ADDITIVE — keys are never
 * removed from here, so a role another lane depends on can't silently vanish.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { fetchAiRoles, saveAiRoles, type AiRoleConfig } from '@/lib/marketingOS/creativeClient';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num } from '../lib/format';

const PROVIDERS: Array<{ key: string; ar: string; en: string }> = [
  { key: 'anthropic', ar: 'أنثروبيك', en: 'Anthropic' },
  { key: 'fal', ar: 'fal.ai', en: 'fal.ai' },
  { key: 'runner', ar: 'المشغّل المحلي', en: 'Local runner' },
  { key: 'deepseek', ar: 'ديب سيك', en: 'DeepSeek' },
];

/** Friendly Arabic/English names for the roles we know; the raw key otherwise. */
const ROLE_NAMES: Record<string, { ar: string; en: string }> = {
  creative_concepts:    { ar: 'اقتراح أفكار المنشور', en: 'Post concepts' },
  creative_package:     { ar: 'بناء حزمة المنشور', en: 'Post package' },
  creative_derivatives: { ar: 'مشتقات المنشور', en: 'Post derivatives' },
  design_read_slide:    { ar: 'قراءة تصميم الشريحة', en: 'Slide design read' },
  design_read_post:     { ar: 'قراءة تصميم المنشور', en: 'Post design read' },
  asset_enrich_v2:      { ar: 'إثراء الأصول v2', en: 'Asset enrich v2' },
  image_edit:           { ar: 'تعديل الصور', en: 'Image edit' },
  image_generate:       { ar: 'توليد الصور', en: 'Image generate' },
  image_remove_text:    { ar: 'إزالة النص من الصور', en: 'Image remove text' },
};

interface DraftRole {
  provider: string;
  model: string;
  version: string;
  paramsText: string;
}

const toDraft = (cfg: AiRoleConfig): DraftRole => ({
  provider: cfg.provider,
  model: cfg.model,
  version: cfg.version ?? '',
  paramsText: cfg.params ? JSON.stringify(cfg.params, null, 2) : '',
});

export default function SettingsAiRoles({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [roles, setRoles] = useState<Record<string, AiRoleConfig> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftRole>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAiRoles();
      setRoles(res.roles);
      setDrafts(Object.fromEntries(Object.entries(res.roles).map(([k, v]) => [k, toDraft(v)])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const keys = useMemo(() => Object.keys(drafts).sort((a, b) => {
    const an = ROLE_NAMES[a] ? 0 : 1;
    const bn = ROLE_NAMES[b] ? 0 : 1;
    return an - bn || a.localeCompare(b);
  }), [drafts]);

  const patch = (key: string, p: Partial<DraftRole>): void =>
    setDrafts((d) => ({ ...d, [key]: { ...d[key]!, ...p } }));

  const isDirty = (key: string): boolean => {
    if (!roles) return false;
    const orig = roles[key];
    const d = drafts[key];
    if (!orig || !d) return false;
    return JSON.stringify(toDraft(orig)) !== JSON.stringify(d);
  };
  const anyDirty = keys.some(isDirty);

  const save = async (): Promise<void> => {
    if (!roles) return;
    // Validate every edited params blob BEFORE sending — a JSON typo must fail
    // here, loudly, not as a broken role the worker trips over at 3am.
    const next: Record<string, AiRoleConfig> = { ...roles };
    for (const key of keys) {
      const d = drafts[key]!;
      let params: Record<string, unknown> | undefined;
      const text = d.paramsText.trim();
      if (text !== '') {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            addToast(
              isAr ? `معطيات «${key}» يجب أن تكون كائن JSON.` : `Params for “${key}” must be a JSON object.`,
              'error',
            );
            return;
          }
          params = parsed as Record<string, unknown>;
        } catch {
          addToast(
            isAr ? `معطيات «${key}» ليست JSON صالحًا.` : `Params for “${key}” are not valid JSON.`,
            'error',
          );
          return;
        }
      }
      if (!d.provider.trim() || !d.model.trim()) {
        addToast(
          isAr ? `الدور «${key}» يحتاج مزوّدًا ونموذجًا.` : `Role “${key}” needs a provider and a model.`,
          'error',
        );
        return;
      }
      next[key] = {
        provider: d.provider.trim(),
        model: d.model.trim(),
        ...(d.version.trim() ? { version: d.version.trim() } : {}),
        ...(params ? { params } : {}),
      };
    }
    setSaving(true);
    try {
      const res = await saveAiRoles(next);
      setRoles(res.roles);
      setDrafts(Object.fromEntries(Object.entries(res.roles).map(([k, v]) => [k, toDraft(v)])));
      addToast(isAr ? 'حُفظت الأدوار.' : 'Roles saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'أدوار الذكاء' : 'AI roles'}
        sub={isAr
          ? 'كل نداء نموذج في النظام يُحلّ من هذه البيانات — لا مزوّد ثابت في الكود'
          : 'Every model call in the system resolves from this data — no provider is hardcoded'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && roles && (
          <button type="button" className="btn btn-p" disabled={!anyDirty || saving} onClick={() => void save()}>
            {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
          </button>
        )}
      </PageHead>
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={4} />}
        {!loading && !error && roles && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="notice" style={{ fontSize: 12 }}>
              {isAr
                ? `الحفظ إضافي — لا تُحذف الأدوار من هنا أبدًا. ${num(keys.length, true)} دورًا معرّفًا.`
                : `Saving is additive — roles are never removed from here. ${keys.length} roles defined.`}
            </div>
            {keys.map((key) => {
              const d = drafts[key]!;
              const name = ROLE_NAMES[key];
              return (
                <div className="card" key={key}>
                  <div className="card-h">
                    <h4>{name ? (isAr ? name.ar : name.en) : key}</h4>
                    <span className="r ltr" style={{ fontSize: 11 }}>{key}</span>
                    {isDirty(key) && <span className="tag tag-t">{isAr ? 'معدّل' : 'edited'}</span>}
                  </div>
                  <div className="card-b" style={{ display: 'grid', gap: 10 }}>
                    <div className="grid g3" style={{ gap: 10 }}>
                      <label>
                        <span className="lbl">{isAr ? 'المزوّد' : 'Provider'}</span>
                        <select
                          className="inp" style={{ marginTop: 3 }}
                          value={d.provider}
                          disabled={!canManage}
                          onChange={(e) => patch(key, { provider: e.target.value })}
                        >
                          {PROVIDERS.some((p) => p.key === d.provider) ? null : (
                            <option value={d.provider}>{d.provider}</option>
                          )}
                          {PROVIDERS.map((p) => (
                            <option key={p.key} value={p.key}>{isAr ? p.ar : p.en}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span className="lbl">{isAr ? 'النموذج' : 'Model'}</span>
                        <input
                          className="inp ltr" style={{ marginTop: 3 }}
                          value={d.model}
                          disabled={!canManage}
                          onChange={(e) => patch(key, { model: e.target.value })}
                        />
                      </label>
                      <label>
                        <span className="lbl">{isAr ? 'الإصدار (اختياري)' : 'Version (optional)'}</span>
                        <input
                          className="inp ltr" style={{ marginTop: 3 }}
                          value={d.version}
                          disabled={!canManage}
                          onChange={(e) => patch(key, { version: e.target.value })}
                        />
                      </label>
                    </div>
                    <label>
                      <span className="lbl">{isAr ? 'المعطيات (JSON — اختياري)' : 'Params (JSON — optional)'}</span>
                      <textarea
                        className="inp ltr" rows={3} style={{ marginTop: 3, fontFamily: 'monospace', fontSize: 12 }}
                        value={d.paramsText}
                        disabled={!canManage}
                        onChange={(e) => patch(key, { paramsText: e.target.value })}
                        placeholder='{"max_tokens": 2500}'
                      />
                    </label>
                  </div>
                </div>
              );
            })}
            {!canManage && (
              <div className="notice" style={{ fontSize: 12 }}>
                {isAr ? 'التعديل يتطلب صلاحية إدارة الإعدادات.' : 'Editing requires manage-settings.'}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
