/**
 * Settings → Platforms and accounts — design screen 26, rebuilt.
 *
 * One card per platform account. Each card is honest about the split the
 * design insists on: PUBLISHING and READING METRICS are two different
 * permission scopes with two different consent burdens, so each capability
 * line carries its own state pill. The access token is a third line because
 * it expires on its own clock.
 *
 * There is deliberately NO OAuth flow here: «النشر يبقى يدويًا» is a decision,
 * not a missing feature. The only real edits are the account's metadata
 * (handle + labels) via account_save — the same action as before this rebuild.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosAccount, PLATFORM_LABELS, fetchPublications, saveAccount,
} from '@/lib/marketingOS/client';
import { Field, Modal, PageHead, Pill, type Tone } from './kit';
import { IconBack, IconForward, IconPlus } from './icons';
import { num, shortDate } from '../lib/format';

/* ------------------------------------------------------------------ */
/* per-platform card copy, transcribed from s26.html                    */
/* ------------------------------------------------------------------ */

type CapPill = 'publish' | 'metrics' | 'token' | 'none';

interface CapDef {
  lbl_ar: string; lbl_en: string;
  text_ar: string; text_en: string;
  pill: CapPill;
  /** The meta-ads «الأولوية» column renders copper, not ink. */
  accent?: boolean;
}

interface PlatformCardDef {
  initials: string;
  bg: string;
  fg: string;
  /** snapchat/google are the dimmed single-line cards of the mockup. */
  compact?: boolean;
  /** Replaces the «الحساب @… · N عمليات» line (meta ads). */
  sub_ar?: string; sub_en?: string;
  tag_ar?: string; tag_en?: string;
  caps: CapDef[];
}

const PUBLISH_LBL = { lbl_ar: 'النشر', lbl_en: 'Publishing' };
const METRICS_LBL = { lbl_ar: 'الأداء', lbl_en: 'Metrics' };
const TOKEN_LBL = { lbl_ar: 'رمز الوصول', lbl_en: 'Access token' };

const PLATFORM_CARDS: Record<string, PlatformCardDef> = {
  instagram: {
    initials: 'IG', bg: '#C13584', fg: '#fff',
    caps: [
      {
        ...PUBLISH_LBL, pill: 'publish',
        text_ar: 'المنشورات المجدولة تخرج وحدها. يتطلب حساب أعمال مرتبطًا بصفحة فيسبوك، ومراجعة تطبيق من ميتا.',
        text_en: 'Scheduled posts go out on their own. Requires a business account linked to a Facebook page, and a Meta app review.',
      },
      {
        ...METRICS_LBL, pill: 'metrics',
        text_ar: 'المشاهدات والوصول والحفظ والتعليقات تُسحب يوميًا كلقطات مؤرَّخة. نفس الحساب بصلاحيات أقل.',
        text_en: 'Views, reach, saves and comments pulled daily as dated snapshots. Same account, smaller scope.',
      },
      {
        ...TOKEN_LBL, pill: 'token',
        text_ar: 'ينتهي كل ٦٠ يومًا. ينبّه النظام قبلها بسبعة أيام.',
        text_en: 'Expires every 60 days. The system warns seven days before.',
      },
    ],
  },
  tiktok: {
    initials: 'TT', bg: 'var(--ink)', fg: 'var(--paper)',
    caps: [
      {
        ...PUBLISH_LBL, pill: 'publish',
        text_ar: 'يمكن دفع الفيديو كمسودة إلى التطبيق ليؤكدها إنسان — خطوة وسطى جيدة.',
        text_en: 'The video can be pushed to the app as a draft for a human to confirm — a good middle step.',
      },
      {
        ...METRICS_LBL, pill: 'metrics',
        text_ar: 'المشاهدات ومدة المشاهدة ونسبة الإكمال. مدة المشاهدة هي الرقم الذي يتنبأ فعلًا بجودة الفيديو.',
        text_en: 'Views, watch time and completion rate. Watch time is the number that actually predicts video quality.',
      },
      {
        ...TOKEN_LBL, pill: 'token',
        text_ar: 'يتجدد تلقائيًا بعد الموافقة.',
        text_en: 'Renews automatically once approved.',
      },
    ],
  },
  meta: {
    initials: 'Ads', bg: '#C13584', fg: '#fff',
    sub_ar: 'الحساب الإعلاني · يشغّل زر المزامنة في شاشة ٢١',
    sub_en: 'The ad account · drives the sync button on screen 21',
    tag_ar: 'منفصل عن انستقرام', tag_en: 'separate from Instagram',
    caps: [
      {
        lbl_ar: 'الإنفاق والنتائج', lbl_en: 'Spend and results', pill: 'metrics',
        text_ar: 'الإنفاق اليومي والظهور والنقرات والعملاء لكل إعلان — ويلغي الإدخال اليدوي من كل شاشات الحملات.',
        text_en: 'Daily spend, impressions, clicks and leads per ad — and it ends manual entry across every campaign screen.',
      },
      {
        lbl_ar: 'تسليم العملاء', lbl_en: 'Lead delivery', pill: 'metrics',
        text_ar: 'نماذج العملاء تصل كسجلات في النظام خلال ثوانٍ، وعليها ختم الحملة والإعلان.',
        text_en: 'Lead forms arrive as CRM records within seconds, stamped with their campaign and ad.',
      },
      {
        lbl_ar: 'الأولوية', lbl_en: 'Priority', pill: 'none', accent: true,
        text_ar: 'الأعلى قيمة بين الخمسة.',
        text_en: 'The highest value of the five.',
      },
    ],
  },
  snapchat: {
    initials: 'SC', bg: '#C8B400', fg: '#3F3F3F', compact: true,
    sub_ar: 'لا توجد واجهة نشر للستوري — الأداء فقط، وسيبقى إدخاله يدويًا أو عبر استخراج.',
    sub_en: 'No story-publishing API — metrics only, and those stay manual or extracted.',
    caps: [],
  },
  google: {
    initials: 'G', bg: '#4285F4', fg: '#fff', compact: true,
    sub_ar: 'الإنفاق والتحويلات لحملات البحث الإعلانية. أرخص عميل مؤهل في الحملة الحالية.',
    sub_en: 'Spend and conversions for search ad campaigns. The cheapest qualified lead in the current campaign.',
    caps: [],
  },
};

