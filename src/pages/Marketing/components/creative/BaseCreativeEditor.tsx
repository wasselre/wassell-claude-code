/**
 * BaseCreativeEditor — the master creative the derivatives adapt from.
 *
 * Editable: the strategy's message/angle/audience/objective, the on-design
 * text (project name lead, headline lines, CTA), and per-slide copy for
 * carousels (via SlideNavigator). The visual direction renders read-only — it
 * is the designer's brief, rewritten by regeneration rather than by typing.
 * Every save lands as a NEW human version server-side; nothing is overwritten
 * in place.
 */
import { useState } from 'react';
import type { BasePackage, SlidePlan, Strategy } from '@/lib/creative/contracts';
import { ReadField } from '../kit';
import SlideNavigator from './SlideNavigator';
import { num } from '../../lib/format';
import { INTENDED_USE_LABELS, SLIDE_ROLE_LABELS, pick } from './labels';

const RESPONSE_LABELS: Record<Strategy['desired_response'], { ar: string; en: string }> = {
  save:  { ar: 'حفظ المنشور', en: 'Save the post' },
  dm:    { ar: 'رسالة خاصة', en: 'Direct message' },
  call:  { ar: 'اتصال', en: 'Call' },
  visit: { ar: 'زيارة', en: 'Visit' },
  share: { ar: 'مشاركة', en: 'Share' },
};

