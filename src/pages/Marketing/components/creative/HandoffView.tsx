/**
 * HandoffView — the concise designer handoff, rendered from the latest applied
 * package (or the latest draft, marked as such). Order follows how a designer
 * actually reads: message/objective → exact on-design copy → slide plan →
 * palette → exact assets → references → composition/treatment → approved AI
 * production → warnings. Every section has a copy button; the whole sheet is
 * print-friendly (the workspace chrome hides under @media print).
 *
 * Shown FIRST when the open task's role is the role_map design owner — the
 * montage/designer opens the item and lands on their brief, not on the
 * writer's tooling.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DesignerHandoff } from '@/lib/creative/contracts';
import { fetchCreativeHandoff } from '@/lib/marketingOS/creativeClient';
import { useAppStore } from '@/stores/appStore';
import { LoadError, Skeleton } from '../kit';
import { num } from '../../lib/format';
import {
  AI_MODE_LABELS, INTENDED_USE_LABELS, PLACEMENT_LABELS,
  SLIDE_ROLE_LABELS, platformLabel, pick,
} from './labels';

/** One labeled block with its own copy button. */
function Section({
  title, copyText, isAr, addToast, children,
}: {
  title: string;
  copyText: string;
  isAr: boolean;
  addToast: (msg: string, kind: 'success' | 'error' | 'info') => void;
  children: React.ReactNode;
}) {
  const copy = (): void => {
    navigator.clipboard.writeText(copyText).then(
      () => addToast(isAr ? 'نُسخ.' : 'Copied.', 'success'),
      (e: unknown) => {
        console.error('[creative] clipboard copy failed', e);
        addToast(isAr ? 'تعذّر النسخ — انسخ يدويًا.' : 'Copy failed — copy manually.', 'error');
      },
    );
  };
  return (
    <div className="card" style={{ breakInside: 'avoid' }}>
      <div className="card-h">
        <h4>{title}</h4>
        <button type="button" className="btn btn-d btn-sm ho-noprint" onClick={copy}>
          {isAr ? 'نسخ' : 'Copy'}
        </button>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 6, fontSize: 13, lineHeight: 1.85 }}>
        {children}
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div><b>{k}: </b>{v}</div>
);

