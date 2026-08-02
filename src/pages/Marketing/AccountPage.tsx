/**
 * حسابي — design screen 46 (الجوال — حسابي).
 *
 * The fourth tab's landing page. The ROLE — not the name — comes first,
 * because it changes everything under it: the ACTIVE-role switcher sits at the
 * top of the screen and only exists for someone holding 2+ roles (s46's note:
 * «من يشغل دورًا واحدًا لا يراه إطلاقًا» — absent, not disabled). Under it:
 * notification prefs, this week's load with «طلب تأجيل» (an explicit ask beats
 * a silently late task), and the door to what only works on desktop.
 *
 * Registered at /m/account by the shell's route table; it renders fine on
 * desktop too — just mobile-first, one 560px column.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import {
  MosApiError,
  ROLE_LABELS,
  fetchBootstrap,
  fetchWork,
  getActiveRole,
  isOverdue,
  saveNotificationPrefs,
  type MosRole,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, PageHead } from './components/kit';
import { initial, num, roleAvatarClass, toArabicDigits } from './lib/format';
import './styles/mobile-shell.css';

/* ------------------------------------------------------------------ */
/* «طلب تأجيل» — the load card's explicit ask                          */
/* ------------------------------------------------------------------ */

// TODO(client): src/lib/marketingOS/client.ts has no wrapper for this action
// yet — move this local typed caller into the client lib once the API grows a
// `postpone_request` action. Shape mirrors the lib's own `call<T>` transport.
async function requestPostponement(payload: { open_tasks: number; late_tasks: number }): Promise<{ ok: true }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const activeRole = getActiveRole();
  if (activeRole) headers['x-mos-active-role'] = activeRole;
  const res = await fetch('/api/marketing-os', {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'postpone_request', ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    throw new MosApiError(b.error ?? `postpone_request failed (${res.status})`, res.status, b);
  }
  return (await res.json()) as { ok: true };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** «٨:٠٠ صباحًا» / "8:00 AM" — the digest hour, s46's shape. */
function hourLabel(h: number, isAr: boolean): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = isAr ? (h < 12 ? 'صباحًا' : 'مساءً') : h < 12 ? 'AM' : 'PM';
  const mm = isAr ? toArabicDigits('00') : '00';
  return `${num(h12, isAr)}:${mm} ${suffix}`;
}

/** «٧ مهام» with correct Arabic number agreement. */
function tasksAr(n: number): string {
  if (n === 0) return 'لا مهام';
  if (n === 1) return 'مهمة واحدة';
  if (n === 2) return 'مهمتان';
  if (n <= 10) return `${num(n, true)} مهام`;
  return `${num(n, true)} مهمة`;
}

interface PrefsState {
  whatsapp: boolean;
  digestHour: number;
  quiet: boolean;
}

/** Bootstrap's `me.prefs` is loose JSON — read it defensively with defaults. */
function readPrefs(p: Record<string, unknown>): PrefsState {
  return {
    whatsapp: typeof p.whatsapp_enabled === 'boolean' ? p.whatsapp_enabled : true,
    digestHour: typeof p.digest_hour === 'number' ? p.digest_hour : 8,
    quiet: typeof p.quiet_from === 'number' && typeof p.quiet_to === 'number',
  };
}

