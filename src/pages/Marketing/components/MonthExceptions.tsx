/**
 * «يحتاج قرارك» — the exceptions list (mockup `s-exceptions.html`).
 *
 * One line per exception, each carrying the SMALLEST decision that resolves it
 * (§3.3). The list is fed by the `mos_month_exceptions` RPC — nine arms, one
 * line each — and this component adds nothing to it: no re-ranking, no
 * grouping, no invented severity. The RPC already orders blockers first and
 * collapses the publish side to ONE ranked cause per release, so a disconnected
 * account does not also appear as a publish failure.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: render a button that cannot act. Most
 * decisions — move the row, drop the late post, retry the ad — live in the row
 * and release surfaces, which are other groups' screens. Where a destination
 * exists today the line links to it; where it does not, the decision is stated
 * in words rather than dressed as a control that would do nothing when pressed.
 * A dead button is worse than a sentence. The one exception is a HELD release
 * (2026-09-29): «انشر الآن / أعد الجدولة / ألغِ» are real actions, taken here.
 *
 * The RPC returns Arabic text only (`label_ar` / `detail_ar`) because it is the
 * operator's own language and the only text that exists for these events — so
 * an English session still reads the exception in Arabic. That is data passing
 * through, not a hardcoded string.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  cancelRelease, publishPublication, rescheduleRelease, type MosMonthException,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Empty } from './kit';
import { monthDate } from './MonthDates';

/** What closes this line, and where (when a destination exists today). */
function decisionOf(
  exc: MosMonthException, isAr: boolean,
): { text: string; href: string | null; cta: string | null } {
  switch (exc.action_hint) {
    case 'move_row_or_drop_late_post':
      return {
        text: isAr
          ? 'تأجيل الدفعة إلى الموعد التالي، أو استبعاد المنشور المتأخّر وإطلاق منشور جديد بدلًا منه.'
          : 'move the batch to the next slot, or drop the late post and run a new one in its place.',
        href: null,
        cta: null,
      };
    case 'replace_or_move_row':
      return {
        text: isAr
          ? 'استبدال المنشور بواحد جديد، أو تأجيل الدفعة إلى الموعد التالي.'
          : 'replace the post with a new one, or move the batch to the next slot.',
        href: exc.subject_kind === 'content' && exc.subject_id ? `/m/content/${exc.subject_id}` : null,
        cta: isAr ? 'افتح المحتوى' : 'Open the content',
      };
    case 'retry_or_replace_creative':
      return {
        text: isAr
          ? 'إعادة المحاولة على ميتا، أو استبدال التصميم.'
          : 'retry at Meta, or replace the creative.',
        href: null,
        cta: null,
      };
    case 'connect_account_then_retry':
      return {
        text: isAr
          ? 'وصل الحساب ثم أعد المحاولة، أو سجّل النشر يدويًا، أو تخطَّ هذه الوجهة.'
          : 'connect the account and retry, record the post by hand, or drop this one destination.',
        href: exc.subject_id ? `/m/releases/${exc.subject_id}` : null,
        cta: isAr ? 'افتح الإصدار' : 'Open the release',
      };
    case 'fix_what_was_named_then_retry':
      return {
        text: isAr
          ? 'أصلح ما سمّته المنصة ثم أعد المحاولة — الرسالة معروضة كما وردت.'
          : 'fix what the platform named, then retry — its message is shown verbatim.',
        href: exc.subject_id ? `/m/releases/${exc.subject_id}` : null,
        cta: isAr ? 'افتح الإصدار' : 'Open the release',
      };
    case 'retry_or_record_manually':
      return {
        text: isAr
          ? 'إعادة المحاولة، أو تسجيل النشر يدويًا.'
          : 'retry, or record the post by hand.',
        href: exc.subject_id ? `/m/releases/${exc.subject_id}` : null,
        cta: isAr ? 'افتح الإصدار' : 'Open the release',
      };
    case 'pick_replacement_project':
      return {
        text: isAr
          ? 'اختيار مشروع بديل يتسلّم بقية دفعات السوشيال ميديا والدفعات الإعلانية في هذه الخانة.'
          : 'pick a replacement project to take over the slot’s remaining social media and ad batches.',
        href: null,
        cta: null,
      };
    case 'rebalance_or_move_a_batch':
      return {
        text: isAr
          ? 'أعد توزيع اليوم، أو انقل دفعة — الطاقة اليومية تُحرَّر من إعدادات الطاقة.'
          : 'rebalance the day or move a batch — daily capacity is edited in the capacity settings.',
        href: '/m/settings/capacity',
        cta: isAr ? 'افتح الطاقة' : 'Open capacity',
      };
    case 'decide_slate_manually':
      return {
        text: isAr
          ? 'اختر ما يُبقى وما يُوقَف من الإعلانات بنفسك — لم يجتز أي إعلان حدّي الإنفاق والظهور.'
          : 'choose what to keep and pause yourself — no ad cleared the spend and impression gates.',
        href: null,
        cta: null,
      };
    case 'publish_now_reschedule_or_cancel':
      // A release the sweep could not post (2026-09-29). The three decisions are
      // real controls below (ReleaseHoldActions), not a sentence.
      return {
        text: isAr
          ? 'انشره الآن، أو أعد جدولته، أو ألغِه. «انشر الآن» يمرّ بفحص الاعتماد نفسه.'
          : 'publish it now, reschedule it, or cancel it. «Publish now» passes the same approval check.',
        href: exc.subject_id ? `/m/releases/${exc.subject_id}` : null,
        cta: isAr ? 'افتح الإصدار' : 'Open the release',
      };
    default:
      return { text: exc.detail_ar ?? '', href: null, cta: null };
  }
}

