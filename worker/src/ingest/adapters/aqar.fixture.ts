// Synthetic Aqar detail page — structurally identical to a real sa.aqar.fm
// listing's JSON-LD (captured 2026-08-17) but with invented ids/address/coords
// so no real advertiser's listing is committed. Used by aqar.test.ts.
//
// Includes: Organization + WebSite noise blocks, the RealEstateListing/Product
// block with a full offers.itemOffered (price, beds, baths, rooms, floorSize,
// amenityFeature, address, geo), a VideoObject, a deliberately UNMAPPED field
// (`leaseLength`) to exercise schema-gap detection, and a malformed JSON-LD
// block to prove the parser is resilient.
import type { AqarPageInput } from './aqar.js';

const CANONICAL_PATH =
  '/' + ['شقق-للبيع', 'الرياض', 'شمال-الرياض', 'حي-النزهة', 'شارع-تجريبي-9999001']
    .map(encodeURIComponent).join('/');

const LD = [
  { '@context': 'https://schema.org', '@type': 'Organization', name: 'تطبيق عقار', url: 'https://sa.aqar.fm' },
  { '@context': 'https://schema.org', '@type': 'WebSite', name: 'تطبيق عقار', url: 'https://sa.aqar.fm', inLanguage: 'ar' },
  {
    '@context': 'https://schema.org', '@type': ['RealEstateListing', 'Product'],
    '@id': 'https://sa.aqar.fm/ad/9999001', url: `https://sa.aqar.fm${CANONICAL_PATH}`,
    name: 'شقة للبيع في حي النزهة، مدينة الرياض', inLanguage: 'ar',
    description: 'شقة تجريبية في حي النزهة\nمساحة 80م\nغرفتين نوم',
    image: [
      'https://images.aqar.fm/webp/750x0/props/000000001_1700000000001.jpg',
      'https://images.aqar.fm/webp/750x0/props/000000002_1700000000002.jpg',
    ],
    datePosted: '2026-08-17T12:00:00.000Z',
    offers: {
      '@type': 'Offer', price: 990000, priceCurrency: 'SAR',
      businessFunction: 'http://purl.org/goodrelations/v1#Sell', availability: 'https://schema.org/InStock',
      itemOffered: {
        '@type': 'Accommodation', name: 'شقة للبيع في حي النزهة', url: `https://sa.aqar.fm${CANONICAL_PATH}`,
        numberOfBedrooms: 2, numberOfBathroomsTotal: 2, numberOfRooms: 3,
        floorSize: { '@type': 'QuantitativeValue', value: 80, unitCode: 'MTK', unitText: 'م²' },
        amenityFeature: [
          { '@type': 'LocationFeatureSpecification', name: 'مدخل سيارة', value: true },
          { '@type': 'LocationFeatureSpecification', name: 'موقف خاص', value: true },
          { '@type': 'LocationFeatureSpecification', name: 'قبو غير متوفر', value: false },
        ],
        address: { '@type': 'PostalAddress', addressCountry: 'SA', addressLocality: 'حي النزهة', streetAddress: 'شارع تجريبي، حي النزهة، مدينة الرياض' },
        geo: { '@type': 'GeoCoordinates', latitude: 24.760451, longitude: 46.707711 },
        leaseLength: 'P1Y', // <-- UNMAPPED field: must surface as a schema gap
      },
    },
  },
  {
    '@context': 'https://schema.org', '@type': 'VideoObject', name: 'شقة للبيع في حي النزهة',
    thumbnailUrl: ['https://cdn.aqar.fm/thumbnails/000000001_1700000000003.jpg'], uploadDate: '2026-08-17T12:05:00.000Z',
    inLanguage: 'ar', contentUrl: 'https://customer-example.cloudflarestream.com/abc/manifest/video.m3u8',
  },
];

export const sampleAqarPage: AqarPageInput = {
  external_id: '9999001',
  url: `https://sa.aqar.fm${CANONICAL_PATH}`,
  http_status: 200,
  fetched_at: '2026-08-17T12:10:00.000Z',
  html:
    '<!doctype html><html lang="ar" dir="rtl"><head>' +
    LD.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('') +
    '<script type="application/ld+json">{ this is not valid json }</script>' + // resilience probe
    '</head><body><main>...</main></body></html>',
};