/** s46's 40×23 switch. The CSS extends the hit area to ≥44px. */
function Toggle({
  on, disabled, label, onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`mos-toggle${on ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onToggle(!on)}
    >
      <i />
    </button>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/* ------------------------------------------------------------------ */
/* page                                                               */
/* ------------------------------------------------------------------ */

export default function AccountPage() {
  const { role, roles, setActiveRole, people, appUserId, isAr } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const authEmail = useAppStore((s) => s.authEmail);

  const [openCount, setOpenCount] = useState<number | null>(null);
  const [lateCount, setLateCount] = useState(0);
  const [prefs, setPrefs] = useState<PrefsState>({ whatsapp: true, digestHour: 8, quiet: false });
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [sendingPostpone, setSendingPostpone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [boot, work] = await Promise.all([fetchBootstrap(), fetchWork('mine')]);
      setPrefs(readPrefs(boot.me.prefs));
      setOpenCount(work.content.length);
      setLateCount(work.content.filter(isOverdue).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  /* ── identity ──────────────────────────────────────────────────── */

  const roleLabelOf = (r: MosRole): string =>
    ROLE_LABELS[r] ? (isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en) : r;
  const roleLabel = roleLabelOf(role);

  const person = people.find((p) => p.user_id === appUserId) ?? null;
  const personName = person
    ? ((isAr ? person.name_ar : person.name_en) ?? person.name_ar ?? person.name_en ?? person.email)
    : null;

  // The switchable roles — 'viewer'/'none' are fallbacks, not grants.
  const held = roles.filter((r): r is MosRole => r !== 'viewer' && r !== 'none');
  const multi = held.length >= 2;

  const subName = personName ?? roleLabel;
  const sub = multi
    ? (isAr
        ? `${subName} · ${held.length === 2 ? 'يشغل دورين' : `يشغل ${num(held.length, true)} أدوار`}`
        : `${subName} · holds ${held.length === 2 ? 'two roles' : `${num(held.length, false)} roles`}`)
    : subName;

  /* ── prefs saves — optimistic, loudly reverted on failure ──────── */

  const savePrefs = async (next: PrefsState, patch: Parameters<typeof saveNotificationPrefs>[0]): Promise<void> => {
    const prev = prefs;
    setPrefs(next);
    setSavingPrefs(true);
    try {
      await saveNotificationPrefs(patch);
    } catch (e) {
      setPrefs(prev);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSavingPrefs(false);
    }
  };

  const onWhatsapp = (v: boolean): void => {
    void savePrefs({ ...prefs, whatsapp: v }, { whatsapp_enabled: v });
  };
  const onDigestHour = (h: number): void => {
    void savePrefs({ ...prefs, digestHour: h }, { digest_hour: h });
  };
  const onQuiet = (v: boolean): void => {
    // s46's quiet window: ١٠ مساءً — ٧ صباحًا. Off clears both bounds.
    void savePrefs({ ...prefs, quiet: v }, v
      ? { quiet_from: 22, quiet_to: 7 }
      : { quiet_from: null, quiet_to: null });
  };

  /* ── «طلب تأجيل» ───────────────────────────────────────────────── */

  const onPostpone = async (): Promise<void> => {
    setSendingPostpone(true);
    try {
      await requestPostponement({ open_tasks: openCount ?? 0, late_tasks: lateCount });
      addToast(
        isAr ? 'أُرسل طلب التأجيل إلى مشرف العمليات' : 'Postponement request sent to the operations supervisor',
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSendingPostpone(false);
    }
  };

  /* ── derived display ───────────────────────────────────────────── */

  const roleMeta = openCount === null
    ? '—'
    : isAr
      ? `${tasksAr(openCount)}${lateCount > 0 ? ` · ${num(lateCount, true)} متأخرة` : ''}`
      : `${num(openCount, false)} ${openCount === 1 ? 'task' : 'tasks'}${lateCount > 0 ? ` · ${num(lateCount, false)} late` : ''}`;

  const over = lateCount > 0;
  // The meter's reference load: 8 open tasks fill the week's bar. Display-only —
  // the verdict comes from real lateness, not from this scale.
  const loadPct = openCount === null ? 0 : Math.min(100, Math.round((openCount / 8) * 100));

  const mailto = `mailto:${authEmail ?? ''}`
    + `?subject=${encodeURIComponent(isAr ? 'رابط الدخول — مساحة التسويق' : 'Sign-in link — Marketing workspace')}`
    + `&body=${encodeURIComponent(`${window.location.origin}/m`)}`;

  return (
    <>
      <PageHead title={isAr ? 'حسابي' : 'My account'} sub={sub} />
      <div className="body">
        <div className="mos-acct">
          {error && (
            <div style={{ marginBottom: 14 }}>
              <LoadError message={error} onRetry={() => void load()} isAr={isAr} />
            </div>
          )}

          {/* ── The role card — «أنت الآن». Switcher only for 2+ roles. ── */}
          <div className={`card mos-acct-role${multi ? ' hot' : ''}`}>
            {multi && (
              <div className="lbl" style={{ margin: '0 0 9px' }}>{isAr ? 'أنت الآن' : 'You are now'}</div>
            )}
            <div className="mos-acct-role-row">
              <span
                className={`av ${roleAvatarClass(role)}`}
                style={{ width: 34, height: 34, fontSize: 13 }}
              >
                {initial(personName ?? roleLabel)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mos-acct-role-name">{roleLabel}</div>
                <div className="mos-acct-meta">{roleMeta}</div>
              </div>
            </div>
            {multi && (
              <>
                <div className="mos-acct-roles">
                  {held.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`mos-acct-rolebtn${r === role ? ' on' : ''}`}
                      onClick={() => setActiveRole(r)}
                    >
                      {roleLabelOf(r)}
                    </button>
                  ))}
                </div>
                <div className="mos-acct-note">
                  {isAr
                    ? 'التبديل يغيّر «اليوم» والصلاحيات والإشعارات. لا يغيّر أي شيء سجّلته باسمك.'
                    : 'Switching changes “Today”, permissions and notifications. It never changes anything recorded in your name.'}
                </div>
              </>
            )}
          </div>

          {/* ── This week's load + «طلب تأجيل» ─────────────────────────── */}
          <div className="lbl mos-acct-lbl">{isAr ? 'حملي هذا الأسبوع' : 'My load this week'}</div>
          <div className="card mos-acct-card">
            <div className="mos-acct-load-top">
              <span className="n">
                {openCount === null
                  ? '—'
                  : isAr
                    ? `${tasksAr(openCount)} مفتوحة`
                    : `${num(openCount, false)} open ${openCount === 1 ? 'task' : 'tasks'}`}
              </span>
              <span className={`verdict ${over ? 'over' : 'ok'}`}>
                {over
                  ? (isAr ? 'فوق الطاقة' : 'Over capacity')
                  : (isAr ? 'ضمن الطاقة' : 'Within capacity')}
              </span>
            </div>
            <div className="meter" style={{ height: 6 }}>
              <i style={{ width: `${loadPct}%`, background: over ? 'var(--late)' : 'var(--copper)' }} />
            </div>
            <div className="mos-acct-note" style={{ marginTop: 11 }}>
              {isAr
                ? 'مشرف العمليات يرى هذا في شاشته ويستطيع التأجيل.'
                : 'The operations supervisor sees this on his screen and can postpone.'}
            </div>
            <button
              type="button"
              className="btn mos-acct-action"
              disabled={sendingPostpone}
              onClick={() => void onPostpone()}
            >
              {sendingPostpone
                ? (isAr ? 'جارٍ الإرسال…' : 'Sending…')
                : (isAr ? 'طلب تأجيل' : 'Request postponement')}
            </button>
          </div>

          {/* ── Notification prefs — s46's toggle rows ─────────────────── */}
          <div className="lbl mos-acct-lbl">{isAr ? 'الإشعارات' : 'Notifications'}</div>
          <div className="card mos-acct-prefs">
            <div className="mos-pref-row">
              <div className="mos-pref-t">
                <div className="mos-pref-name">{isAr ? 'واتساب' : 'WhatsApp'}</div>
                <div className="mos-pref-sub">{isAr ? 'ما يعطّل غيرك فقط' : 'Only what blocks someone else'}</div>
              </div>
              <Toggle
                on={prefs.whatsapp}
                disabled={savingPrefs}
                label={isAr ? 'واتساب' : 'WhatsApp'}
                onToggle={onWhatsapp}
              />
            </div>
            <div className="mos-pref-row">
              <div className="mos-pref-t">
                <div className="mos-pref-name">{isAr ? 'ملخص الصباح' : 'Morning digest'}</div>
                <div className="mos-pref-sub">{hourLabel(prefs.digestHour, isAr)}</div>
              </div>
              <select
                className="mos-pref-select"
                value={prefs.digestHour}
                disabled={savingPrefs}
                aria-label={isAr ? 'ساعة ملخص الصباح' : 'Morning digest hour'}
                onChange={(e) => onDigestHour(Number(e.target.value))}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>{hourLabel(h, isAr)}</option>
                ))}
              </select>
            </div>
            <div className="mos-pref-row">
              <div className="mos-pref-t">
                <div className="mos-pref-name">{isAr ? 'ساعات الهدوء' : 'Quiet hours'}</div>
                <div className="mos-pref-sub">{isAr ? '١٠ مساءً — ٧ صباحًا' : '10 PM — 7 AM'}</div>
              </div>
              <Toggle
                on={prefs.quiet}
                disabled={savingPrefs}
                label={isAr ? 'ساعات الهدوء' : 'Quiet hours'}
                onToggle={onQuiet}
              />
            </div>
          </div>

          {/* ── Desktop-only — the door out, verbatim from s46 ─────────── */}
          <div className="lbl mos-acct-lbl">{isAr ? 'على الحاسوب فقط' : 'Desktop only'}</div>
          <div className="card" style={{ padding: '12px 15px' }}>
            <div className="mos-acct-desktop-list">
              {isAr
                ? 'الحملات · مكتبة المواد · الإعدادات · التقارير'
                : 'Campaigns · Asset library · Settings · Reports'}
            </div>
            <a className="btn mos-acct-action" href={mailto}>
              {isAr ? 'أرسل لي رابط الدخول' : 'Email me the sign-in link'}
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
