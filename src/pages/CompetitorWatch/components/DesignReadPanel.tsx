/**
 * How a competitor IMAGE post is designed — the visual_design_reads rows for
 * the post (one PostRead) and each of its images (one SlideRead per image),
 * written by the Gemini design reader (worker geminiDesign.ts, 2026-10-05).
 * Shown inside an expanded Content Library entry.
 */
import type { PostRead, SlideRead, VisualDesignReadRow } from '@/lib/creative/contracts';

type Labels = Record<string, [string, string]>;
const LAYOUT: Labels = {
  full_bleed_photo_text_bottom: ['صورة كاملة ونص أسفلها', 'Full photo, text bottom'],
  full_bleed_photo_text_top: ['صورة كاملة ونص أعلاها', 'Full photo, text top'],
  split_horizontal: ['مقسوم أفقيًا', 'Split horizontal'],
  split_vertical: ['مقسوم عموديًا', 'Split vertical'],
  text_only: ['نص فقط', 'Text only'],
  grid: ['شبكة', 'Grid'],
  framed: ['داخل إطار', 'Framed'],
  collage: ['كولاج', 'Collage'],
  other: ['أخرى', 'Other'],
};
const ROLE: Labels = {
  cover: ['غلاف', 'Cover'], feature: ['ميزة', 'Feature'], specs: ['مواصفات', 'Specs'], offer: ['عرض', 'Offer'],
  location: ['الموقع', 'Location'], proof: ['إثبات', 'Proof'], lifestyle: ['أسلوب حياة', 'Lifestyle'],
  cta: ['دعوة للتواصل', 'Call to action'], brand: ['هوية', 'Brand'], other: ['أخرى', 'Other'],
};
const IMAGE_KIND: Labels = {
  photo: ['تصوير حقيقي', 'Photo'], render: ['تصميم ثلاثي الأبعاد', '3D render'], illustration: ['رسم', 'Illustration'],
  graphic: ['جرافيك', 'Graphic'], none: ['بلا صورة', 'No image'],
};
const SUBJECT: Labels = {
  exterior: ['واجهة', 'Exterior'], interior: ['داخلي', 'Interior'], plan: ['مخطط', 'Plan'], aerial: ['جوي', 'Aerial'],
  lifestyle: ['أسلوب حياة', 'Lifestyle'], people: ['أشخاص', 'People'], abstract: ['تجريدي', 'Abstract'], none: ['—', '—'],
};
const FONT: Labels = {
  naskh: ['نسخ', 'Naskh'], kufi: ['كوفي', 'Kufi'], modern_sans: ['خط حديث', 'Modern sans'],
  calligraphic: ['خط فني', 'Calligraphic'], mixed: ['مختلط', 'Mixed'], none: ['بلا نص', 'No text'],
};
const DENSITY: Labels = { low: ['قليل', 'Low'], medium: ['متوسط', 'Medium'], high: ['كثيف', 'High'] };

const lbl = (map: Labels, v: string | null | undefined, isAr: boolean): string => {
  if (!v) return '—';
  const hit = map[v];
  return hit ? (isAr ? hit[0] : hit[1]) : v.replace(/_/g, ' ');
};

function Swatches({ hexes }: { hexes: string[] }) {
  if (hexes.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 3, verticalAlign: 'middle' }}>
      {hexes.slice(0, 6).map((h, i) => (
        <span key={i} title={h} style={{ width: 14, height: 14, borderRadius: 4, background: h, border: '1px solid var(--cw-line)', display: 'inline-block' }} />
      ))}
    </span>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return <span className="cw-fact" dir="auto"><span>{k}</span>: <b>{v}</b></span>;
}

