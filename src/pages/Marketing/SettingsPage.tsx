/**
 * Settings — design screens 25, 17, 26, 27 and 33/37.
 *
 * Four surfaces, one page each:
 *   workflows  — the stages, who owns each, how long it should take
 *   types      — what a Post/Video/Carousel IS, including its writing fields
 *   platforms  — the accounts, and the honest truth about what is connected
 *   roles      — which PERSON currently fills each ROLE
 *
 * The last one matters most: workflow steps point at roles, never people, so
 * replacing whoever fills a role is one change here rather than an edit to
 * every workflow. («الدور لأن الأشخاص يتغيرون».)
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MosAccount, MosContentType, ROLE_LABELS,
  WorkflowDef, fetchSettings,
} from '@/lib/marketingOS/client';
import { useWorkspace, type Capability } from './MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './components/kit';
import {
  IconBack, IconCalendar, IconContent, IconForward, IconRoles, IconSettings,
} from './components/icons';
import SettingsPlatforms from './components/SettingsPlatforms';
import SettingsContentTypes from './components/SettingsContentTypes';
import SettingsWorkflows from './components/SettingsWorkflows';
import SettingsAccess from './components/SettingsAccess';
import SettingsPeople from './components/SettingsPeople';

/* ------------------------------------------------------------------ */
/* index                                                              */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  {
    slug: 'workflows', Icon: IconContent,
    ar: 'مسارات العمل', en: 'Workflows',
    ar_d: 'المراحل، ومن يملك كل مرحلة، وكم يُفترض أن تستغرق.',
    en_d: 'The stages, who owns each one, and how long it should take.',
  },
  {
    slug: 'content-types', Icon: IconSettings,
    ar: 'أنواع المحتوى', en: 'Content types',
    ar_d: 'ما الذي يعنيه «منشور» أو «فيديو» — بادئة الرقم، والمسار، وحقول الكتابة.',
    en_d: 'What a Post or a Video actually is — its ref prefix, its workflow, its writing fields.',
  },
  {
    slug: 'platforms', Icon: IconCalendar,
    ar: 'المنصات والحسابات', en: 'Platforms and accounts',
    ar_d: 'الحسابات التي ننشر عليها، وما هو موصول فعلًا وما ليس كذلك.',
    en_d: 'The accounts we post to, and the honest state of what is connected.',
  },
  {
    slug: 'people', Icon: IconRoles,
    ar: 'الأدوار ومن يشغلها', en: 'Roles and who fills them',
    ar_d: 'خطوات المسار تشير إلى أدوار لا إلى أشخاص. هنا يُحدَّد من يشغل كل دور.',
    en_d: 'Workflow steps point at roles, not people. This is where you say who fills each one.',
  },
  {
    slug: 'roles', Icon: IconRoles,
    ar: 'الأدوار والصلاحيات', en: 'Roles and permissions',
    ar_d: 'من يرى ماذا ومن يفعل ماذا — مصفوفة الشاشات الثلاثية لكل دور.',
    en_d: 'Who sees what and who does what — the three-state screen matrix per role.',
  },
] as const;

export default function SettingsPage() {
  const { isAr, role } = useWorkspace();
  const navigate = useNavigate();
  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;

  return (
    <>
      <PageHead
        title={isAr ? 'الإعدادات' : 'Settings'}
        sub={isAr ? `دورك الحالي: ${roleLabel}` : `You are signed in as ${roleLabel}`}
      />
      <div className="body">
        <div className="grid g2">
          {SECTIONS.map((s) => (
            <button
              key={s.slug}
              type="button"
              className="card"
              style={{ textAlign: 'start', cursor: 'pointer', padding: 0 }}
              onClick={() => navigate(`/m/settings/${s.slug}`)}
            >
              <div className="card-h">
                <s.Icon style={{ width: 16, height: 16, color: 'var(--copper)' }} />
                <h4>{isAr ? s.ar : s.en}</h4>
              </div>
              <div className="card-b" style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.9 }}>
                {isAr ? s.ar_d : s.en_d}
              </div>
            </button>
          ))}
        </div>
      </div>
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
    if (section === 'roles' || section === 'people') { setLoading(false); return; }
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
  // Screens 26/27 render their own header (sub + actions depend on live data).
  const ownHead = section === 'platforms' || section === 'content-types';

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
        {section === 'roles' && <SettingsAccess canManage={can('manage_roles' as Capability)} isAr={isAr} />}
        {section === 'people' && (
          <SettingsPeople workflows={workflows} settings={{}} canManage={can('manage_roles' as Capability)} isAr={isAr} />
        )}
      </div>
    </>
  );
}

/* ── Workflows (screen 17) ────────────────────────────────────────── */



/* ── Roles (screens 33 + 37) ──────────────────────────────────────── */

/** The five grantable roles. Viewer is the ABSENCE of any grant, not a grant. */

/** The capability matrix table also shows what a grant-less viewer can do. */

/** The matrix from screen 33, mirrored from `wassell_mos_can`. */


