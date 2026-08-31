/** Agents & runs — what's running, what it did today, from which accounts. */
import { fetchAgentActivity, type AgentActivity } from '@/lib/competitorWatch/client';
import { useSurface, num, fmtDateTime, fmtTime, daysAgo } from './surfaceData';

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const w = 120;
  const h = 38;
  const pad = 4;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = points.map((v, i) => {
    const x = pad + i * step;
    const y = (h - pad) - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} ${coords[coords.length - 1]![0].toFixed(1)},${h} ${coords[0]![0].toFixed(1)},${h}`;
  const last = coords[coords.length - 1]!;
  return (
    <svg className="cw-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="cw-spark-fill" points={area} />
      <polyline points={line} />
      <circle className="cw-spark-end" cx={last[0]} cy={last[1]} r="2.6" />
    </svg>
  );
}

export default function AgentsSurface({ isAr }: { isAr: boolean }) {
  const { data, loading, error } = useSurface<AgentActivity>(fetchAgentActivity);

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!data) return null;

  const c = data.collection;
  const u = data.understanding;
  const d = data.discovery;
  const idleDays = daysAgo(d.last_run);

  return (
    <div className="cw-surface">
      <div className="cw-agents">
        <div className={`cw-agentcard ${c.paused ? 'idle' : 'live'}`}>
          <span className="cw-stripe" />
          <div className="cw-actop">
            <div className="cw-acname">{isAr ? 'التجميع' : 'Collection'}<small>{isAr ? 'يسحب المنشورات والإعلانات' : 'pulls new posts & ads'}</small></div>
            <span className={`cw-tag ${c.paused ? 'warn' : 'ok'}`}><span className="cw-d" />{c.paused ? (isAr ? 'متوقّف' : 'Paused') : (isAr ? 'نشط' : 'Live')}</span>
          </div>
          <div className="cw-big">{num(c.received_today)}<small> {isAr ? 'فُحص اليوم' : 'checked today'}</small></div>
          <div className="cw-acfacts">
            <div><b>{num(c.runs_today)}</b><span>{isAr ? 'تشغيلة' : 'runs'}</span></div>
            <div><b>{num(c.inserted_today)}</b><span>{isAr ? 'جديد فعليًا' : 'genuinely new'}</span></div>
            <div><b>{c.enabled_accounts}</b><span>{isAr ? 'حساب' : 'accounts'}</span></div>
          </div>
          <Sparkline points={c.daily.map((x) => x.inserted)} />
          <div className="cw-accap">{isAr ? 'منشورات جديدة فعليًا/يوم — الباقي إعادة فحص لالتقاط الجديد وتحديث الأرقام' : 'genuinely new posts / day — the rest is re-checking to catch new ones & refresh counts'}</div>
        </div>

        <div className="cw-agentcard work">
          <span className="cw-stripe" />
          <div className="cw-actop">
            <div className="cw-acname">{isAr ? 'الفهم' : 'Understanding'}<small>{isAr ? 'يقرأ ويفرّغ كل منشور' : 'reads & transcribes each post'}</small></div>
            <span className="cw-tag info"><span className="cw-d" />{isAr ? 'يعمل' : 'Working'}</span>
          </div>
          <div className="cw-big">{num(u.processed_24h)}<small> {isAr ? 'عولج (٢٤س)' : 'processed 24h'}</small></div>
          <div className="cw-acfacts">
            <div><b>{num(u.queued)}</b><span>{isAr ? 'في الانتظار' : 'in queue'}</span></div>
            <div><b>{num(u.all_time)}</b><span>{isAr ? 'الإجمالي' : 'all-time'}</span></div>
          </div>
          <div className="cw-accap">{isAr ? 'قراءة وتفريغ على مسار كلود بالاشتراك' : 'OCR + transcription on the flat-fee Claude lane'}</div>
        </div>

        <div className="cw-agentcard idle">
          <span className="cw-stripe" />
          <div className="cw-actop">
            <div className="cw-acname">{isAr ? 'الاكتشاف' : 'Discovery'}<small>{isAr ? 'يعثر على حسابات المنافسين' : "finds competitors' accounts"}</small></div>
            <span className="cw-tag warn"><span className="cw-d" />{isAr ? 'متوقّف' : 'Idle'}</span>
          </div>
          <div className="cw-big">{idleDays === null ? '—' : idleDays}<small> {isAr ? 'يومًا منذ آخر تشغيل' : 'days since last run'}</small></div>
          <div className="cw-acfacts">
            <div><b>{num(d.runs)}</b><span>{isAr ? 'تشغيلات' : 'runs ever'}</span></div>
            <div><b>{num(d.confirmed)}</b><span>{isAr ? 'مؤكد' : 'confirmed'}</span></div>
          </div>
          <div className="cw-accap">{isAr ? 'يعمل عند الطلب فقط — لا يُكتشف منافسون جدد تلقائيًا' : 'runs on demand only — new competitors are not found automatically'}</div>
        </div>
      </div>

      <div className="cw-panel">
        <div className="cw-panelh">
          <h3>{isAr ? 'تشغيلات اليوم' : "Today's runs"}</h3>
          <span className="cw-muted">{isAr ? `${num(c.runs_today)} تشغيلة · عرض ${data.runs.length}` : `${num(c.runs_today)} runs · showing ${data.runs.length}`}</span>
        </div>
        <div className="cw-tblwrap">
          <table className="cw-table">
            <thead>
              <tr>
                <th>{isAr ? 'المصدر' : 'Source'}</th>
                <th>{isAr ? 'الحساب' : 'Account'}</th>
                <th className="cw-r">{isAr ? 'سُحب' : 'Pulled'}</th>
                <th className="cw-r">{isAr ? 'جديد' : 'New'}</th>
                <th>{isAr ? 'الوقت' : 'Time'}</th>
                <th>{isAr ? 'النتيجة' : 'Result'}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r, i) => (
                <tr key={i}>
                  <td className="cw-mutedmono">{r.provider ?? '—'}</td>
                  <td>{r.handle ? <span>{r.platform ? `${r.platform} · ` : ''}<span dir="ltr">@{r.handle}</span></span> : <span className="cw-muted">{isAr ? 'داخلي' : 'internal'}</span>}</td>
                  <td className="cw-r cw-mono">{num(r.received ?? 0)}</td>
                  <td className="cw-r cw-mono">{num(r.inserted ?? 0)}</td>
                  <td className="cw-mono">{fmtTime(r.started_at)}</td>
                  <td><span className={`cw-tag ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'mute'}`}><span className="cw-d" />{r.status === 'succeeded' ? 'ok' : r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="cw-note">
        {isAr
          ? '«جديد = ٠» أمر طبيعي: تلك الحسابات لم تنشر شيئًا منذ آخر زيارة. آخر نشاط: '
          : '“New = 0” is normal — those accounts posted nothing since the last visit. Last activity: '}
        {fmtDateTime(c.last_activity, isAr)}.
      </p>
    </div>
  );
}
