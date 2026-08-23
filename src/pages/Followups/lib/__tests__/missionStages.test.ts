import { describe, it, expect } from 'vitest';
import { missionStages } from '../missionStages';

describe('missionStages', () => {
  it('booking call: Context → Call → Qualify → Outcome', () => {
    expect(missionStages('appointment_booking_call', 'call')).toEqual(['context', 'call', 'qualify', 'confirm']);
  });

  it('WhatsApp follow-up: Context → WhatsApp → Qualify → Outcome', () => {
    expect(missionStages('whatsapp_follow_up', 'whatsapp')).toEqual(['context', 'whatsapp', 'qualify', 'confirm']);
  });

  it('non-qualifying call (e.g. confirmation): Context → Call → Outcome', () => {
    expect(missionStages('appointment_confirmation_call', 'call')).toEqual(['context', 'call', 'confirm']);
    expect(missionStages('offer_follow_up', 'call')).toEqual(['context', 'call', 'confirm']);
  });

  it('after-visit qualifies', () => {
    expect(missionStages('follow_up_call_after_visit', 'call')).toEqual(['context', 'call', 'qualify', 'confirm']);
  });

  it('a manual/undefined channel still uses the Call step', () => {
    expect(missionStages('appointment_booking_call', 'manual')).toEqual(['context', 'call', 'qualify', 'confirm']);
    expect(missionStages(null, undefined)).toEqual(['context', 'call', 'confirm']);
  });
});