/** Any platform without bespoke mockup copy gets the honest generic card. */
function fallbackCard(platform: string): PlatformCardDef {
  const label = PLATFORM_LABELS[platform]?.en ?? platform;
  return {
    initials: label.slice(0, 2).toUpperCase(),
    bg: 'var(--ink)', fg: 'var(--paper)',
    caps: [
      {
        ...PUBLISH_LBL, pill: 'publish',
        text_ar: 'النشر يدوي اليوم بقرار — لا ربط تلقائي.',
        text_en: 'Publishing is manual by decision — no automatic link.',
      },
      {
        ...METRICS_LBL, pill: 'metrics',
        text_ar: 'تُدخل الأرقام يدويًا حتى يُربط سحب الأداء.',
        text_en: 'Numbers are entered by hand until a metrics link exists.',
      },
      {
        ...TOKEN_LBL, pill: 'token',
        text_ar: 'لا رمز وصول بعد.',
        text_en: 'No access token yet.',
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* the section                                                          */
/* ------------------------------------------------------------------ */

export default function SettingsPlatforms({
  accounts, canManage, isAr, onAccounts,
}: {
  accounts: MosAccount[];
  canManage: boolean;
  isAr: boolean;
  onAccounts: (accounts: MosAccount[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  /* Scheduled publications waiting per account — derived from the real queue,
     never invented. Publications with no account fall to their platform's
     first card, matching how the mockup attributes them to the handle. */
  const [pendingByAccount, setPendingByAccount] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    fetchPublications()
      .then((res) => {
        if (!alive) return;
        const byAccount: Record<string, number> = {};
        const byPlatform: Record<string, number> = {};
        for (const p of res.publications) {
          if (p.status !== 'scheduled') continue;
          if (p.account_id) byAccount[p.account_id] = (byAccount[p.account_id] ?? 0) + 1;
          else byPlatform[p.platform] = (byPlatform[p.platform] ?? 0) + 1;
        }
        const seenPlatform = new Set<string>();
        const out: Record<string, number> = {};
        for (const a of accounts) {
          let n = byAccount[a.id] ?? 0;
          if (!seenPlatform.has(a.platform)) {
            n += byPlatform[a.platform] ?? 0;
            seenPlatform.add(a.platform);
          }
          out[a.id] = n;
        }
        setPendingByAccount(out);
      })
      .catch((e) => {
        // The counts are a courtesy line on the card; a failed fetch must still
        // be visible, per the repo's no-silent-failures rule.
        console.error('[marketing] platforms: pending-count fetch failed', e);
        addToast(
          isAr ? 'تعذّر تحميل عدد المنشورات المجدولة.' : 'Could not load the scheduled-publication counts.',
          'error',
        );
      });
    return () => { alive = false; };
  }, [accounts, addToast, isAr]);

  const connected = useMemo(() => accounts.filter((a) => a.is_connected).length, [accounts]);

  /* ── edit / add modals — metadata only, never a connection ── */
  const [editing, setEditing] = useState<MosAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [handle, setHandle] = useState('');
  const [labelAr, setLabelAr] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [platform, setPlatform] = useState('instagram');
  const [busy, setBusy] = useState(false);

  const openEdit = (a: MosAccount): void => {
    setEditing(a);
    setHandle(a.handle ?? '');
    setLabelAr(a.label_ar);
    setLabelEn(a.label_en);
  };
  const openAdd = (): void => {
    setAdding(true);
    setHandle('');
    setLabelAr('');
    setLabelEn('');
    setPlatform('instagram');
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      if (editing) {
        const res = await saveAccount({
          id: editing.id,
          handle: handle.trim() || null,
          label_ar: labelAr.trim() || editing.label_ar,
          label_en: labelEn.trim() || editing.label_en,
        });
        onAccounts(res.accounts);
        setEditing(null);
      } else {
        if (!labelAr.trim() || !labelEn.trim()) {
          addToast(isAr ? 'الاسم بالعربية والإنجليزية إلزاميان.' : 'Both labels are required.', 'error');
          setBusy(false);
          return;
        }
        const res = await saveAccount({
          platform,
          handle: handle.trim() || null,
          label_ar: labelAr.trim(),
          label_en: labelEn.trim(),
          sort_order: accounts.length,
        });
        onAccounts(res.accounts);
        setAdding(false);
      }
      addToast(isAr ? 'حُفظ الحساب.' : 'Account saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const capPill = (a: MosAccount, kind: CapPill): { tone: Tone; label: string } | null => {
    if (kind === 'publish') {
      return a.can_publish
        ? { tone: 'go', label: isAr ? 'متصل' : 'Connected' }
        : { tone: 'idle', label: isAr ? 'يدوي' : 'Manual' };
    }
    if (kind === 'metrics') {
      return a.can_read_metrics
        ? { tone: 'go', label: isAr ? 'متصل' : 'Connected' }
        : { tone: 'idle', label: isAr ? 'يدوي' : 'Manual' };
    }
    if (kind === 'token') {
      return a.token_expires_at
        ? { tone: 'wait', label: `${isAr ? 'تنتهي' : 'expires'} ${shortDate(a.token_expires_at, isAr)}` }
        : { tone: 'idle', label: isAr ? 'غير متصل' : 'Not connected' };
    }
    return null;
  };

  return (
    <>
      <PageHead
        title={isAr ? 'المنصات والحسابات' : 'Platforms and accounts'}
        sub={isAr
          ? `${num(connected, true)} من ${num(accounts.length, true)} مربوطة · النشر والأداء كلاهما يدوي اليوم`
          : `${connected} of ${accounts.length} connected · publishing and metrics are both manual today`}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        <span className="btn btn-d">{isAr ? 'ماذا يتطلب الربط' : 'What connecting takes'}</span>
        {canManage && (
          <button type="button" className="btn btn-p" onClick={openAdd}>
            <IconPlus />
            {isAr ? 'حساب' : 'Account'}
          </button>
        )}
      </PageHead>

      <div className="body">
        <div style={{ display: 'grid', gap: 12 }}>
          {accounts.map((a) => {
            const def = PLATFORM_CARDS[a.platform] ?? fallbackCard(a.platform);
            const name = (isAr ? PLATFORM_LABELS[a.platform]?.ar : PLATFORM_LABELS[a.platform]?.en)
              ?? (isAr ? a.label_ar : a.label_en) ?? a.platform;
            const pillTone: Tone = a.is_connected ? 'go' : def.compact ? 'idle' : 'late';
            const pillLabel = a.is_connected
              ? (isAr ? 'مربوط' : 'Connected')
              : (isAr ? 'غير مربوط' : 'Not connected');
            const pending = pendingByAccount[a.id] ?? 0;
            return (
              <div key={a.id} className="card" style={def.compact ? { opacity: 0.8 } : undefined}>
                <div className="card-b" style={{ display: 'flex', gap: 15, alignItems: def.compact ? 'center' : 'flex-start' }}>
                  <div className="s26-ic" style={{ background: def.bg, color: def.fg }}>{def.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{ fontSize: 14.5, fontWeight: 700 }}>{name}</span>
                      <Pill tone={pillTone}>{pillLabel}</Pill>
                      {def.tag_ar && (
                        <span className="tag tag-t">{isAr ? def.tag_ar : def.tag_en}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--mute)', marginTop: 4 }}>
                      {def.sub_ar ? (
                        isAr ? def.sub_ar : def.sub_en
                      ) : (
                        <>
                          {isAr ? 'الحساب' : 'Account'}{' '}
                          <b className="ltr" style={{ color: 'var(--ink)' }}>
                            {a.handle ?? (isAr ? 'لم يُحدَّد' : 'not set')}
                          </b>
                          {pending > 0 && (
                            <>
                              {' · '}
                              {isAr
                                ? `${num(pending, true)} عمليات نشر تنتظره`
                                : `${pending} scheduled publications waiting on it`}
                            </>
                          )}
                        </>
                      )}
                    </div>
                    {def.caps.length > 0 && (
                      <div style={{ display: 'flex', gap: 22, marginTop: 12 }}>
                        {def.caps.map((c, i) => {
                          const pill = capPill(a, c.pill);
                          return (
                            <div key={i} style={i === def.caps.length - 1 ? { flex: '0 0 156px' } : { flex: 1 }}>
                              <div className="lbl" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span>{isAr ? c.lbl_ar : c.lbl_en}</span>
                                {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  lineHeight: 1.75,
                                  color: c.accent ? 'var(--copper)' : 'var(--ink-2)',
                                  fontWeight: c.accent ? 700 : undefined,
                                }}
                              >
                                {isAr ? c.text_ar : c.text_en}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={def.compact ? 'btn btn-sm' : 'btn btn-p btn-sm'}
                    style={{ flex: '0 0 auto' }}
                    disabled={!canManage}
                    title={isAr ? 'لا يوجد ربط تلقائي — يفتح بيانات الحساب' : 'No automatic link — opens the account details'}
                    onClick={() => openEdit(a)}
                  >
                    {isAr ? 'ربط' : 'Connect'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* The decision banner — transcribed verbatim from s26.html. */}
        <div className="s26-note">
          {isAr ? (
            <>
              <div>
                <b style={{ fontWeight: 700 }}>قرار: النشر يبقى يدويًا.</b> لن يُربط النشر التلقائي — لا الآن ولا لاحقًا.
                «مجدول» تعني دائمًا: يُنبّه النظام <b>الكاتب</b> في وقته، فينشر بنفسه ويؤكد. هذا يحذف
                مراجعة تطبيق ميتا وتيك توك بالكامل من نطاق العمل، وهو أثقل جزء في الربط.
              </div>
              <div className="n-f">
                <b style={{ fontWeight: 700 }}>ما يبقى مطلوبًا من الربط شيئان فقط:</b> سحب أرقام الأداء،
                وتسليم عملاء الإعلانات إلى نظام العملاء. وأولوية واحدة واضحة: <b>إعلانات ميتا</b> —
                تُلغي الإدخال اليدوي من كل شاشات الحملات وتُسلّم العملاء خلال ثوانٍ.
                وحتى ذلك الحين تبقى الأرقام تُدخل يدويًا في شاشة ٥٠، وهو ما قررناه للنسخة الأولى.
              </div>
            </>
          ) : (
            <>
              <div>
                <b style={{ fontWeight: 700 }}>Decision: publishing stays manual.</b> Automatic publishing will
                not be connected — not now, not later. “Scheduled” always means: the system reminds the
                writer at the time, and they publish and confirm themselves. This removes the Meta and
                TikTok app review entirely from the scope, which is the heaviest part of connecting.
              </div>
              <div className="n-f">
                <b style={{ fontWeight: 700 }}>Only two things remain wanted from connecting:</b> pulling
                performance numbers, and delivering ad leads into the CRM. And one clear priority: Meta
                ads — it ends manual entry across every campaign screen and delivers leads within seconds.
                Until then the numbers keep being entered by hand on screen 50, which is what we decided
                for the first version.
              </div>
            </>
          )}
        </div>
      </div>

      {(editing || adding) && (
        <Modal
          title={
            editing
              ? ((isAr ? PLATFORM_LABELS[editing.platform]?.ar : PLATFORM_LABELS[editing.platform]?.en) ?? editing.platform)
              : (isAr ? 'حساب جديد' : 'New account')
          }
          sub={isAr
            ? 'بيانات الحساب فقط — الاتصال نفسه ليس مفتاحًا في الواجهة، والنشر يبقى يدويًا بقرار.'
            : 'Account metadata only — a connection is not a checkbox, and publishing stays manual by decision.'}
          onClose={() => { setEditing(null); setAdding(false); }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => { setEditing(null); setAdding(false); }} disabled={busy}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy}>
                {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
              </button>
            </>
          }
        >
          {adding && (
            <Field label={isAr ? 'المنصة' : 'Platform'}>
              <select className="inp" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {Object.entries(PLATFORM_LABELS).map(([p, lbl]) => (
                  <option key={p} value={p}>{isAr ? lbl.ar : lbl.en}</option>
                ))}
              </select>
            </Field>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
            <Field label={isAr ? 'الاسم بالعربية' : 'Arabic label'}>
              <input className="inp" value={labelAr} onChange={(e) => setLabelAr(e.target.value)} />
            </Field>
            <Field label={isAr ? 'الاسم بالإنجليزية' : 'English label'}>
              <input className="inp" dir="ltr" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
            </Field>
          </div>
          <Field label={isAr ? 'اسم الحساب' : 'Handle'} hint="@…">
            <input className="inp" dir="ltr" value={handle} onChange={(e) => setHandle(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </>
  );
}
