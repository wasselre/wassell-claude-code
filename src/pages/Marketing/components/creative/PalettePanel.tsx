/**
 * PalettePanel — the package palette as swatches with roles, the brand-kit mode
 * it was judged against, and a contrast hint when a text color sits on a
 * background color with too little difference to read.
 *
 * Advisory vs constraint is DATA (the kit's reviewed status), shown as a tag —
 * advisory lists deviations, constraint would have failed validation upstream.
 */
import type { BasePackage, PaletteEntry } from '@/lib/creative/contracts';

/** sRGB channel → linear-light value (WCAG). */
const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** Relative luminance of '#rrggbb'; null when the hex can't be parsed. */
function luminance(hex: string): number | null {
  const m = hex.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1] ?? '0', 16);
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hexes; null when either is unparseable. */
function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const isTextRole = (role: string): boolean => /text|headline|عنوان|نص/i.test(role);
const isBgRole = (role: string): boolean => /background|bg|خلفية/i.test(role);

export default function PalettePanel({
  palette, rationale, kit, isAr,
}: {
  palette: PaletteEntry[];
  rationale: string;
  kit: BasePackage['brand_kit'];
  isAr: boolean;
}) {
  if (palette.length === 0) return null;

  const texts = palette.filter((p) => isTextRole(p.role));
  const bgs = palette.filter((p) => isBgRole(p.role));
  const lowContrast: Array<{ a: PaletteEntry; b: PaletteEntry; ratio: number }> = [];
  for (const t of texts) {
    for (const b of bgs) {
      const ratio = contrast(t.hex, b.hex);
      // 3.0 = large-text WCAG floor; design text on a post is display-size.
      if (ratio !== null && ratio < 3) lowContrast.push({ a: t, b, ratio });
    }
  }

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'لوحة الألوان' : 'Palette'}</h4>
        <span className="r">
          {isAr ? 'عدة الهوية ' : 'brand kit '}
          {kit.mode === 'constraint'
            ? (isAr ? `إصدار ${kit.version} · إلزامية` : `v${kit.version} · constraint`)
            : (isAr ? `إصدار ${kit.version} · استشارية` : `v${kit.version} · advisory`)}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {palette.map((p, i) => (
            <div key={`${p.hex}-${i}`} style={{ display: 'grid', gap: 3, justifyItems: 'center', width: 86 }}>
              <span
                title={p.hex}
                style={{
                  width: 100, height: 44, borderRadius: 8, background: p.hex,
                  border: '1px solid var(--line)', display: 'block',
                }}
              />
              <div style={{ fontSize: 11, fontWeight: 700, textAlign: 'center' }}>{p.name}</div>
              <div style={{ fontSize: 10, color: 'var(--mute)', textAlign: 'center' }}>
                <span className="ltr">{p.hex}</span> · {p.role}
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--mute)' }}>
                {p.source === 'brand_kit'
                  ? (isAr ? 'عدة الهوية' : 'brand kit')
                  : p.source === 'project_identity'
                    ? (isAr ? 'هوية المشروع' : 'project identity')
                    : (isAr ? 'من الأصول' : 'from assets')}
              </div>
            </div>
          ))}
        </div>

        {lowContrast.length > 0 && (
          <div className="notice bad" style={{ fontSize: 12 }}>
            {lowContrast.map((c, i) => (
              <div key={i}>
                {isAr
                  ? `تباين ضعيف: «${c.a.name}» على «${c.b.name}» (نسبة ${c.ratio.toFixed(1)}:1) — قد يصعب قراءة النص.`
                  : `Low contrast: “${c.a.name}” on “${c.b.name}” (${c.ratio.toFixed(1)}:1) — the text may be hard to read.`}
              </div>
            ))}
          </div>
        )}

        {kit.deviations.length > 0 && (
          <div className="notice" style={{ fontSize: 12 }}>
            <b>{isAr ? 'انحرافات عن عدة الهوية: ' : 'Deviations from the brand kit: '}</b>
            {kit.deviations.join(isAr ? '، ' : ', ')}
          </div>
        )}

        {rationale && (
          <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8 }}>{rationale}</div>
        )}
      </div>
    </div>
  );
}
