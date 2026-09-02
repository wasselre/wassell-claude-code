/**
 * Settings → Creative flags (أعلام الإبداع) + the design role map.
 *
 * The five `mos_settings.creative_writer` switches — every creative lane reads
 * its flag on every tick, so flipping one here is the whole rollback story.
 * Below them, `role_map`: which workflow role OWNS design (sees the designer
 * handoff first) and which role REVIEWS the brand kit. Both are data, never
 * hardcoded role checks (contracts §0.13).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  fetchCreativeFlags, fetchRoleMap, saveCreativeFlags, saveRoleMap,
} from '@/lib/marketingOS/creativeClient';
import type { CreativeFlags, RoleMap } from '@/lib/creative/contracts';
import { ROLE_LABELS, type MosPathRole } from '@/lib/marketingOS/client';
import { Field, LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';

const FLAG_META: Array<{ key: keyof CreativeFlags; ar: string; en: string; ar_d: string; en_d: string }> = [
  {
    key: 'post_enabled',
    ar: 'مدير الإبداع للمنشورات', en: 'Post creative director',
    ar_d: 'زر «اكتب بوست» وتبويب الإبداع على المنشورات والكاروسيل.',
    en_d: 'The “Write post” button and the Creative tab on posts and carousels.',
  },
  {
    key: 'ai_image_execution',
    ar: 'تنفيذ الصور بالذكاء', en: 'AI image execution',
    ar_d: 'السماح بتنفيذ مقترحات الصور المعتمدة فعليًا (تبقى المخرجات مرشّحة للمراجعة).',
    en_d: 'Allow approved image proposals to actually execute (outputs stay review candidates).',
  },
  {
    key: 'design_reads_enabled',
    ar: 'قراءات التصميم', en: 'Design reads',
    ar_d: 'تحليل تصاميم المنافسين بصريًا ليستفيد منها الاسترجاع والتوليد.',
    en_d: 'Visually read competitor designs so retrieval and generation can use them.',
  },
  {
    key: 'asset_enrich_v2',
    ar: 'إثراء الأصول (الإصدار ٢)', en: 'Asset enrichment v2',
    ar_d: 'الإصدار الثاني من إثراء بيانات الملفات (ألوان، مساحة عنوان، نص).',
    en_d: 'Second-generation file enrichment (colors, headline space, text).',
  },
  {
    key: 'backfill_enabled',
    ar: 'الملء الرجعي', en: 'Backfill',
    ar_d: 'معالجة المحتوى والملفات الموجودة مسبقًا على دفعات مضبوطة.',
    en_d: 'Process existing content and files in controlled batches.',
  },
];

const PATH_ROLES: MosPathRole[] = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'];

export default function SettingsCreativeFlags({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [flags, setFlags] = useState<CreativeFlags | null>(null);
  const [roleMap, setRoleMap] = useState<RoleMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, r] = await Promise.all([fetchCreativeFlags(), fetchRoleMap()]);
      setFlags(f.flags);
      setRoleMap(r.role_map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (key: keyof CreativeFlags, value: boolean): Promise<void> => {
    setSavingKey(key);
    try {
      const res = await saveCreativeFlags({ [key]: value });
      setFlags(res.flags);
      addToast(
        value
          ? (isAr ? 'فُعِّل — يسري على الفور.' : 'Enabled — effective immediately.')
          : (isAr ? 'عُطِّل — توقفت المسارات عن قراءته.' : 'Disabled — the lanes stop reading it.'),
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSavingKey(null);
    }
  };

  const saveMap = async (next: RoleMap): Promise<void> => {
    setSavingKey('role_map');
    try {
      const res = await saveRoleMap(next);
      setRoleMap(res.role_map);
      addToast(isAr ? 'حُفظت خريطة الأدوار.' : 'Role map saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'أعلام الإبداع' : 'Creative flags'}
        sub={isAr
          ? 'مفاتيح تشغيل مدير الإبداع — إطفاء أي منها هو التراجع الكامل عن ميزته'
          : 'The creative director’s switches — turning one off is the full rollback of its feature'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      />
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={4} />}
        {!loading && !error && flags && roleMap && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'المفاتيح' : 'Flags'}</h4>
                <span className="r">{isAr ? 'كل مسار يقرأ مفتاحه في كل دورة' : 'every lane re-reads its flag each tick'}</span>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 10 }}>
                {FLAG_META.map((f) => (
                  <div key={f.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <button
                      type="button"
                      className={`sw${flags[f.key] ? ' on' : ''}`}
                      disabled={!canManage || savingKey !== null}
                      aria-label={isAr ? f.ar : f.en}
                      onClick={() => void toggle(f.key, !flags[f.key])}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{isAr ? f.ar : f.en}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.7 }}>{isAr ? f.ar_d : f.en_d}</div>
                    </div>
                  </div>
                ))}
                {!canManage && (
                  <div className="notice" style={{ fontSize: 12 }}>
                    {isAr ? 'التغيير يتطلب صلاحية إدارة الإعدادات.' : 'Changing flags requires manage-settings.'}
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'خريطة أدوار التصميم' : 'Design role map'}</h4>
                <span className="r">{isAr ? 'أدوار لا أشخاص — تُدار كبيانات' : 'roles, not people — managed as data'}</span>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
                <Field
                  label={isAr ? 'مالك التصميم' : 'Design owner'}
                  hint={isAr ? 'يرى «التسليم للمصمم» أولًا عند فتح المحتوى' : 'sees the designer handoff first when opening content'}
                >
                  <select
                    className="inp"
                    value={roleMap.design_owner}
                    disabled={!canManage || savingKey !== null}
                    onChange={(e) => void saveMap({ ...roleMap, design_owner: e.target.value })}
                  >
                    {PATH_ROLES.map((r) => (
                      <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={isAr ? 'مراجع عدة الهوية' : 'Brand-kit reviewer'}
                  hint={isAr ? 'اعتماد عدة الهوية يحوّلها من استشارية إلى إلزامية' : 'approving the brand kit moves it from advisory to constraint'}
                >
                  <select
                    className="inp"
                    value={roleMap.design_reviewer}
                    disabled={!canManage || savingKey !== null}
                    onChange={(e) => void saveMap({ ...roleMap, design_reviewer: e.target.value })}
                  >
                    {PATH_ROLES.map((r) => (
                      <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
