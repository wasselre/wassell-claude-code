/**
 * Settings — design screens 25 (home), 17, 26, 27, 33/37 and 43.
 *
 * The home (screen 25) is an index of STATE, not of names: every card declares
 * its current truth — «٠ من ٥ مربوطة» belongs on the index, not two screens
 * deep where you discover it when a publish fails. Values come live from
 * `settings_data` (workflows, accounts, types, mos_settings, notification
 * rules) plus the people directory the workspace already carries; threshold
 * edits go through `settings_save`.
 *
 * Section pages:
 *   workflows     — the stages, who owns each, how long it should take (s17)
 *   content-types — what a Post/Video IS, including its writing fields (s27)
 *   platforms     — the accounts, and the honest truth about connections (s26)
 *   people        — which PERSON currently fills each ROLE (s37)
 *   roles         — the three-state screen matrix per role (s33)
 *   notifications — when the system interrupts each role (s43)
 */
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosAccount, MosContentType, ROLE_LABELS, SettingsData,
  WorkflowDef, fetchContentList, fetchSettings, saveSetting,
} from '@/lib/marketingOS/client';
import { useWorkspace, type Capability } from './MarketingWorkspace';
import { Field, LoadError, Modal, PageHead, Skeleton } from './components/kit';
import { IconBack, IconForward } from './components/icons';
import SettingsPlatforms from './components/SettingsPlatforms';
import SettingsContentTypes from './components/SettingsContentTypes';
import SettingsMeasures from './components/SettingsMeasures';
import SettingsAudiences from './components/SettingsAudiences';
import SettingsWorkflows from './components/SettingsWorkflows';
import SettingsAccess from './components/SettingsAccess';
import SettingsPeople from './components/SettingsPeople';
import SettingsNotifications from './components/SettingsNotifications';
import SettingsLoad from './components/SettingsLoad';
import SettingsCadence from './components/SettingsCadence';
import { num } from './lib/format';
import './styles/settings-engine.css';

/* ------------------------------------------------------------------ */
/* sections                                                           */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  {
    slug: 'workflows',
    ar: 'مسارات العمل', en: 'Workflows',
    ar_d: 'المراحل، ومن يملك كل مرحلة، وكم يُفترض أن تستغرق.',
    en_d: 'The stages, who owns each one, and how long it should take.',
  },
  {
    slug: 'content-types',
    ar: 'أنواع المحتوى', en: 'Content types',
    ar_d: 'ما الذي يعنيه «منشور» أو «فيديو» — بادئة الرقم، والمسار، وحقول الكتابة.',
    en_d: 'What a Post or a Video actually is — its ref prefix, its workflow, its writing fields.',
  },
  {
    slug: 'measures',
    ar: 'معايير النجاح', en: 'Success measures',
    ar_d: 'المعايير التي تُحكم بها الحملات — العدد أو التكلفة، والأكثر أو الأقل أفضل.',
    en_d: 'The measures campaigns are judged by — a count or a cost, higher- or lower-is-better.',
  },
  {
    slug: 'audiences',
    ar: 'الجماهير', en: 'Audiences',
    ar_d: 'الجماهير المحفوظة التي تُختار في موجز الحملة — اسم وتفاصيل، قابلة لإعادة الاستخدام.',
    en_d: 'The saved audiences picked in the campaign brief — a name and details, reusable across campaigns.',
  },
  {
    slug: 'platforms',
    ar: 'المنصات والحسابات', en: 'Platforms and accounts',
    ar_d: 'الحسابات التي ننشر عليها، وما هو موصول فعلًا وما ليس كذلك.',
    en_d: 'The accounts we post to, and the honest state of what is connected.',
  },
  {
    slug: 'people',
    ar: 'الأدوار ومن يشغلها', en: 'Roles and who fills them',
    ar_d: 'خطوات المسار تشير إلى أدوار لا إلى أشخاص. هنا يُحدَّد من يشغل كل دور.',
    en_d: 'Workflow steps point at roles, not people. This is where you say who fills each one.',
  },
  {
    slug: 'roles',
    ar: 'الأدوار والصلاحيات', en: 'Roles and permissions',
    ar_d: 'من يرى ماذا ومن يفعل ماذا — مصفوفة الشاشات الثلاثية لكل دور.',
    en_d: 'Who sees what and who does what — the three-state screen matrix per role.',
  },
  {
    slug: 'load',
    ar: 'طاقة العمل والمُهَل', en: 'Load & SLA',
    ar_d: 'كم مهمة جديدة يوميًا لكل دور، وكم ساعة تُمهَل كل مهمة قبل التأخير.',
    en_d: 'How many new tasks per role per day, and the hours each task gets before it counts late.',
  },
  {
    slug: 'cadence',
    ar: 'إيقاع النشر', en: 'Posting cadence',
    ar_d: 'كم منشورًا وفيديو نريد يوميًا على كل منصة — أهداف تقويم التغطية.',
    en_d: 'How many posts and videos we want per platform per day — the coverage calendar\'s targets.',
  },
  {
    slug: 'notifications',
    ar: 'الإشعارات', en: 'Notifications',
    ar_d: 'متى يقاطع النظام أحدًا — فتح مهمة، أو مرور موعد، أو حلول وقت النشر.',
    en_d: 'When the system interrupts someone — a task opening, a deadline passing, publish time arriving.',
  },
] as const;

