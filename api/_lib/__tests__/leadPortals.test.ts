import { describe, it, expect } from 'vitest';
import { parseFields, prefillField } from '../leadPortals';

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
