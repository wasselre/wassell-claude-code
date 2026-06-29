import { describe, it, expect } from 'vitest';
import { canonPropertyType } from './propertyType';

describe('canonPropertyType — mirrors SQL wassell_canon_property_type', () => {
  it('collapses villa variants', () => {
    for (const v of ['فيلا', 'فيلا سكنية', 'فيلا للبيع', 'فيلا دوبلكس', 'فيلا دبلكس', 'فلل للبيع', 'فيلا مستقلة'])
      expect(canonPropertyType(v)).toBe('فيلا');
  });
  it('townhouse before apartment/floor', () => {
    expect(canonPropertyType('تاون هاوس')).toBe('تاون هاوس');
    expect(canonPropertyType('تاون هاوس علوي')).toBe('تاون هاوس');
  });
  it('apartment variants', () => {
    for (const v of ['شقة', 'شقة سكنية', 'شقق للبيع']) expect(canonPropertyType(v)).toBe('شقة');
  });
  it('floor (دور) variants — and دور أرضي stays floor (not land)', () => {
    expect(canonPropertyType('دور')).toBe('دور');
    expect(canonPropertyType('دور أرضي')).toBe('دور');
    expect(canonPropertyType('دور ارضي')).toBe('دور');
    expect(canonPropertyType('دور علوي')).toBe('دور');
  });
  it('land variants — but أرض سكنية is land not residential', () => {
    expect(canonPropertyType('أرض')).toBe('أرض');
    expect(canonPropertyType('أرض سكنية')).toBe('أرض');
    expect(canonPropertyType('أراضي للبيع')).toBe('أرض');
  });
  it('building / commercial / rest house / residential', () => {
    expect(canonPropertyType('عمارة سكنية')).toBe('عمارة');
    expect(canonPropertyType('تجاري')).toBe('تجاري');
    expect(canonPropertyType('استراحة')).toBe('استراحة');
    expect(canonPropertyType('سكني')).toBe('سكني');
  });
  it('empty / unknown → أخرى', () => {
    expect(canonPropertyType('')).toBe('أخرى');
    expect(canonPropertyType(null)).toBe('أخرى');
    expect(canonPropertyType(undefined)).toBe('أخرى');
    expect(canonPropertyType('something else')).toBe('أخرى');
  });
});
