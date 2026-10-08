/**
 * The amenity "where to look" picker renders one 3-way choice per selected
 * amenity, shows the saved choice, and defaults to «الاثنين».
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import FieldConstraintControl from '../FieldConstraintControl';

const noop = () => undefined;

describe('FieldConstraintControl — amenity scopes', () => {
  it('one row per selected amenity with unit / project / either', () => {
    const html = renderToStaticMarkup(
      <FieldConstraintControl
        field="amenities"
        constraints={{ amenities: { mode: 'hard', scopes: { 'غرفة خادمة': 'unit', 'مسبح': 'project' } } }}
        onChange={noop}
        isAr
        amenityOptions={[{ value: 'غرفة خادمة', label: 'غرفة خادمة' }, { value: 'مسبح', label: 'مسبح' }, { value: 'مصعد', label: 'مصعد' }]}
      />,
    );
    expect(html).toContain('أين تبحث عن كل ميزة؟');
    expect(html.match(/>في الوحدة</g)).toHaveLength(3);
    expect(html.match(/>في المشروع</g)).toHaveLength(3);
    // pressed buttons: maid → unit, pool → project, elevator → either (default)
    const pressed = [...html.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(pressed).toEqual(expect.arrayContaining(['في الوحدة', 'في المشروع', 'الاثنين']));
  });
  it('no picker for other fields or when nothing is selected', () => {
    expect(renderToStaticMarkup(<FieldConstraintControl field="budget" constraints={{}} onChange={noop} isAr />)).not.toContain('أين تبحث');
    expect(renderToStaticMarkup(<FieldConstraintControl field="amenities" constraints={{}} onChange={noop} isAr amenityOptions={[]} />)).not.toContain('أين تبحث');
  });
});
