import { describe, it, expect } from 'vitest';
import {
  emptyAnswers, visibleQuestions, validateStep, hasExperience,
  isValidKsaMobile, type Answers,
} from '../form';

const base = (over: Partial<Answers> = {}): Answers => ({ ...emptyAnswers(), ...over });

describe('conditional question logic (Q5)', () => {
  it('hides "experience_results" when the applicant has no experience', () => {
    const a = base({ experience_level: 'none' });
    const ids = visibleQuestions(a).map((q) => q.id);
    expect(ids).not.toContain('experience_results');
    expect(ids).toHaveLength(9);
    expect(hasExperience(a)).toBe(false);
  });

  it('shows "experience_results" for every level implying real experience', () => {
    for (const level of ['less_than_1', '1_to_3', 'more_than_3']) {
      const a = base({ experience_level: level });
      const ids = visibleQuestions(a).map((q) => q.id);
      expect(ids).toContain('experience_results');
      expect(ids).toHaveLength(10);
      expect(hasExperience(a)).toBe(true);
    }
  });

  it('keeps experience_results immediately after experience_level in the visible order', () => {
    const ids = visibleQuestions(base({ experience_level: '1_to_3' })).map((q) => q.id);
    expect(ids.indexOf('experience_results')).toBe(ids.indexOf('experience_level') + 1);
  });
});

describe('Saudi mobile validation', () => {
  it.each([
    '0512345678', '512345678', '+966512345678', '966512345678', '00966512345678',
    '05 12 345 678', '٠٥١٢٣٤٥٦٧٨',
  ])('accepts %s', (v) => expect(isValidKsaMobile(v)).toBe(true));

  it.each([
    '0412345678', '12345678', '05123', '+11234567890', '0512345', '',
  ])('rejects %s', (v) => expect(isValidKsaMobile(v)).toBe(false));
});

describe('per-step validation', () => {
  it('requires a full name', () => {
    expect(validateStep('full_name', base({ full_name: '' }))).not.toBeNull();
    expect(validateStep('full_name', base({ full_name: 'محمد العتيبي' }))).toBeNull();
  });

  it('requires both salary and commission', () => {
    expect(validateStep('salary_commission', base({ expected_salary: '', expected_commission: '2%' }))).not.toBeNull();
    expect(validateStep('salary_commission', base({ expected_salary: '6000', expected_commission: '' }))).not.toBeNull();
    expect(validateStep('salary_commission', base({ expected_salary: '6000', expected_commission: '2%' }))).toBeNull();
  });

  it('requires the CV path and the audio path', () => {
    expect(validateStep('cv', base({ cv_path: '' }))).not.toBeNull();
    expect(validateStep('cv', base({ cv_path: 'cv/x/y.pdf' }))).toBeNull();
    expect(validateStep('audio', base({ audio_path: '' }))).not.toBeNull();
  });

  it('rejects audio shorter than one minute and longer than three', () => {
    expect(validateStep('audio', base({ audio_path: 'audio/x/y.webm', audio_duration_sec: 30 }))).not.toBeNull();
    expect(validateStep('audio', base({ audio_path: 'audio/x/y.webm', audio_duration_sec: 90 }))).toBeNull();
    expect(validateStep('audio', base({ audio_path: 'audio/x/y.webm', audio_duration_sec: 300 }))).not.toBeNull();
  });

  it('treats additional_notes as optional', () => {
    expect(validateStep('additional_notes', base({ additional_notes: '' }))).toBeNull();
  });
});
