import { describe, it, expect } from 'vitest';
import { isOtherProjectsAsk } from '../basic-reply.js';

// Real Click-to-WhatsApp ad openers from the last 30 days (2026-09-29).
// A lead who asks for OTHER projects has seen the ad's project and passed on it,
// so it must never be sent that project.
describe('isOtherProjectsAsk — ad openers asking for OTHER projects', () => {
  it.each([
    'مهتم بمشاريع سكنية اخرى في شمال الرياض',   // 31 of 218
    'مهتم بمشاريع سكنية اخرى في شرق الرياض',    // 10
    'مهتم بمشاريع سكنية اخرى في وسط الرياض',     // 4
    'مشاريع شرق الرياض',
    'عندكم مشاريع ثانية؟',
    'interested in other projects in north Riyadh',
  ])('routes «%s» to the other-projects path', (t) => {
    expect(isOtherProjectsAsk(t)).toBe(true);
  });

  it.each([
    'مهتم بمشروع أكنان 25',                      // 53 — named project
    'مهتم بمشروع مينا 52',
    'مهتم بمشروع تل الربوة',
    'مهتم بمشروع أكنان 25 في شمال الرياض',        // named + direction = still THIS project
    'كم اسعار الشقق في مشروع الربوه',
    'كم أسعار فلل أكنان',
    'السلام عليكم',
    'Hello',
    'English',
    'فيديو توضيحي فضلا',
    'شقة غرفتين للسكن, كم السعر؟',
    '',
  ])('does NOT treat «%s» as an other-projects ask', (t) => {
    expect(isOtherProjectsAsk(t)).toBe(false);
  });
});
