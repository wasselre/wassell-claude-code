import { describe, it, expect } from 'vitest';
import { parseFields, prefillField, withPhonePrefix, phoneCountryProblem } from '../leadPortals';
import { isTransientPortalFailure, interestRetry } from '../portalInterest';
import { localPhone } from '../officerNoticeDraft';
import { registrationNoticeBody, officerDeliverAt } from '../officerRegistrationNotice';

const user = { email: '', name: '', phone: '' };

describe('withPhonePrefix — "if there is no prefix, add the prefix" (operator, 2026-10-07)', () => {
  it('gives a bare Saudi mobile +966', () => {
    expect(withPhonePrefix('558992913')).toBe('+966558992913');
    expect(withPhonePrefix('0558992913')).toBe('+966558992913');
    expect(withPhonePrefix(' 055 899 2913 ')).toBe('+966558992913');
  });
  it('keeps a number that already has its code', () => {
    expect(withPhonePrefix('+966558992913')).toBe('+966558992913');
    expect(withPhonePrefix('+201558374740')).toBe('+201558374740');
    expect(withPhonePrefix('00971501234567')).toBe('+971501234567');
    expect(withPhonePrefix('96598881178')).toBe('+96598881178');
  });
  it('leaves empty and unrecognisable values alone', () => {
    expect(withPhonePrefix('')).toBe('');
    expect(withPhonePrefix('12345')).toBe('12345');
  });
});

describe('phone_country — a portal that only takes one country (Al Ramz: +966)', () => {
  const { fields } = parseFields(JSON.stringify([
    { key: 'name', source: 'client.client_name' },
    { key: 'phone', type: 'phone', source: 'client.phone_number', phone_country: '+966' },
  ]));
  const phone = fields.find((f) => f.key === 'phone')!;

  it('is parsed as digits', () => {
    expect(phone.phone_country).toBe('966');
  });
  it('prefill adds the prefix to a bare number', () => {
    expect(prefillField(phone, { client: { phone_number: '558992913' }, project: {}, user })).toBe('+966558992913');
  });
  it('lets Saudi numbers through, with or without a stored prefix', () => {
    expect(phoneCountryProblem(fields, { phone: '558992913' }, 'الرمز')).toBeNull();
    expect(phoneCountryProblem(fields, { phone: '+966558992913' }, 'الرمز')).toBeNull();
    expect(phoneCountryProblem(fields, { phone: '0558992913' }, 'الرمز')).toBeNull();
  });
  it('refuses a real foreign number, before any run, with a non-retryable message', () => {
    const p = phoneCountryProblem(fields, { phone: '+201558374740' }, 'الرمز');
    expect(p).not.toBeNull();
    expect(p!.ar.startsWith('لم يُسجَّل')).toBe(true);
    expect(p!.en).toContain('+201558374740');
    expect(isTransientPortalFailure(`${p!.ar}\n${p!.en}`)).toBe(false);
  });
  it('checks nothing on a portal without phone_country', () => {
    const plain = parseFields(JSON.stringify([{ key: 'phone', type: 'phone', source: 'client.phone_number' }])).fields;
    expect(phoneCountryProblem(plain, { phone: '+201558374740' }, 'ريفا')).toBeNull();
  });
});

describe('isTransientPortalFailure — nothing after the submit is retried', () => {
  const timeout = 'Step 31 (wait_for (#client-name)) failed: locator.waitFor: Timeout 30000ms exceeded.';
  it('still retries a timeout before the submit', () => {
    expect(isTransientPortalFailure(timeout, 'step')).toBe(true);
    expect(isTransientPortalFailure(timeout)).toBe(true);
  });
  it('never retries a timeout once the run reached the submit', () => {
    expect(isTransientPortalFailure(timeout, 'committing')).toBe(false);
  });
  it('interestRetry counts a committing failure as used', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const job = { id: 'a', status: 'failed', interest_id: 'i', error_message: timeout, finished_at: '2026-10-07T10:00:00Z' };
    expect(interestRetry([{ ...job, phase: 'step' }], now)).toBe('go');
    expect(interestRetry([{ ...job, phase: 'committing' }], now)).toBe('used');
  });
});

describe('the officer message on registration', () => {
  it('is a fixed template with the client and project', () => {
    const body = registrationNoticeBody({
      projectName: 'ربوة الرمز', why: { reason: null, actions: [] }, clientName: 'محمد', clientPhone: localPhone('558992913'),
    });
    expect(body).toBe([
      'السلام عليكم،',
      'سجّلنا عميل جديد عندكم في البوابة، مهتم بمشروع «ربوة الرمز».',
      'العميل: محمد — رقمه: 0558992913',
      'نتمنى تتواصلون معه، ويعطيك العافية.',
    ].join('\n'));
  });
  it('adds the facts when there are some', () => {
    const body = registrationNoticeBody({
      projectName: 'X', why: { reason: 'سأل عن الأسعار', actions: ['فتح صفحة المشروع مرتين'] }, clientName: '', clientPhone: '',
    });
    expect(body).toContain('سبب الاهتمام: سأل عن الأسعار.');
    expect(body).toContain('ما قام به العميل: فتح صفحة المشروع مرتين.');
    expect(body).toContain('العميل: —');
  });
  it('is delivered inside 09:00–21:00 Riyadh', () => {
    // 10:00 Riyadh → now
    expect(officerDeliverAt(new Date('2026-10-07T07:00:00Z'))).toBe('2026-10-07T07:00:00.000Z');
    // 03:35 Riyadh → 09:00 the same day
    expect(officerDeliverAt(new Date('2026-10-07T00:35:00Z'))).toBe('2026-10-07T06:00:00.000Z');
    // 22:30 Riyadh → 09:00 the next day
    expect(officerDeliverAt(new Date('2026-10-07T19:30:00Z'))).toBe('2026-10-08T06:00:00.000Z');
  });
});
