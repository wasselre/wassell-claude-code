import { describe, it, expect } from 'vitest';
import { menacoListingId, parseMenacoCards, parseMenacoSub } from '../projectUpdates/menaco';

// Trimmed from the live sub-listing HTML (2026-10-05): card text order, the
// «متاح للزيارة» visit tag, the for-what badge, a reserved card without price.
const card = (key: string, inner: string, badge: string, sub: string) =>
  `<div wire:key="sub-listing-${key}"><a href="https://menaco.sa/listings/sub/${sub}"><svg><path/></svg></a>${inner}` +
  `<span class="for-what">${badge}</span><script>x()</script></div>{ if (showInterestedModal) junk`;

const html =
  card('1649-0', '<h4>A51</h4><span>1,964,000</span><p>الرياض - حي التعاون</p><span>3 غرفة نوم</span><span>3 حمام</span><span>268.72 متر مربع</span>', 'للبيع', '425821') +
  card('1647-2', '<h4>A49</h4><p>الرياض - حي التعاون</p><span>1 غرفة نوم</span><span>2 حمام</span><span>80.67 متر مربع</span>', 'محجوز', '593736') +
  card('1501-1', '<em>متاح للزيارة</em><h4>3/1</h4><span>1,672,000</span><p>الرياض - حي النرجس</p><span>3 غرفة نوم</span><span>3 حمام</span><span>130 متر مربع</span>', 'محجوز', '692577') +
  card('1500-4', '<h4>2/3</h4><span>1,472,000</span><p>الرياض - حي النرجس</p><span>3 غرفة نوم</span><span>3 حمام</span><span>112 متر مربع</span>', 'مباع', '672283');

describe('Menaco listing cards', () => {
  const u = parseMenacoCards(html);
  it('reads model, price, status, rooms and the unit page id', () => {
    expect(u[0]).toMatchObject({ unitModel: 'A51', price: 1_964_000, status: 'available', bedrooms: 3, bathrooms: 3, sourceId: '425821' });
  });
  it('a reserved card without a price is still read — price stays empty', () => {
    expect(u[1]).toMatchObject({ unitModel: 'A49', price: null, status: 'reserved' });
  });
  it('«متاح للزيارة» is a visit tag, not a status and not part of the code', () => {
    expect(u[2]).toMatchObject({ unitModel: '3/1', status: 'reserved', price: 1_672_000 });
    expect(u[3]).toMatchObject({ unitModel: '2/3', status: 'sold' });
  });
  it('never stores the card area — it is gross (terrace included)', () => {
    expect(u.every((x) => x.area == null)).toBe(true);
  });
  it('listing id from the update-list URL', () => {
    expect(menacoListingId('https://menaco.sa/listings/276031')).toBe('276031');
    expect(menacoListingId('https://riva.sa/x')).toBeNull();
  });
});

describe('Menaco unit page', () => {
  it('net area, floor, type and plan from the head (real description, 2026-10-05)', () => {
    const page = '<meta name="description" content="&amp;nbsp;شقة أنيقة تقع في السطح (Roof Floor) بمساحة إجمالية تبلغ 125.94 م²، بتوزيع عصري">' +
      '<meta property="og:image" content="https://menaco.sa/listings/6228/01K67XV57EPV525P3VQ0ANV56B.png">';
    expect(parseMenacoSub(page)).toEqual({
      area: 125.94, floor: 'الروف', unitType: 'شقة', planUrl: 'https://menaco.sa/listings/6228/01K67XV57EPV525P3VQ0ANV56B.png',
    });
  });
  it('a ground-floor unit', () => {
    const page = '<meta name="description" content="شقة تقع في الدور الأرضي بمساحة إجمالية تبلغ 100 م²">';
    expect(parseMenacoSub(page)).toMatchObject({ area: 100, floor: 'ارضي', unitType: 'شقة', planUrl: null });
  });
});