export default function HandoffView({ contentId, isAr }: { contentId: string; isAr: boolean }) {
  const addToast = useAppStore((s) => s.addToast);
  const [data, setData] = useState<{ handoff: DesignerHandoff; draft: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCreativeHandoff(contentId);
      setData({ handoff: res.handoff, draft: res.draft });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Skeleton rows={5} />;
  if (error) return <LoadError message={error} onRetry={() => void load()} isAr={isAr} />;
  if (!data) return null;

  const h = data.handoff;
  const L = isAr;

  /* Plain-text renderings for the copy buttons. */
  const messageTxt = [
    `${L ? 'الرسالة' : 'Message'}: ${h.message}`,
    `${L ? 'الهدف' : 'Objective'}: ${h.objective}`,
    `${L ? 'الجمهور' : 'Audience'}: ${h.audience}`,
    `${L ? 'الغرض' : 'Intended use'}: ${pick(INTENDED_USE_LABELS, h.intended_use, L)}`,
    `${L ? 'المقاس الرئيسي' : 'Master aspect'}: ${h.master_aspect}`,
    ...h.targets.map((t) =>
      `- ${platformLabel(t.platform, L)} · ${pick(PLACEMENT_LABELS, t.placement_type, L)} · ${t.aspect} · ${t.px[0]}×${t.px[1]}${t.requires_separate_design ? (L ? ' · تصميم منفصل' : ' · separate design') : ''}`),
  ].join('\n');

  const copyTxt = [
    h.design_text.project_name_lead,
    ...(h.design_text.latin_name ? [h.design_text.latin_name] : []),
    ...h.design_text.headlines,
    ...(h.design_text.cta_on_design ? [h.design_text.cta_on_design] : []),
  ].join('\n');

  const slidesTxt = h.slides.length === 0
    ? (L ? 'صورة واحدة — لا شرائح.' : 'Single image — no slides.')
    : h.slides.map((s) =>
        `${s.index}. [${pick(SLIDE_ROLE_LABELS, s.role, L)}] ${s.headline}${s.support ? ` — ${s.support}` : ''}\n   ${s.purpose}`).join('\n');

  const paletteTxt = h.palette.map((p) => `${p.name} ${p.hex} (${p.role})`).join('\n');

  const assetsTxt = h.assets.map((a) =>
    `- ${a.placement}: ${a.file_name ?? a.file_id} · ${a.usage} · ${a.treatment}${a.needs_rights_confirmation ? (L ? ' · الحقوق تحتاج تأكيدًا' : ' · rights need confirmation') : ''}`).join('\n');

  const refsTxt = h.references.map((r) =>
    `- ${r.why}\n  ${L ? 'ندرس' : 'study'}: ${r.study}\n  ${L ? 'لا ننسخ' : 'do not copy'}: ${r.do_not_copy}`).join('\n');

  const directionTxt = [
    `${L ? 'التكوين' : 'Composition'}: ${h.visual_direction.composition}`,
    `${L ? 'التخطيط' : 'Layout'}: ${h.visual_direction.layout}`,
    `${L ? 'المزاج' : 'Mood'}: ${h.visual_direction.mood.join(', ')}`,
    `${L ? 'معالجة الصورة' : 'Image treatment'}: ${h.visual_direction.image_treatment}`,
    `${L ? 'الخلفية' : 'Background'}: ${h.visual_direction.background}`,
    `${L ? 'الشعار' : 'Logo'}: ${h.visual_direction.logo.variant} · ${h.visual_direction.logo.position} · ${h.visual_direction.logo.color}`,
    `${L ? 'موضع الدعوة' : 'CTA'}: ${h.visual_direction.cta_placement}`,
    `${L ? 'المناطق الآمنة' : 'Safe zones'}: ${h.visual_direction.safe_zones_note}`,
    ...h.adaptations.map((a) =>
      `\n[${platformLabel(a.target.platform, L)} · ${pick(PLACEMENT_LABELS, a.target.placement_type, L)}] ${a.adaptation.image_instructions} | ${a.adaptation.text_reposition} | ${a.adaptation.logo_reposition} | ${a.adaptation.layout_changes} | ${a.adaptation.element_scaling}`),
  ].join('\n');

  const aiTxt = h.ai_production.length === 0
    ? (L ? 'لا إنتاج معتمد.' : 'No approved production.')
    : h.ai_production.map((r) =>
        `- [${pick(AI_MODE_LABELS, r.mode, L)}] ${r.prompt}\n  ${L ? 'يحافظ على' : 'keep'}: ${r.must_keep.join(', ')} | ${L ? 'يغيّر' : 'change'}: ${r.must_change.join(', ')}`).join('\n');

  return (
    <div className="ho-print" style={{ display: 'grid', gap: 14 }}>
      {/* Print rules: hide the workspace chrome + every button, keep the sheet. */}
      <style>{`
        @media print {
          .mos-rail, .phead, .rhead, .tabs, .wside, .ho-noprint, .mob-tabbar { display: none !important; }
          .mos-main, .wmain, .wsplit { display: block !important; width: 100% !important; padding: 0 !important; }
          .ho-print .card { border: 1px solid #999 !important; box-shadow: none !important; }
        }
      `}</style>

      {data.draft && (
        <div className="notice" style={{ fontSize: 12.5 }}>
          {L
            ? 'هذه الحزمة مسودة — لم تُطبَّق على المحتوى بعد. شاركها مع المصمم بوصفها اتجاهًا لا نهائيًا.'
            : 'This package is a draft — not applied to the content yet. Share it with the designer as direction, not final.'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 15 }}>{h.title}</h4>
        <span className="tag">{pick(INTENDED_USE_LABELS, h.intended_use, L)}</span>
        <span className="tag ltr">{h.master_aspect}</span>
        <button
          type="button"
          className="btn btn-sm ho-noprint"
          style={{ marginInlineStart: 'auto' }}
          onClick={() => window.print()}
        >
          {L ? 'طباعة' : 'Print'}
        </button>
      </div>

      <Section title={L ? 'الرسالة والهدف' : 'Message & objective'} copyText={messageTxt} isAr={L} addToast={addToast}>
        <Row k={L ? 'الرسالة' : 'Message'} v={h.message} />
        <Row k={L ? 'الهدف' : 'Objective'} v={h.objective} />
        <Row k={L ? 'الجمهور' : 'Audience'} v={h.audience} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {h.targets.map((t, i) => (
            <span key={i} className="tag">
              {platformLabel(t.platform, L)} · {pick(PLACEMENT_LABELS, t.placement_type, L)}
              {' · '}<span className="ltr">{t.aspect} {t.px[0]}×{t.px[1]}</span>
              {t.requires_separate_design ? (L ? ' · منفصل' : ' · separate') : ''}
            </span>
          ))}
        </div>
      </Section>

      <Section title={L ? 'النص على التصميم (حرفيًا)' : 'On-design copy (verbatim)'} copyText={copyTxt} isAr={L} addToast={addToast}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{h.design_text.project_name_lead}</div>
        {h.design_text.latin_name && <div className="ltr" style={{ color: 'var(--mute)' }}>{h.design_text.latin_name}</div>}
        {h.design_text.headlines.map((line, i) => <div key={i}>{line}</div>)}
        {h.design_text.cta_on_design && <div><b>{h.design_text.cta_on_design}</b></div>}
      </Section>

      <Section title={L ? 'خطة الشرائح' : 'Slide plan'} copyText={slidesTxt} isAr={L} addToast={addToast}>
        {h.slides.length === 0 ? (
          <div>{L ? 'صورة واحدة — لا شرائح.' : 'Single image — no slides.'}</div>
        ) : h.slides.map((s) => (
          <div key={s.index} style={{ borderInlineStart: '2px solid var(--line)', paddingInlineStart: 10 }}>
            <b>{num(s.index, L)} · {pick(SLIDE_ROLE_LABELS, s.role, L)} — {s.headline}</b>
            {s.support && <div>{s.support}</div>}
            <div style={{ color: 'var(--mute)', fontSize: 12 }}>{s.purpose}</div>
          </div>
        ))}
      </Section>

      <Section title={L ? 'لوحة الألوان' : 'Palette'} copyText={paletteTxt} isAr={L} addToast={addToast}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {h.palette.map((p, i) => (
            <span key={i} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 14, borderRadius: 4, background: p.hex, border: '1px solid var(--line)', display: 'inline-block' }} />
              {p.name} <span className="ltr">{p.hex}</span> · {p.role}
            </span>
          ))}
        </div>
      </Section>

      <Section title={L ? 'الأصول المطلوبة (بالضبط)' : 'Exact assets'} copyText={assetsTxt} isAr={L} addToast={addToast}>
        {h.assets.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {a.preview_url && (
              <img src={a.preview_url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} loading="lazy" />
            )}
            <div>
              <b>{a.placement}</b> — {a.file_name ?? <span className="ltr">{a.file_id.slice(0, 8)}</span>}
              <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {a.usage} · {a.treatment}
                {a.needs_rights_confirmation && (
                  <span style={{ color: 'var(--wait)', fontWeight: 700 }}>
                    {' · '}{L ? 'الحقوق تحتاج تأكيدًا' : 'rights need confirmation'}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </Section>

      {h.references.length > 0 && (
        <Section title={L ? 'المراجع (دراسة لا نسخ)' : 'References (study, not copy)'} copyText={refsTxt} isAr={L} addToast={addToast}>
          {h.references.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {r.preview_url && (
                <img src={r.preview_url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', flex: '0 0 56px' }} loading="lazy" />
              )}
              <div style={{ fontSize: 12.5 }}>
                <div><b>{L ? 'لماذا: ' : 'Why: '}</b>{r.why}</div>
                <div><b>{L ? 'ندرس: ' : 'Study: '}</b>{r.study}</div>
                <div style={{ color: 'var(--late)' }}><b>{L ? 'لا ننسخ: ' : 'Do not copy: '}</b>{r.do_not_copy}</div>
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section title={L ? 'التكوين والمعالجة + تكييفات المقاسات' : 'Composition, treatment & adaptations'} copyText={directionTxt} isAr={L} addToast={addToast}>
        <Row k={L ? 'التكوين' : 'Composition'} v={h.visual_direction.composition} />
        <Row k={L ? 'التخطيط' : 'Layout'} v={h.visual_direction.layout} />
        <Row k={L ? 'معالجة الصورة' : 'Image treatment'} v={h.visual_direction.image_treatment} />
        <Row k={L ? 'الخلفية' : 'Background'} v={h.visual_direction.background} />
        <Row k={L ? 'الشعار' : 'Logo'} v={`${h.visual_direction.logo.variant} · ${h.visual_direction.logo.position} · ${h.visual_direction.logo.color}`} />
        <Row k={L ? 'المناطق الآمنة' : 'Safe zones'} v={h.visual_direction.safe_zones_note} />
        {h.adaptations.map((a, i) => (
          <div key={i} style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 6, marginTop: 2 }}>
            <b>{platformLabel(a.target.platform, L)} · {pick(PLACEMENT_LABELS, a.target.placement_type, L)}</b>
            {a.adaptation.requires_separate_design && (
              <span className="pill p-wait" style={{ marginInlineStart: 6 }}>{L ? 'تصميم منفصل' : 'Separate design'}</span>
            )}
            <div style={{ fontSize: 12 }}>{a.adaptation.image_instructions}</div>
            <div style={{ fontSize: 12 }}>{a.adaptation.text_reposition}</div>
            <div style={{ fontSize: 12 }}>{a.adaptation.logo_reposition}</div>
            <div style={{ fontSize: 12 }}>{a.adaptation.layout_changes}</div>
            <div style={{ fontSize: 12 }}>{a.adaptation.element_scaling}</div>
          </div>
        ))}
      </Section>

      <Section title={L ? 'إنتاج الصور المعتمد بالذكاء' : 'Approved AI production'} copyText={aiTxt} isAr={L} addToast={addToast}>
        {h.ai_production.length === 0 ? (
          <div>{L ? 'لا إنتاج معتمد.' : 'No approved production.'}</div>
        ) : h.ai_production.map((r) => (
          <div key={r.index} style={{ fontSize: 12.5 }}>
            <span className="tag tag-t">{pick(AI_MODE_LABELS, r.mode, L)}</span> {r.prompt}
          </div>
        ))}
        {h.ai_suggested_not_approved > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
            {L
              ? `${num(h.ai_suggested_not_approved, true)} مقترحات لم تُعتمد — اختيارية على المصمم.`
              : `${h.ai_suggested_not_approved} unapproved suggestions — optional for the designer.`}
          </div>
        )}
      </Section>

      {(h.warnings.length > 0 || h.missing.length > 0) && (
        <div className="notice bad" style={{ fontSize: 12.5 }}>
          {h.warnings.map((w, i) => <div key={i}>{w}</div>)}
          {h.missing.length > 0 && (
            <div><b>{L ? 'نواقص: ' : 'Missing: '}</b>{h.missing.join(L ? '، ' : ', ')}</div>
          )}
        </div>
      )}
    </div>
  );
}
