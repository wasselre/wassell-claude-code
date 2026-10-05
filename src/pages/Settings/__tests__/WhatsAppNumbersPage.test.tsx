import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { HaberchatDevice, WhatsAppNumber } from '@/types';

/**
 * One number = one card (2026-10-05). The page used to draw every active WAHA
 * number twice — a connection card AND a settings row — plus the main line's
 * retired `wassel_main` session as a fourth "disconnected" number: 7 cards for
 * 3 lines. Fixture = the live `whatsapp_numbers` rows on 2026-10-05.
 */
const overlay: WhatsAppNumber[] = [
  { device_id: 'wassel_main', phone: '+966556546238', friendly_name_ar: 'وصل العقارية', friendly_name_en: 'Wassel Real Estate', is_default: false, is_operations: false, is_active: false, provider: 'waha', session_name: 'wassel_main', created_at: '2026-07-19T05:55:05Z', updated_at: '2026-07-26T04:39:27Z' },
  { device_id: 'wassel_ops', phone: '+966554620315', friendly_name_ar: 'وصل — العمليات', friendly_name_en: 'Wassel Ops', is_default: false, is_operations: true, is_active: true, provider: 'waha', session_name: 'wassel_ops', created_at: '2026-07-23T14:44:02Z', updated_at: '2026-10-04T06:53:36Z' },
  { device_id: 'sales', phone: '+966556546238', friendly_name_ar: 'وصل العقارية', friendly_name_en: 'Wassel Real Estate', is_default: true, is_operations: false, is_active: true, provider: 'waha', session_name: 'sales', created_at: '2026-07-26T04:39:27Z', updated_at: '2026-07-29T10:01:40Z' },
  { device_id: 'bridge', phone: '+966533716189', friendly_name_ar: 'طلبات العملاء', friendly_name_en: 'Client requests', is_default: false, is_operations: false, is_active: true, provider: 'waha', session_name: 'bridge', created_at: '2026-07-27T09:25:56Z', updated_at: '2026-10-04T07:16:50Z' },
];
const live: HaberchatDevice[] = [
  { id: 'sales', phone: '+966556546238', name: null, status: 'working' },
  { id: 'bridge', phone: '+966533716189', name: null, status: 'working' },
  { id: 'wassel_ops', phone: '+966554620315', name: null, status: 'working' },
];

const state = {
  language: 'ar',
  waDevices: overlay,
  waDevicesLive: live,
  loadWhatsAppNumbers: vi.fn(async () => undefined),
  saveWhatsAppNumber: vi.fn(async () => undefined),
  addToast: vi.fn(),
};
vi.mock('@/stores/appStore', () => {
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state);
  useAppStore.getState = () => state;
  return { useAppStore };
});
vi.mock('@/lib/waha/client', () => ({
  getWahaSessionState: vi.fn(), restartWahaSession: vi.fn(), getWahaQrBlob: vi.fn(),
}));

const { default: WhatsAppNumbersPage } = await import('../WhatsAppNumbersPage');

const html = renderToStaticMarkup(
  <MemoryRouter>
    <WhatsAppNumbersPage />
  </MemoryRouter>,
);
const count = (needle: string): number => html.split(needle).length - 1;

describe('WhatsApp numbers page', () => {
  it('draws each active number once, as its connection card with its controls inside', () => {
    expect(count('إعادة الإقران (QR)')).toBe(3);   // one live-session card per number
    expect(count('تعديل الاسم')).toBe(3);          // controls live inside those cards
    expect(count('اتصال واتساب —')).toBe(0);       // no separate status cards left
  });

  it('folds the retired main-line session away instead of listing it as a 4th number', () => {
    expect(html).toContain('أرقام مخفية (1)');
    expect(count('+966556546238')).toBe(1);
  });

  it('keeps the default and operations badges', () => {
    expect(html).toContain('افتراضي');
    expect(html).toContain('إلغاء العمليات');
  });
});
