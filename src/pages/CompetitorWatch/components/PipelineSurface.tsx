/** Content pipeline — what happened to each pulled post, stage by stage. */
import { fetchPipelineHealth, type PipelineHealth } from '@/lib/competitorWatch/client';
import { useSurface, num } from './surfaceData';

export default function PipelineSurface({ isAr }: { isAr: boolean }) {
  const { data, loading, error } = useSurface<PipelineHealth>(fetchPipelineHealth);

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!data) return null;

  const stages: Array<{ k: string; ar: string; en: string; v: number; sub?: string; warn?: boolean }> = [
    { k: 'collected', ar: 'مُجمّع', en: 'Collected', v: data.collected, sub: isAr ? 'منشور' : 'posts' },
    { k: 'media', ar: 'وسائط محفوظة', en: 'Media saved', v: data.media_stored, sub: data.media_failed ? (isAr ? `${num(data.media_failed)} فشل` : `${num(data.media_failed)} failed`) : undefined, warn: true },
    { k: 'ocr', ar: 'قراءة الصور', en: 'Read (OCR)', v: data.ocr_done, sub: isAr ? 'صورة' : 'images' },
    { k: 'tx', ar: 'مُفرّغ', en: 'Transcribed', v: data.transcribed, sub: isAr ? 'فيديو' : 'videos' },
    { k: 'enr', ar: 'مفهوم', en: 'Understood', v: data.enriched, sub: isAr ? 'مُثرى' : 'enriched' },
    { k: 'facts', ar: 'حقائق', en: 'Facts', v: data.facts, sub: isAr ? 'مستخرجة' : 'extracted' },
    { k: 'attr', ar: 'مُسند', en: 'Attributed', v: data.attributed, sub: isAr ? 'لمشروع' : 'to a project' },
  ];

  const total = data.collected || 1;
  const status: Array<{ key: string; ar: string; en: string; tone: string }> = [
    { key: 'processed', ar: 'مكتمل', en: 'Fully processed', tone: 'ok' },
    { key: 'partial', ar: 'جزئي', en: 'Partial', tone: 'warn' },
    { key: 'failed', ar: 'فشل', en: 'Failed', tone: 'bad' },
  ];

  return (
    <div className="cw-surface">
      <div className="cw-stages">
        {stages.map((s, i) => (
          <div className="cw-stage" key={s.k}>
            <div className="cw-stagek">{isAr ? s.ar : s.en}</div>
            <div className="cw-stagev">{num(s.v)}</div>
            {s.sub && <div className={`cw-stagesub${s.warn && data.media_failed ? ' warn' : ''}`}>{s.sub}</div>}
            {i < stages.length - 1 && <span className="cw-stagearrow" aria-hidden="true">›</span>}
          </div>
        ))}
      </div>

      {data.attribution && (
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'صحة ربط المشاريع' : 'Project-link health'}</h3></div>
          <div className="cw-panelb">
            {([
              { k: 'attributed', ar: 'مرتبط بمشروع', en: 'Linked to a project', v: data.attribution.attributed, tone: 'ok' },
              { k: 'locked', ar: 'ثبّته إنسان', en: 'Fixed by a person', v: data.attribution.locked, tone: 'ok' },
              { k: 'name_absent', ar: 'اسم المشروع غائب عن النص', en: 'Project name absent from the text', v: data.attribution.name_absent, tone: 'warn' },
              { k: 'weak_picks', ar: 'ربط على كلمة واحدة', en: 'Link rests on one word', v: data.attribution.weak_picks, tone: 'warn' },
              { k: 'unknown_mentions', ar: 'يذكر مشروعًا غير مسجّل', en: 'Names an unknown project', v: data.attribution.unknown_mentions, tone: 'warn' },
              { k: 'awaiting', ar: 'بانتظار قرار الذكاء', en: 'Awaiting the AI decision', v: data.attribution.awaiting_decision, tone: 'warn' },
              { k: 'rerun', ar: 'في طابور إعادة الربط', en: 'Queued for re-linking', v: data.attribution.rerun_queued, tone: 'warn' },
            ] as Array<{ k: string; ar: string; en: string; v: number; tone: string }>).map((st) => {
              const base = data.attribution!.enriched || 1;
              const pct = Math.max(1, Math.round((st.v / base) * 100));
              return (
                <div className="cw-meter" key={st.k}>
                  <span className="cw-meterlbl"><span className={`cw-dot ${st.v > 0 || st.tone === 'ok' ? st.tone : 'ok'}`} /> {isAr ? st.ar : st.en}</span>
                  <span className="cw-track"><span className={`cw-fill ${st.tone}`} style={{ width: `${pct}%` }} /></span>
                  <span className="cw-meterval cw-mono">{num(st.v)}</span>
                </div>
              );
            })}
            <p className="cw-note">
              {isAr
                ? 'هذه هي الفحوصات نفسها التي كشفت الربط الخاطئ في سبتمبر 2026 — إن ارتفع «اسم المشروع غائب» أو «ربط على كلمة واحدة» فالقواعد تراجعت.'
                : 'These are the exact checks that exposed the wrong links in September 2026 — if "name absent" or "one word" climb, the rules have regressed.'}
            </p>
          </div>
        </div>
      )}

      <div className="cw-panel">
        <div className="cw-panelh"><h3>{isAr ? 'حالة المنشورات' : 'Where posts stand'}</h3></div>
        <div className="cw-panelb">
          {status.map((st) => {
            const v = data.by_status[st.key] ?? 0;
            const pct = Math.max(1, Math.round((v / total) * 100));
            return (
              <div className="cw-meter" key={st.key}>
                <span className="cw-meterlbl"><span className={`cw-dot ${st.tone}`} /> {isAr ? st.ar : st.en}</span>
                <span className="cw-track"><span className={`cw-fill ${st.tone}`} style={{ width: `${pct}%` }} /></span>
                <span className="cw-meterval cw-mono">{num(v)}</span>
              </div>
            );
          })}
          <p className="cw-note">
            {isAr
              ? 'المنشورات الجزئية لديها نصّها وحقائقها لكنها تفتقد خطوة ثقيلة (غالبًا تفريغ فيديو) — قابلة للاستخدام لا معطوبة.'
              : 'Partial posts have their text and facts but are missing one heavy step (usually a video transcript). Usable, not broken.'}
          </p>
        </div>
      </div>
    </div>
  );
}