/* ------------------------------------------------------------------ */
/* helpers — mos_settings values arrive as unknown jsonb               */
/* ------------------------------------------------------------------ */

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

interface HomeView {
  rawSig: Record<string, unknown>;
  rawAttr: Record<string, unknown>;
  rawShoot: Record<string, unknown>;
  rawExt: Record<string, unknown>;
  sigAmount: number;
  attrDays: number;
  attrTouch: 'first' | 'last';
  shootMin: number;
  shootWait: number;
  extEnabled: boolean;
  connected: number;
  totalAccounts: number;
  typesCount: number;
  typeNames: string;
  wfCount: number;
  longestSteps: number;
  longestName: string;
  ruleEventCount: number;
  rolesCount: number;
  peopleCount: number;
  noBackup: boolean;
}

/* ── the index-card icons, transcribed from the mockup's SVGs ──────── */

const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeLinecap: 'round', strokeLinejoin: 'round',
} as const;

const IC = {
  workflows: <svg {...svgProps}><path d="M4 6h16M4 12h10M4 18h13" /></svg>,
  platforms: <svg {...svgProps}><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>,
  types: <svg {...svgProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></svg>,
  people: <svg {...svgProps}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0112 0M16 11a3 3 0 100-6M18 20a5 5 0 00-2-4" /></svg>,
  bell: <svg {...svgProps}><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20h4" /></svg>,
  campaigns: <svg {...svgProps}><path d="M3 11v3l14 5V6L3 11z" /><path d="M17 9a3 3 0 010 6" /></svg>,
  matrix: <svg {...svgProps}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></svg>,
};

/* ── one state-declaring index card (the mockup's exact anatomy) ───── */

function IndexCard({
  icon, late, title, desc, tags, action, actionPrimary, onOpen,
}: {
  icon: ReactNode;
  late?: boolean;
  title: string;
  desc: string;
  tags: ReactNode;
  action: string;
  actionPrimary?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="card"
      style={{
        textAlign: 'start', cursor: 'pointer', padding: 0,
        ...(late ? { borderColor: 'color-mix(in srgb, var(--late) 40%, transparent)' } : {}),
      }}
      onClick={onOpen}
    >
      <div className="card-b" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div className={`se-ic${late ? ' late' : ''}`}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginTop: 3, lineHeight: 1.75 }}>{desc}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>{tags}</div>
        </div>
        <span className={`btn btn-sm${actionPrimary ? ' btn-p' : ''}`}>{action}</span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* the thresholds editor — «edits via settings_save»                   */
/* ------------------------------------------------------------------ */

function ThresholdsModal({
  view, canManage, isAr, onClose, onSaved,
}: {
  view: HomeView;
  canManage: boolean;
  isAr: boolean;
  onClose: () => void;
  onSaved: (settings: Record<string, unknown>) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [sigAmount, setSigAmount] = useState(String(view.sigAmount));
  const [attrDays, setAttrDays] = useState(String(view.attrDays));
  const [attrTouch, setAttrTouch] = useState<'first' | 'last'>(view.attrTouch);
  const [shootMin, setShootMin] = useState(String(view.shootMin));
  const [shootWait, setShootWait] = useState(String(view.shootWait));
  const [extEnabled, setExtEnabled] = useState(view.extEnabled);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const sig = Number(sigAmount);
    const days = Number(attrDays);
    const min = Number(shootMin);
    const wait = Number(shootWait);
    if (![sig, days, min, wait].every((n) => Number.isFinite(n) && n > 0)) {
      addToast(
        isAr ? 'كل القيم يجب أن تكون أرقامًا موجبة.' : 'Every value must be a positive number.',
        'error',
      );
      return;
    }
    setSaving(true);
    try {
      // Merge over the stored objects so unrelated keys survive the save.
      await saveSetting('signature_threshold', { ...view.rawSig, amount: sig, currency: 'SAR' });
      await saveSetting('attribution', { ...view.rawAttr, window_days: days, touch: attrTouch });
      await saveSetting('shoot_grouping_thresholds', { ...view.rawShoot, min_shots: min, max_wait_days: wait });
      const last = await saveSetting('external_effects', { ...view.rawExt, enabled: extEnabled });
      onSaved(last.settings);
      onClose();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'قيم التشغيل' : 'Operating thresholds'}
      sub={isAr
        ? 'أرقام تُقرأ كبيانات في كل مكان — تغييرها هنا يسري على الحملات والتصوير والإسناد فورًا.'
        : 'Numbers the whole module reads as data — changing them here applies to campaigns, shoots and attribution immediately.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {isAr ? 'إغلاق' : 'Close'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={!canManage || saving}
            onClick={() => void save()}
          >
            {isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <Field
          label={isAr ? 'حد توقيع الميزانية (ر.س)' : 'Budget signature threshold (SAR)'}
          hint={isAr ? 'الحملة عند هذا المبلغ أو فوقه تنتظر توقيع الرئيس' : 'A campaign at or above this amount waits for the CEO signature'}
        >
          <input
            className="inp" type="number" min={1} value={sigAmount} disabled={!canManage}
            onChange={(e) => setSigAmount(e.target.value)}
          />
        </Field>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label={isAr ? 'نافذة الإسناد (يوم)' : 'Attribution window (days)'}>
            <input
              className="inp" type="number" min={1} value={attrDays} disabled={!canManage}
              onChange={(e) => setAttrDays(e.target.value)}
            />
          </Field>
          <Field label={isAr ? 'لمسة الإسناد' : 'Attribution touch'}>
            <select
              className="inp" value={attrTouch} disabled={!canManage}
              onChange={(e) => setAttrTouch(e.target.value === 'last' ? 'last' : 'first')}
            >
              <option value="first">{isAr ? 'اللمسة الأولى' : 'First touch'}</option>
              <option value="last">{isAr ? 'اللمسة الأخيرة' : 'Last touch'}</option>
            </select>
          </Field>
        </div>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field
            label={isAr ? 'تجميع التصوير — الحد الأدنى للقطات' : 'Shoot grouping — minimum shots'}
            hint={isAr ? 'المشاهد الناقصة تتجمع في طلب تصوير عند بلوغ أي من الحدين' : 'Missing scenes roll into one request once either bound is hit'}
          >
            <input
              className="inp" type="number" min={1} value={shootMin} disabled={!canManage}
              onChange={(e) => setShootMin(e.target.value)}
            />
          </Field>
          <Field label={isAr ? 'تجميع التصوير — أقصى انتظار (يوم)' : 'Shoot grouping — max wait (days)'}>
            <input
              className="inp" type="number" min={1} value={shootWait} disabled={!canManage}
              onChange={(e) => setShootWait(e.target.value)}
            />
          </Field>
        </div>
        <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13, cursor: canManage ? 'pointer' : 'default' }}>
          <input
            type="checkbox" checked={extEnabled} disabled={!canManage}
            onChange={(e) => setExtEnabled(e.target.checked)}
          />
          <span>
            {isAr
              ? 'القنوات الخارجية مفعّلة — إشعارات واتساب والدفع تُرسل فعلًا'
              : 'External effects on — WhatsApp and push notifications actually send'}
          </span>
        </label>
        {!canManage && (
          <div className="notice" style={{ fontSize: 12 }}>
            {isAr ? 'التعديل يتطلب صلاحية إدارة الإعدادات.' : 'Editing requires the manage-settings capability.'}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* the home — screen 25                                                */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const { isAr, role, people, can } = useWorkspace();
  const navigate = useNavigate();
  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;
  const canManage = can('manage_settings' as Capability);

  const [data, setData] = useState<SettingsData | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, content] = await Promise.all([fetchSettings(), fetchContentList()]);
      setData(settings);
      setInFlight(content.content.filter(
        (r) => r.status_key !== 'done' && r.status_key !== 'draft' && r.status_key !== 'unassigned',
      ).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const view = useMemo((): HomeView | null => {
    if (!data) return null;
    const rawSig = asRecord(data.settings.signature_threshold);
    const rawAttr = asRecord(data.settings.attribution);
    const rawShoot = asRecord(data.settings.shoot_grouping_thresholds);
    const rawExt = asRecord(data.settings.external_effects);
    const types = data.content_types.filter((t) => t.is_active);
    const longest = data.workflows.reduce<WorkflowDef | null>(
      (best, w) => (!best || w.steps.length > best.steps.length ? w : best),
      null,
    );
    const roleKeys = data.surface.roles.map((r) => r.key);
    const holders = (rk: string): number =>
      people.filter((p) => (p.roles as string[]).includes(rk)).length;
    const approvalRoles = new Set(
      data.workflows.flatMap((w) => w.steps.filter((s) => s.is_approval).map((s) => s.role_key)),
    );
    return {
      rawSig, rawAttr, rawShoot, rawExt,
      sigAmount: asNum(rawSig.amount) ?? 50_000,
      attrDays: asNum(rawAttr.window_days) ?? 90,
      attrTouch: rawAttr.touch === 'last' ? 'last' : 'first',
      shootMin: asNum(rawShoot.min_shots) ?? 4,
      shootWait: asNum(rawShoot.max_wait_days) ?? 14,
      extEnabled: rawExt.enabled !== false,
      connected: data.accounts.filter((a) => a.is_connected).length,
      totalAccounts: data.accounts.length,
      typesCount: types.length,
      typeNames: types.map((t) => (isAr ? t.label_ar : t.label_en)).join(' · '),
      wfCount: data.workflows.length,
      longestSteps: longest?.steps.length ?? 0,
      longestName: longest ? (isAr ? longest.label_ar : longest.label_en) : '',
      ruleEventCount: new Set(
        data.notification_rules.filter((r) => r.enabled).map((r) => r.event),
      ).size,
      rolesCount: roleKeys.length,
      peopleCount: people.filter((p) => p.roles.some((r) => roleKeys.includes(r))).length,
      noBackup: [...approvalRoles].some((rk) => holders(rk) <= 1),
    };
  }, [data, people, isAr]);

  return (
    <>
      <PageHead
        title={isAr ? 'الإعدادات' : 'Settings'}
        sub={isAr ? `دورك الحالي: ${roleLabel}` : `You are signed in as ${roleLabel}`}
      />
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}
        {!loading && !error && view && (
          <>
            <div className="grid g2" style={{ gap: 13 }}>
              <IndexCard
                icon={IC.workflows}
                title={isAr ? 'مسارات العمل' : 'Workflows'}
                desc={isAr
                  ? 'المراحل التي يمر بها كل نوع محتوى، ومن يؤدي كل مرحلة، وماذا يفعل الرفض.'
                  : 'The stages every content type moves through, who performs each one, and what a rejection does.'}
                tags={
                  <>
                    <span className="tag">{isAr ? `${num(view.wfCount, true)} مسارات` : `${view.wfCount} workflows`}</span>
                    {view.longestSteps > 0 && (
                      <span className="tag">
                        {isAr
                          ? `${num(view.longestSteps, true)} خطوات · ${view.longestName}`
                          : `${view.longestSteps} steps · ${view.longestName}`}
                      </span>
                    )}
                    <span className="tag">{isAr ? `${num(inFlight, true)} سجلات جارية` : `${inFlight} records in flight`}</span>
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/workflows')}
              />

              <IndexCard
                icon={IC.platforms}
                late={view.connected === 0}
                title={isAr ? 'المنصات والحسابات' : 'Platforms and accounts'}
                desc={isAr
                  ? 'ربط انستقرام وتيك توك وغيرها — للنشر، ولسحب الأداء.'
                  : 'Connecting Instagram, TikTok and the rest — to publish, and to pull performance.'}
                tags={
                  <>
                    <span className={`pill ${view.connected === 0 ? 'p-late' : 'p-go'}`}>
                      {isAr
                        ? `${num(view.connected, true)} من ${num(view.totalAccounts, true)} مربوطة`
                        : `${view.connected} of ${view.totalAccounts} connected`}
                    </span>
                    {view.connected === 0 && (
                      <span className="tag tag-t">{isAr ? 'كل شيء يدوي' : 'Everything is manual'}</span>
                    )}
                  </>
                }
                action={view.connected === 0 ? (isAr ? 'إعداد' : 'Set up') : (isAr ? 'فتح' : 'Open')}
                actionPrimary={view.connected === 0}
                onOpen={() => navigate('/m/settings/platforms')}
              />

              <IndexCard
                icon={IC.types}
                title={isAr ? 'أنواع المحتوى' : 'Content types'}
                desc={isAr
                  ? 'الأنواع الموجودة، والمسار الذي يستخدمه كل نوع، والحقول التي تظهر عند فتحه.'
                  : 'The types that exist, the workflow each one uses, and the fields that appear when it opens.'}
                tags={
                  <>
                    <span className="tag">{isAr ? `${num(view.typesCount, true)} أنواع` : `${view.typesCount} types`}</span>
                    {view.typeNames && <span className="tag">{view.typeNames}</span>}
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/content-types')}
              />

              <IndexCard
                icon={IC.campaigns}
                title={isAr ? 'معايير النجاح' : 'Success measures'}
                desc={isAr
                  ? 'المعايير التي تُحكم بها الحملات. أضف نوعًا جديدًا هنا أو مباشرةً في موجز الحملة.'
                  : 'The measures campaigns are judged by. Add a new type here or straight from a campaign brief.'}
                tags={
                  <>
                    <span className="tag">{isAr ? 'عدد · تكلفة' : 'Count · Cost'}</span>
                    <span className="tag">{isAr ? 'الأكثر/الأقل أفضل' : 'Higher/lower is better'}</span>
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/measures')}
              />

              <IndexCard
                icon={IC.people}
                title={isAr ? 'الجماهير' : 'Audiences'}
                desc={isAr
                  ? 'الجماهير المحفوظة التي تُختار في موجز الحملة. أضف واحدًا هنا أو مباشرةً في الموجز.'
                  : 'The saved audiences picked in the campaign brief. Add one here or straight from a brief.'}
                tags={
                  <span className="tag">{isAr ? 'اسم · تفاصيل' : 'Name · Details'}</span>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/audiences')}
              />

              <IndexCard
                icon={IC.people}
                title={isAr ? 'الأدوار والأشخاص' : 'Roles and people'}
                desc={isAr
                  ? 'من يشغل كل دور. الخطوات تشير إلى أدوار، فاستبدال شخص تغيير واحد هنا.'
                  : 'Who fills each role. Steps point at roles, so replacing a person is one change here.'}
                tags={
                  <>
                    <span className="tag">{isAr ? `${num(view.rolesCount, true)} أدوار` : `${view.rolesCount} roles`}</span>
                    <span className="tag">{isAr ? `${num(view.peopleCount, true)} أشخاص` : `${view.peopleCount} people`}</span>
                    {view.noBackup && (
                      <span className="pill p-wait">{isAr ? 'لا بديل للاعتمادات' : 'No backup for approvals'}</span>
                    )}
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/people')}
              />

              <IndexCard
                icon={IC.bell}
                title={isAr ? 'الإشعارات' : 'Notifications'}
                desc={isAr
                  ? 'متى يقاطع النظام أحدًا — فتح مهمة، أو مرور موعد، أو حلول وقت النشر.'
                  : 'When the system interrupts someone — a task opening, a deadline passing, publish time arriving.'}
                tags={
                  <>
                    <span className="tag">
                      {view.extEnabled
                        ? (isAr ? 'داخل التطبيق + واتساب' : 'In-app + WhatsApp')
                        : (isAr ? 'داخل التطبيق فقط — القنوات الخارجية معطّلة' : 'In-app only — external channels off')}
                    </span>
                    <span className="tag">{isAr ? `${num(view.ruleEventCount, true)} قواعد` : `${view.ruleEventCount} rules`}</span>
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/notifications')}
              />

              <IndexCard
                icon={IC.matrix}
                title={isAr ? 'طاقة العمل والمُهَل' : 'Load & SLA'}
                desc={isAr
                  ? 'كم مهمة جديدة تصل لكل دور يوميًا، وكم ساعة تُمهَل كل مهمة قبل اعتبارها متأخرة.'
                  : 'How many new tasks land per role per day, and the hours each task gets before it counts late.'}
                tags={
                  <>
                    <span className="tag">{isAr ? 'الكاتب ١٠ + ٣ يوميًا' : 'Writer 10 + 3 /day'}</span>
                    <span className="tag">{isAr ? 'المونتير ٤ + ٢ يوميًا' : 'Montage 4 + 2 /day'}</span>
                    <span className="tag">{isAr ? 'مُهَل ٤–٢٤ ساعة' : 'SLAs 4–24h'}</span>
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/load')}
              />

              <IndexCard
                icon={IC.bell}
                title={isAr ? 'إيقاع النشر' : 'Posting cadence'}
                desc={isAr
                  ? 'كم منشورًا وفيديو نريد يوميًا على كل منصة — أهداف تقويم التغطية.'
                  : 'How many posts and videos we want per platform per day — the coverage calendar\'s targets.'}
                tags={
                  <>
                    <span className="tag">{isAr ? 'الهدف مقابل المنشور فعلًا' : 'Target vs published'}</span>
                    <span className="tag">{isAr ? 'ينبّه ولا ينشر بالنيابة' : 'Nudges, never auto-posts'}</span>
                  </>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/cadence')}
              />

              <IndexCard
                icon={IC.campaigns}
                title={isAr ? 'أنواع الحملات' : 'Campaign types'}
                desc={isAr
                  ? 'الحقول التي تطلبها الحملة المدفوعة مقابل العضوية، ومعايير النجاح الافتراضية.'
                  : 'What a paid campaign asks for versus an organic one, and the default success criteria.'}
                tags={
                  <>
                    <span className="tag">{isAr ? 'نوعان' : 'Two kinds'}</span>
                    <span className="tag">{isAr ? 'مدفوعة · عضوية' : 'Paid · Organic'}</span>
                    <span className="tag">
                      {isAr
                        ? `التوقيع فوق ${num(view.sigAmount, true)} ر.س`
                        : `Signature above ${num(view.sigAmount, false)} SAR`}
                    </span>
                    <span className="tag">
                      {isAr
                        ? `الإسناد ${num(view.attrDays, true)} يومًا`
                        : `Attribution ${view.attrDays} days`}
                    </span>
                    <span className="tag">
                      {isAr
                        ? `التصوير: ${num(view.shootMin, true)} لقطات أو ${num(view.shootWait, true)} يومًا`
                        : `Shoots: ${view.shootMin} shots or ${view.shootWait} days`}
                    </span>
                  </>
                }
                action={isAr ? 'تعديل' : 'Edit'}
                onOpen={() => setEditOpen(true)}
              />

              <IndexCard
                icon={IC.matrix}
                title={isAr ? 'الأدوار والصلاحيات' : 'Roles and permissions'}
                desc={isAr
                  ? 'من يرى ماذا ومن يفعل ماذا — مصفوفة الشاشات الثلاثية لكل دور.'
                  : 'Who sees what and who does what — the three-state screen matrix per role.'}
                tags={
                  <span className="tag">
                    {isAr ? `${num(view.rolesCount, true)} أدوار · ثلاث حالات لكل شاشة` : `${view.rolesCount} roles · three states per surface`}
                  </span>
                }
                action={isAr ? 'فتح' : 'Open'}
                onOpen={() => navigate('/m/settings/roles')}
              />
            </div>

            {/* The risk banner — shown while both declared risks actually hold. */}
            {view.connected === 0 && view.noBackup && (
              <div className="se-banner">
                <b>{isAr ? 'صفّان يحملان تحذيرًا.' : 'Two rows carry a warning.'}</b>{' '}
                {isAr
                  ? 'لا شيء مربوط، فكل نشر وكل رقم يدوي؛ ولا يوجد بديل لأي دور، فتتوقف الاعتمادات تمامًا حين يسافر مدير التسويق. كلاهما مشكلة إعداد لا مشكلة برمجة — ولهذا بالضبط يعلنهما الفهرس.'
                  : 'Nothing is connected, so every publish and every number is manual; and no role has a backup, so approvals stop entirely when the Marketing Manager travels. Both are setup problems, not code problems — which is exactly why the index declares them.'}
              </div>
            )}
          </>
        )}
      </div>

      {editOpen && view && (
        <ThresholdsModal
          view={view}
          canManage={canManage}
          isAr={isAr}
          onClose={() => setEditOpen(false)}
          onSaved={(settings) => setData((d) => (d ? { ...d, settings } : d))}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* section pages                                                      */
/* ------------------------------------------------------------------ */

export function SettingsSectionPage() {
  const { section } = useParams<{ section: string }>();
  const { isAr, can } = useWorkspace();
  const navigate = useNavigate();

  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [types, setTypes] = useState<MosContentType[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // These three fetch their own data (people/roles) or none at all
    // (notifications loads its rules itself) — settings_data would be waste.
    if (section === 'roles' || section === 'people' || section === 'notifications'
        || section === 'measures' || section === 'audiences'
        || section === 'load' || section === 'cadence') {
      // These fetch their own data (or none) — settings_data would be waste.
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSettings();
      setWorkflows(res.workflows);
      setTypes(res.content_types);
      setAccounts(res.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [section]);

  useEffect(() => { void load(); }, [load]);

  const meta = SECTIONS.find((s) => s.slug === section);
  const Back = isAr ? IconForward : IconBack;
  const canManage = can('manage_settings' as Capability);
  // Screens 26/27/43 render their own header (sub + actions depend on live data).
  const ownHead = section === 'platforms' || section === 'content-types' || section === 'notifications' || section === 'measures' || section === 'audiences' || section === 'load' || section === 'cadence';

  if (!meta) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'قسم غير معروف.' : 'Unknown settings section.'}</div>
      </div>
    );
  }

  if (ownHead) {
    return (
      <>
        {error && <div className="body"><LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>}
        {loading && <div className="body"><Skeleton rows={5} /></div>}
        {!loading && section === 'platforms' && (
          <SettingsPlatforms accounts={accounts} canManage={canManage} isAr={isAr} onAccounts={setAccounts} />
        )}
        {!loading && section === 'content-types' && (
          <SettingsContentTypes
            types={types}
            workflows={workflows}
            canManage={canManage}
            isAr={isAr}
            onTypes={setTypes}
          />
        )}
        {!loading && section === 'notifications' && (
          <SettingsNotifications canManage={canManage} isAr={isAr} />
        )}
        {!loading && section === 'measures' && (
          <SettingsMeasures canManage={canManage} isAr={isAr} />
        )}
        {!loading && section === 'audiences' && (
          <SettingsAudiences canManage={canManage} isAr={isAr} />
        )}
        {!loading && section === 'load' && (
          <SettingsLoad canManage={can('manage_roles')} isAr={isAr} />
        )}
        {!loading && section === 'cadence' && (
          <SettingsCadence canManage={can('manage_roles')} isAr={isAr} />
        )}
      </>
    );
  }

  return (
    <>
      <PageHead
        title={isAr ? meta.ar : meta.en}
        sub={isAr ? meta.ar_d : meta.en_d}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      />
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={5} />}

        {!loading && section === 'workflows' && (
          <SettingsWorkflows
            workflows={workflows}
            canManage={canManage}
            isAr={isAr}
            onWorkflow={(saved) =>
              setWorkflows((ws) => ws.map((w) => (w.id === saved.id ? saved : w)))}
          />
        )}
        {section === 'roles' && <SettingsAccess canManage={can('manage_roles')} isAr={isAr} />}
        {section === 'people' && (
          <SettingsPeople workflows={workflows} settings={{}} canManage={can('manage_roles')} isAr={isAr} />
        )}
      </div>
    </>
  );
}