const ICONS: Record<string, string> = {
  row_incomplete: '◷',
  changes_requested_3: '↺',
  ad_failed: '✕',
  publish_failed: '✕',
  account_not_connected: '⚿',
  platform_rejected: '⊘',
  project_sold_out: '⌂',
  capacity_breach: '≡',
  ranking_cleared_none: '≋',
  release_held: '⏸',
};

/**
 * «انشر الآن / أعد الجدولة / ألغِ» for one held release (2026-09-29).
 *
 * «انشر الآن» goes through the SAME publish path as the sweep, approval gate
 * included — a post that is not approved, or still in production, is refused
 * with the platform-side reason shown here, never posted. Every failure is shown
 * in the line itself; nothing is swallowed.
 */
function ReleaseHoldActions({
  releaseId, isAr, onChanged,
}: {
  releaseId: string;
  isAr: boolean;
  onChanged?: () => void;
}) {
  const { can } = useWorkspace();
  const [busy, setBusy] = useState<'publish' | 'reschedule' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const canPublish = can('publish');
  const canSchedule = can('schedule');
  if (!canPublish && !canSchedule) return null;

  const act = async (kind: 'publish' | 'reschedule' | 'cancel', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setPicking(false);
      setConfirmCancel(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mth-row" style={{ gap: 6, flexWrap: 'wrap', marginBlockStart: 8 }}>
      {canPublish && (
        <button
          type="button" className="btn btn-sm btn-p" disabled={busy !== null}
          onClick={() => { void act('publish', () => publishPublication(releaseId)); }}
        >
          {busy === 'publish' ? (isAr ? 'جارٍ الإرسال…' : 'Sending…') : (isAr ? 'انشر الآن' : 'Publish now')}
        </button>
      )}
      {canSchedule && !picking && (
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setPicking(true)}>
          {isAr ? 'أعد الجدولة' : 'Reschedule'}
        </button>
      )}
      {canSchedule && picking && (
        <span className="mth-row" style={{ gap: 6 }}>
          <input
            id={`release-when-${releaseId}`}
            type="datetime-local" className="inp" value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-label={isAr ? 'الموعد الجديد' : 'New time'}
          />
          <button
            type="button" className="btn btn-sm btn-p" disabled={busy !== null || !when}
            onClick={() => {
              void act('reschedule', () => rescheduleRelease(releaseId, new Date(when).toISOString()));
            }}
          >
            {busy === 'reschedule' ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'احفظ الموعد' : 'Save time')}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setPicking(false)}>
            {isAr ? 'تراجع' : 'Back'}
          </button>
        </span>
      )}
      {canSchedule && !confirmCancel && (
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
          {isAr ? 'ألغِ' : 'Cancel'}
        </button>
      )}
      {canSchedule && confirmCancel && (
        <button
          type="button" className="btn btn-sm btn-d" disabled={busy !== null}
          onClick={() => { void act('cancel', () => cancelRelease(releaseId)); }}
        >
          {busy === 'cancel'
            ? (isAr ? 'جارٍ الإلغاء…' : 'Cancelling…')
            : (isAr ? 'تأكيد الإلغاء — لن يُنشر' : 'Confirm — it will not post')}
        </button>
      )}
      {error && <p className="why" role="alert" style={{ flexBasis: '100%', margin: 0 }}>{error}</p>}
    </div>
  );
}

export default function MonthExceptions({
  exceptions, isAr, projectName, onChanged,
}: {
  exceptions: MosMonthException[];
  isAr: boolean;
  projectName: (id: string | null | undefined) => string;
  /** Reload the page's data after a decision was made on a line. */
  onChanged?: () => void;
}) {
  if (exceptions.length === 0) {
    return (
      <Empty
        title={isAr ? 'لا شيء ينتظر قرارك' : 'Nothing is waiting on you'}
        body={isAr
          ? 'الحالة الطبيعية لهذه القائمة فارغة: النشر يمضي تلقائيًا، والقاعدة الأسبوعية تُطبَّق وحدها، ولا يصلك بند إلا حين يتوقّف شيء فعلًا.'
          : 'Empty is this list’s normal state: publishing runs itself, the weekly ad rule applies itself, and a line only appears when something actually stopped.'}
      />
    );
  }

  return (
    <div>
      {exceptions.map((exc, i) => {
        const d = decisionOf(exc, isAr);
        const tone = exc.severity === 'blocker' ? 'bad' : 'warn';
        return (
          <div className="mth-exc" key={`${exc.kind}:${exc.subject_id ?? i}`}>
            <div className={`ic ${tone}`} aria-hidden>{ICONS[exc.kind] ?? '•'}</div>
            <div style={{ minWidth: 0 }}>
              <div className="mth-row" style={{ justifyContent: 'space-between' }}>
                <div className="ttl">{exc.label_ar}</div>
                <span className="mth-row" style={{ gap: 6 }}>
                  {exc.project_id && (
                    <span className="tag">{projectName(exc.project_id)}</span>
                  )}
                  {exc.occurred_on && (
                    <span className="tag tag-t">{monthDate(exc.occurred_on, isAr)}</span>
                  )}
                </span>
              </div>
              {exc.detail_ar && <p className="why">{exc.detail_ar}</p>}
              <div className="opts">
                <span className="lead">{isAr ? 'القرار:' : 'Decision:'}</span>
                <span className="mth-tiny" style={{ flex: 1, minWidth: 200 }}>{d.text}</span>
                {d.href && d.cta && (
                  <Link className="btn btn-sm" to={d.href}>{d.cta}</Link>
                )}
              </div>
              {exc.action_hint === 'publish_now_reschedule_or_cancel' && exc.subject_id && (
                <ReleaseHoldActions releaseId={exc.subject_id} isAr={isAr} onChanged={onChanged} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
