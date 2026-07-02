import { describe, expect, it } from 'vitest';
import { buildClientPrefChips, isAwaitingReply, isClosedChat, isInterestedClient } from '../prefChips';
import type { AppModel } from '@/types';

// Minimal clients model — just the option-bearing fields the chips resolve.
const clientsModel = {
  id: 'clients-model',
  name: 'clients',
  schema: {
    sections: [
      {
        id: 'sec',
        label_ar: 'أساسي',
        label_en: 'Basic',
        order: 0,
        is_base: true,
        fields: [
          {
            id: 'f1', name: 'preferred_unit_type', label_ar: 'نوع الوحدة', label_en: 'Unit Type',
            type: 'multiselect', required: false, order: 0, section_id: 'sec',
            options: [
              { id: 'o1', label_ar: 'فيلا', label_en: 'Villa', value: 'فيلا' },
              { id: 'o2', label_ar: 'شقة', label_en: 'Apartment', value: 'شقة' },
            ],
          },
          {
            id: 'f2', name: 'preferred_city', label_ar: 'المدينة', label_en: 'City',
            type: 'multiselect', required: false, order: 1, section_id: 'sec',
            options: [{ id: 'o3', label_ar: 'الرياض', label_en: 'Riyadh', value: 'الرياض' }],
          },
          {
            id: 'f3', name: 'preferred_neighborhoods', label_ar: 'الأحياء', label_en: 'Neighborhoods',
            type: 'multiselect', required: false, order: 2, section_id: 'sec',
            options: [{ id: 'o4', label_ar: 'النرجس', label_en: 'An-Narjis', value: 'النرجس' }],
          },
        ],
      },
    ],
    section_selector_field_id: null,
  },
} as unknown as AppModel;

const geoNames = { 'city-1': 'الرياض', 'district-1': 'حي الياسمين' };

describe('buildClientPrefChips', () => {
  it('builds unit-type, area, and location chips (cascade city + district item)', () => {
    const chips = buildClientPrefChips(
      {
        preferred_unit_type: ['فيلا', 'شقة'],
        preferred_area: { min: 200, max: 400 },
        location: { city: ['city-1'] },
        location_items: [
          { id: 'i1', kind: 'district', polarity: 'include', district_id: 'district-1', district_label: 'حي الياسمين' },
        ],
      },
      clientsModel,
      geoNames,
      true,
    );
    expect(chips.map((c) => c.kind)).toEqual(['unit_type', 'unit_type', 'area', 'location']);
    expect(chips[0].text).toBe('فيلا');
    expect(chips[2].text).toBe('200–400 م²');
    expect(chips[3].text).toBe('الرياض · حي الياسمين');
  });

  it('uses English option labels + m² in English', () => {
    const chips = buildClientPrefChips(
      { preferred_unit_type: ['فيلا'], preferred_area: { min: 150 } },
      clientsModel,
      {},
      false,
    );
    expect(chips[0].text).toBe('Villa');
    expect(chips[1].text).toBe('150+ m²');
  });

  it('combines city, district AND element in one chip with a +N overflow', () => {
    const chips = buildClientPrefChips(
      {
        location: { city: ['city-1'] },
        location_items: [
          { id: 'i1', kind: 'district', polarity: 'include', district_id: 'district-1', district_label: 'حي الياسمين' },
          { id: 'i2', kind: 'district', polarity: 'include', district_id: 'd2', district_label: 'حي النرجس' },
          {
            id: 'i3', kind: 'element_rule', polarity: 'include', logic: 'AND',
            conditions: [{ rule: 'within_radius', element_id: 'e1', distance_m: 5000 }],
            element_label: 'كافد',
          },
        ],
      },
      clientsModel,
      geoNames,
      true,
    );
    const loc = chips.find((c) => c.kind === 'location')!;
    expect(loc.text).toBe('الرياض · حي الياسمين · كافد +1');
  });

  it('ignores exclude items and falls back to legacy multiselects', () => {
    const chips = buildClientPrefChips(
      {
        preferred_city: ['الرياض'],
        preferred_neighborhoods: ['النرجس'],
        location_items: [
          { id: 'i1', kind: 'district', polarity: 'exclude', district_id: 'district-1', district_label: 'مستثنى' },
        ],
      },
      clientsModel,
      geoNames,
      false,
    );
    const loc = chips.find((c) => c.kind === 'location')!;
    expect(loc.text).toBe('Riyadh · An-Narjis');
  });

  it('returns no chips when the client has no preferences', () => {
    expect(buildClientPrefChips({}, clientsModel, {}, true)).toEqual([]);
  });
});

describe('isInterestedClient', () => {
  it('matches the interested statuses only', () => {
    expect(isInterestedClient({ client_status: 'مهتم' })).toBe(true);
    expect(isInterestedClient({ client_status: 'مهتم جدًا' })).toBe(true);
    expect(isInterestedClient({ client_status: 'غير مهتم' })).toBe(false);
    expect(isInterestedClient({})).toBe(false);
  });
});

describe('isClosedChat', () => {
  it('resolved and archived are closed; active and unset are open', () => {
    expect(isClosedChat({ status: 'resolved' })).toBe(true);
    expect(isClosedChat({ status: 'archived' })).toBe(true);
    expect(isClosedChat({ status: 'active' })).toBe(false);
    expect(isClosedChat({})).toBe(false);
  });
});

describe('isAwaitingReply', () => {
  it('true when the newest message is inbound', () => {
    expect(isAwaitingReply({ last_message_flow: 'in', unread_count: 0 })).toBe(true);
  });
  it('false when we replied last', () => {
    expect(isAwaitingReply({ last_message_flow: 'out', unread_count: 0 })).toBe(false);
  });
  it('falls back to unread count when the flow is unknown (legacy chats)', () => {
    expect(isAwaitingReply({ unread_count: 2 })).toBe(true);
    expect(isAwaitingReply({ unread_count: 0 })).toBe(false);
  });
});
