/**
 * SlideNavigator — the carousel's slide strip. One chip per slide (index +
 * role), the selected slide lights up; the parent editor renders that slide's
 * fields. Numbers are 1-based, matching SlidePlan.index.
 */
import type { SlidePlan } from '@/lib/creative/contracts';
import { num } from '../../lib/format';
import { SLIDE_ROLE_LABELS, pick } from './labels';

export default function SlideNavigator({
  slides, activeIndex, isAr, onSelect,
}: {
  slides: SlidePlan[];
  activeIndex: number;
  isAr: boolean;
  onSelect: (index: number) => void;
}) {
  if (slides.length === 0) return null;
  const sorted = [...slides].sort((a, b) => a.index - b.index);
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="lbl">{isAr ? 'الشرائح' : 'Slides'}</span>
      {sorted.map((s, i) => (
        <button
          key={s.index}
          type="button"
          className={`fbtn${i === activeIndex ? ' on' : ''}`}
          onClick={() => onSelect(i)}
        >
          {num(s.index, isAr)} · {pick(SLIDE_ROLE_LABELS, s.role, isAr)}
        </button>
      ))}
    </div>
  );
}
