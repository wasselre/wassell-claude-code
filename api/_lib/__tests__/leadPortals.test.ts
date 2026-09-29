import { describe, it, expect } from 'vitest';
import { parseFields, prefillField, pickPortals, type Party } from '../leadPortals';

const user = { email: '', name: '', phone: '' };
const [nameField] = parseFields(
  JSON.stringify([
    { key: 'name', source: 'client.client_name', min_length: 3, fallback_source: 'client.phone_number', hidden: true },
  ]),
).fields;

const prefill = (client: Record<string, unknown>) => prefillField(nameField!, { client, project: {}, user });

describe('lead portal name fallback (Riva needs 3+ characters)', () => {
  it('keeps a real name', () => {
    expect(prefill({ client_name: 'Roya Bana', phone_number: '+966506621382' })).toBe('Roya Bana');
  });

  it('keeps a short name with 3 letters once punctuation is ignored', () => {
    expect(prefill({ client_name: 'B.A.k', phone_number: '+966559449156' })).toBe('B.A.k');
  });

  it('uses the local phone number for a one-letter or placeholder name', () => {
    expect(prefill({ client_name: 'A', phone_number: '+966554121288' })).toBe('0554121288');
    expect(prefill({ client_name: '-', phone_number: '+966562488666' })).toBe('0562488666');
    expect(prefill({ client_name: '', phone_number: '+966505473450' })).toBe('0505473450');
  });

  it('leaves a non-Saudi number as stored', () => {
    expect(prefill({ client_name: 'K', phone_number: '+971501234567' })).toBe('+971501234567');
  });

  it('does nothing when the field declares no minimum', () => {
    const [plain] = parseFields(JSON.stringify([{ key: 'name', source: 'client.client_name' }])).fields;
    expect(prefillField(plain!, { client: { client_name: 'A', phone_number: '+966554121288' }, project: {}, user })).toBe('A');
  });
});

describe('portal choice: developer first', () => {
  const RAMZ = 'dev-ramz';
  const RIVA = 'mkt-riva';
  const ramzPortal = { id: 'p-ramz', projects: [], officers: [], developer: RAMZ, marketers: [] };
  const rivaPortal = { id: 'p-riva', projects: [], officers: [], developer: null, marketers: [RIVA] };
  const project = (developerId: string | null, marketerIds: string[]) => ({ id: 'proj-1', developerId, marketerIds });
  const none = new Map<string, Party>();
  const ids = (r: { id: string }[]) => r.map((x) => x.id).sort();

  it('a developer with its own portal wins: the marketer portal is dropped', () => {
    const r = pickPortals([ramzPortal, rivaPortal], project(RAMZ, [RIVA]), none);
    expect(r).toEqual([{ id: 'p-ramz', coverage: 'developer' }]);
  });
  it('a developer officer counts as a direct relationship even without a developer portal', () => {
    const r = pickPortals([rivaPortal], project('dev-mina', [RIVA]), new Map<string, Party>([['off-mina', 'developer']]));
    expect(r).toEqual([]);
  });
  it('with no direct line to the developer, the marketer portal is used', () => {
    const r = pickPortals([ramzPortal, rivaPortal], project('dev-other', [RIVA]), none);
    expect(r).toEqual([{ id: 'p-riva', coverage: 'marketer' }]);
  });
  it('a marketer officer is not a direct relationship with the developer', () => {
    const r = pickPortals([rivaPortal], project('dev-other', [RIVA]), new Map<string, Party>([['off-riva', 'marketer']]));
    expect(ids(r)).toEqual(['p-riva']);
  });
  it('a portal reached through a marketer-side officer is dropped when the developer is direct', () => {
    const viaRivaOfficer = { id: 'p-riva-off', projects: [], officers: ['off-riva'], developer: null, marketers: [] };
    const officers = new Map<string, Party>([['off-riva', 'marketer'], ['off-ramz', 'developer']]);
    expect(ids(pickPortals([ramzPortal, viaRivaOfficer], project(RAMZ, [RIVA]), officers))).toEqual(['p-ramz']);
  });
  it('a portal that explicitly lists the project is always kept', () => {
    const explicit = { ...rivaPortal, projects: ['proj-1'] };
    expect(ids(pickPortals([ramzPortal, explicit], project(RAMZ, [RIVA]), none))).toEqual(['p-ramz', 'p-riva']);
  });
  it('without a project nothing is covered', () => {
    expect(pickPortals([ramzPortal, rivaPortal], null, none)).toEqual([]);
  });
});