export default function BaseCreativeEditor({
  base, canEdit, isAr, onChange,
}: {
  base: BasePackage;
  canEdit: boolean;
  isAr: boolean;
  onChange: (next: BasePackage) => void;
}) {
  const [slideIdx, setSlideIdx] = useState(0);

  const patchStrategy = (patch: Partial<Strategy>): void =>
    onChange({ ...base, strategy: { ...base.strategy, ...patch } });
  const patchDesignText = (patch: Partial<BasePackage['design_text']>): void =>
    onChange({ ...base, design_text: { ...base.design_text, ...patch } });
  const patchSlide = (i: number, patch: Partial<SlidePlan>): void =>
    onChange({
      ...base,
      slides: base.slides.map((s, si) => (si === i ? { ...s, ...patch } : s)),
    });

  const slides = [...base.slides].sort((a, b) => a.index - b.index);
  const slide = slides[slideIdx] ?? null;
  const vd = base.visual_direction;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الإبداع الأساسي' : 'Base creative'}</h4>
        <span className="r">
          {isAr ? 'المقاس الرئيسي ' : 'master aspect '}
          <span className="ltr">{base.strategy.master_aspect}</span>
          {' · '}
          {base.strategy.format === 'carousel'
            ? (isAr ? `كاروسيل · ${num(slides.length, true)} شرائح` : `carousel · ${slides.length} slides`)
            : (isAr ? 'صورة واحدة' : 'single image')}
          {' · '}
          {pick(INTENDED_USE_LABELS, base.strategy.intended_use, isAr)}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 16 }}>
        {/* ── strategy ─────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="doc-lbl">{isAr ? 'الاستراتيجية' : 'Strategy'}</div>
          <label>
            <span className="lbl">{isAr ? 'الرسالة الأساسية' : 'Main message'}</span>
            <textarea
              className="inp" rows={2} style={{ marginTop: 3 }}
              value={base.strategy.main_message}
              disabled={!canEdit}
              onChange={(e) => patchStrategy({ main_message: e.target.value })}
            />
          </label>
          <div className="grid g2" style={{ gap: 10 }}>
            <label>
              <span className="lbl">{isAr ? 'الهدف' : 'Objective'}</span>
              <input
                className="inp" style={{ marginTop: 3 }}
                value={base.strategy.objective}
                disabled={!canEdit}
                onChange={(e) => patchStrategy({ objective: e.target.value })}
              />
            </label>
            <label>
              <span className="lbl">{isAr ? 'الجمهور' : 'Audience'}</span>
              <input
                className="inp" style={{ marginTop: 3 }}
                value={base.strategy.audience}
                disabled={!canEdit}
                onChange={(e) => patchStrategy({ audience: e.target.value })}
              />
            </label>
            <label>
              <span className="lbl">{isAr ? 'الزاوية' : 'Angle'}</span>
              <input
                className="inp" style={{ marginTop: 3 }}
                value={base.strategy.angle}
                disabled={!canEdit}
                onChange={(e) => patchStrategy({ angle: e.target.value })}
              />
            </label>
            <label>
              <span className="lbl">{isAr ? 'الاستجابة المطلوبة' : 'Desired response'}</span>
              <select
                className="inp" style={{ marginTop: 3 }}
                value={base.strategy.desired_response}
                disabled={!canEdit}
                onChange={(e) => patchStrategy({ desired_response: e.target.value as Strategy['desired_response'] })}
              >
                {(Object.keys(RESPONSE_LABELS) as Strategy['desired_response'][]).map((k) => (
                  <option key={k} value={k}>{isAr ? RESPONSE_LABELS[k].ar : RESPONSE_LABELS[k].en}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* ── on-design text ───────────────────────────────────────── */}
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="doc-lbl">{isAr ? 'النص على التصميم' : 'On-design text'}</div>
          <label>
            <span className="lbl">
              {isAr ? 'اسم المشروع (الصدارة)' : 'Project name (the lead)'}
            </span>
            <input
              className="inp" style={{ marginTop: 3 }}
              value={base.design_text.project_name_lead}
              disabled={!canEdit}
              onChange={(e) => patchDesignText({ project_name_lead: e.target.value })}
            />
          </label>
          {base.design_text.latin_name !== null && (
            <label>
              <span className="lbl">{isAr ? 'الاسم اللاتيني' : 'Latin name'}</span>
              <input
                className="inp ltr" style={{ marginTop: 3 }}
                value={base.design_text.latin_name}
                disabled={!canEdit}
                onChange={(e) => patchDesignText({ latin_name: e.target.value || null })}
              />
            </label>
          )}
          <div>
            <span className="lbl">{isAr ? 'سطور العنوان' : 'Headline lines'}</span>
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              {base.design_text.headlines.map((h, hi) => (
                <input
                  key={hi}
                  className="inp"
                  value={h}
                  disabled={!canEdit}
                  onChange={(e) =>
                    patchDesignText({
                      headlines: base.design_text.headlines.map((x, xi) => (xi === hi ? e.target.value : x)),
                    })}
                />
              ))}
            </div>
          </div>
          <label>
            <span className="lbl">{isAr ? 'الدعوة على التصميم' : 'CTA on the design'}</span>
            <input
              className="inp" style={{ marginTop: 3 }}
              value={base.design_text.cta_on_design ?? ''}
              disabled={!canEdit}
              onChange={(e) => patchDesignText({ cta_on_design: e.target.value || null })}
            />
          </label>
        </div>

        {/* ── slides (carousel) ────────────────────────────────────── */}
        {slides.length > 0 && slide && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="doc-lbl">{isAr ? 'الشرائح' : 'Slides'}</div>
            <SlideNavigator slides={slides} activeIndex={slideIdx} isAr={isAr} onSelect={setSlideIdx} />
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="tag tag-t">
                  {num(slide.index, isAr)} · {pick(SLIDE_ROLE_LABELS, slide.role, isAr)}
                </span>
              </div>
              <label>
                <span className="lbl">{isAr ? 'عنوان الشريحة' : 'Slide headline'}</span>
                <input
                  className="inp" style={{ marginTop: 3 }}
                  value={slide.headline}
                  disabled={!canEdit}
                  onChange={(e) => patchSlide(slideIdx, { headline: e.target.value })}
                />
              </label>
              <label>
                <span className="lbl">{isAr ? 'النص المساند' : 'Support line'}</span>
                <input
                  className="inp" style={{ marginTop: 3 }}
                  value={slide.support ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => patchSlide(slideIdx, { support: e.target.value || null })}
                />
              </label>
              <label>
                <span className="lbl">{isAr ? 'الغرض' : 'Purpose'}</span>
                <textarea
                  className="inp" rows={2} style={{ marginTop: 3 }}
                  value={slide.purpose}
                  disabled={!canEdit}
                  onChange={(e) => patchSlide(slideIdx, { purpose: e.target.value })}
                />
              </label>
              <label>
                <span className="lbl">{isAr ? 'الاستمرارية مع بقية الشرائح' : 'Continuity'}</span>
                <input
                  className="inp" style={{ marginTop: 3 }}
                  value={slide.continuity}
                  disabled={!canEdit}
                  onChange={(e) => patchSlide(slideIdx, { continuity: e.target.value })}
                />
              </label>
            </div>
          </div>
        )}

        {/* ── visual direction (read-only brief) ───────────────────── */}
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="doc-lbl">{isAr ? 'الاتجاه البصري (للمصمم)' : 'Visual direction (for the designer)'}</div>
          <div className="grid g2" style={{ gap: 10 }}>
            <ReadField label={isAr ? 'التكوين' : 'Composition'}>{vd.composition}</ReadField>
            <ReadField label={isAr ? 'التخطيط' : 'Layout'}>{vd.layout}</ReadField>
            <ReadField label={isAr ? 'المزاج' : 'Mood'}>{vd.mood.join(isAr ? '، ' : ', ')}</ReadField>
            <ReadField label={isAr ? 'التسلسل' : 'Hierarchy'}>{vd.hierarchy.join(' ← ')}</ReadField>
            <ReadField label={isAr ? 'الخط' : 'Typography'}>
              {vd.typography.display}
              {' · '}
              {isAr ? `${num(vd.typography.size_levels, true)} مستويات` : `${vd.typography.size_levels} levels`}
              {' · '}
              {vd.typography.numerals === 'arabic_indic' ? (isAr ? 'أرقام عربية' : 'Arabic-Indic numerals') : (isAr ? 'أرقام غربية' : 'Western numerals')}
            </ReadField>
            <ReadField label={isAr ? 'معالجة الصورة' : 'Image treatment'}>{vd.image_treatment}</ReadField>
            <ReadField label={isAr ? 'الخلفية' : 'Background'}>{vd.background}</ReadField>
            <ReadField label={isAr ? 'الشعار' : 'Logo'}>
              {vd.logo.variant} · {vd.logo.position} · {vd.logo.color}
            </ReadField>
            <ReadField label={isAr ? 'موضع الدعوة' : 'CTA placement'}>{vd.cta_placement}</ReadField>
            <ReadField label={isAr ? 'المساحة السالبة' : 'Negative space'}>{vd.negative_space}</ReadField>
          </div>
          {vd.safe_zones_note && (
            <ReadField label={isAr ? 'المناطق الآمنة' : 'Safe zones'}>{vd.safe_zones_note}</ReadField>
          )}
          {vd.decoration.length > 0 && (
            <ReadField label={isAr ? 'الزخارف' : 'Decoration'}>{vd.decoration.join(isAr ? '، ' : ', ')}</ReadField>
          )}
        </div>
      </div>
    </div>
  );
}