export default function DesignReadPanel({ reads, isAr }: { reads: VisualDesignReadRow[]; isAr: boolean }) {
  const done = reads.filter((r) => r.status === 'done');
  const post = done.find((r) => r.level === 'post');
  // One read per image: the newest per slide index.
  const slideMap = new Map<number, VisualDesignReadRow>();
  for (const r of done.filter((x) => x.level === 'slide')) {
    const k = r.slide_index ?? 0;
    const prev = slideMap.get(k);
    if (!prev || prev.created_at < r.created_at) slideMap.set(k, r);
  }
  const slides = [...slideMap.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const failed = reads.find((r) => r.status === 'failed' && r.level === 'post');

  if (!post && slides.length === 0) {
    return failed
      ? <div className="cw-txnote">{isAr ? `تعذّرت قراءة التصميم: ${failed.failure_reason ?? ''}` : `The design read failed: ${failed.failure_reason ?? ''}`}</div>
      : null;
  }
  const pr = post ? (post.read as PostRead) : null;
  return (
    <div className="cw-dblock">
      <div className="cw-k">{isAr ? 'التصميم' : 'Design'}</div>
      {pr && (
        <div style={{ marginBottom: 10 }}>
          {pr.summary && <div className="cw-v" dir="auto" style={{ marginBottom: 6 }}>{pr.summary}</div>}
          <div className="cw-facts" style={{ marginBottom: 6 }}>
            <Fact k={isAr ? 'الشكل' : 'Format'} v={pr.format === 'carousel' ? (isAr ? `كاروسيل ${pr.slide_count} صور` : `Carousel, ${pr.slide_count} images`) : (isAr ? 'صورة واحدة' : 'Single image')} />
            {pr.recurring_layout?.layout_family && <Fact k={isAr ? 'القالب' : 'Template'} v={pr.recurring_layout.layout_family.replace(/_/g, ' ')} />}
            <Fact k={isAr ? 'حضور الهوية' : 'Branding'} v={`${pr.branding_intensity}/3`} />
            {pr.mood?.length > 0 && <Fact k={isAr ? 'الطابع' : 'Mood'} v={pr.mood.slice(0, 3).join('، ')} />}
            {pr.design_system?.palette?.length > 0 && <span className="cw-fact"><span>{isAr ? 'الألوان' : 'Colours'}</span>: <Swatches hexes={pr.design_system.palette.map((p) => p.hex)} /></span>}
          </div>
          {pr.strengths?.length > 0 && (
            <div className="cw-v" dir="auto"><b>{isAr ? 'ما ينجح: ' : 'What works: '}</b>{pr.strengths.join('؛ ')}</div>
          )}
          {pr.weaknesses?.length > 0 && (
            <div className="cw-v" dir="auto"><b>{isAr ? 'ما يُضعفه: ' : 'Weak spots: '}</b>{pr.weaknesses.join('؛ ')}</div>
          )}
          {pr.learnable?.structure && (
            <div className="cw-v" dir="auto"><b>{isAr ? 'الدرس: ' : 'Lesson: '}</b>{pr.learnable.structure}{pr.learnable.avoid ? ` — ${isAr ? 'تجنّب' : 'avoid'}: ${pr.learnable.avoid}` : ''}</div>
          )}
        </div>
      )}
      {slides.length > 0 && (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))' }}>
          {slides.map((r, i) => {
            const s = r.read as SlideRead;
            return (
              <div key={r.id} style={{ border: '1px solid var(--cw-line)', borderRadius: 10, padding: '8px 10px', background: 'var(--cw-card)' }}>
                <div style={{ fontSize: 12, marginBottom: 4 }} dir="auto">
                  <b>{isAr ? `صورة ${i + 1}` : `Image ${i + 1}`}</b> · {lbl(ROLE, s.slide_role, isAr)}
                </div>
                <div className="cw-facts" style={{ marginBottom: 4 }}>
                  <Fact k={isAr ? 'التخطيط' : 'Layout'} v={lbl(LAYOUT, s.layout, isAr)} />
                  <Fact k={isAr ? 'الصورة' : 'Image'} v={s.image?.present ? `${lbl(IMAGE_KIND, s.image.kind, isAr)} · ${lbl(SUBJECT, s.image.subject, isAr)}` : lbl(IMAGE_KIND, 'none', isAr)} />
                  <Fact k={isAr ? 'الخط' : 'Type'} v={lbl(FONT, s.typography?.arabic_style, isAr)} />
                  <Fact k={isAr ? 'كثافة النص' : 'Text'} v={lbl(DENSITY, s.density, isAr)} />
                  {s.cta?.present && <Fact k="CTA" v={s.cta.treatment} />}
                  {s.palette?.length > 0 && <span className="cw-fact"><Swatches hexes={s.palette.map((p) => p.hex)} /></span>}
                </div>
                {s.notes && <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--cw-ink2)' }} dir="auto">{s.notes}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
