/**
 * The "مستشار مبيعات عقارية" application form model: questions, options, the
 * conditional-visibility rule, per-step validation, and localStorage
 * persistence. Kept UI-free so it is trivially unit-testable.
 */

export type QuestionId =
  | 'full_name' | 'phone' | 'current_situation' | 'experience_level'
  | 'experience_results' | 'can_commit' | 'salary_commission' | 'cv' | 'audio'
  | 'additional_notes';

export interface Answers {
  full_name: string;
  phone: string;
  current_situation: string;
  experience_level: string;
  experience_results: string;
  can_commit: string;
  expected_salary: string;
  expected_commission: string;
  additional_notes: string;
  // Uploaded artefacts — the STORAGE PATHS (not the File objects) so an
  // accidental refresh keeps an already-uploaded CV/recording.
  cv_path: string;
  cv_name: string;
  cv_size: number;
  cv_mime: string;
  audio_path: string;
  audio_size: number;
  audio_duration_sec: number;
}

export const emptyAnswers = (): Answers => ({
  full_name: '', phone: '', current_situation: '', experience_level: '',
  experience_results: '', can_commit: '', expected_salary: '', expected_commission: '',
  additional_notes: '',
  cv_path: '', cv_name: '', cv_size: 0, cv_mime: '',
  audio_path: '', audio_size: 0, audio_duration_sec: 0,
});

export interface Choice { value: string; label: string; }

export const SITUATION_OPTIONS: Choice[] = [
  { value: 'full_time', label: 'متفرغ' },
  { value: 'employed', label: 'موظف' },
  { value: 'student', label: 'طالب' },
  { value: 'job_seeker', label: 'باحث عن عمل' },
];

export const EXPERIENCE_OPTIONS: Choice[] = [
  { value: 'none', label: 'لا توجد لدي خبرة' },
  { value: 'less_than_1', label: 'أقل من سنة' },
  { value: '1_to_3', label: 'من سنة إلى 3 سنوات' },
  { value: 'more_than_3', label: 'أكثر من 3 سنوات' },
];

export const YES_NO_OPTIONS: Choice[] = [
  { value: 'yes', label: 'نعم' },
  { value: 'no', label: 'لا' },
];

export interface QuestionDef {
  id: QuestionId;
  title: string;
  hint?: string;
  optional?: boolean;
}

export const QUESTIONS: QuestionDef[] = [
  { id: 'full_name', title: 'ما اسمك الكامل؟' },
  { id: 'phone', title: 'ما رقم جوالك؟', hint: 'مثال: 05XXXXXXXX' },
  { id: 'current_situation', title: 'ما وضعك الحالي؟' },
  { id: 'experience_level', title: 'كم لديك من الخبرة في المبيعات العقارية؟' },
  { id: 'experience_results', title: 'ما النتائج التي حققتها خلال خبرتك السابقة؟' },
  {
    id: 'can_commit',
    title: 'هل يمكنك الالتزام بالعمل الحضوري لمدة 6 أيام أسبوعيًا، وهل موقع المكتب في الرياض حي النزهة مناسب لك ولديك وسيلة نقل؟',
  },
  { id: 'salary_commission', title: 'ما الراتب الأساسي ونسبة العمولة التي تتوقعها؟' },
  { id: 'cv', title: 'أرفق سيرتك الذاتية.', hint: 'يُقبل: PDF أو DOC أو DOCX' },
  {
    id: 'audio',
    title: 'سجّل مقطعًا صوتيًا مدته من دقيقة إلى 3 دقائق، وتحدث فيه عن نفسك وخبرتك.',
    hint: 'يمكنك التسجيل مباشرة أو رفع ملف صوتي.',
  },
  { id: 'additional_notes', title: 'هل هناك أي شيء آخر ترغب في إضافته؟', optional: true },
];

/** Did the applicant claim any real-estate sales experience? Drives Q5. */
export function hasExperience(a: Answers): boolean {
  return a.experience_level === 'less_than_1'
    || a.experience_level === '1_to_3'
    || a.experience_level === 'more_than_3';
}

/** The questions actually shown, after applying the conditional rule (Q5 is
 *  skipped when the applicant has no experience). */
export function visibleQuestions(a: Answers): QuestionDef[] {
  return QUESTIONS.filter((q) => q.id !== 'experience_results' || hasExperience(a));
}

/** Audio duration bounds (seconds). */
export const AUDIO_MIN_SEC = 60;
export const AUDIO_MAX_SEC = 180;

export function isValidKsaMobile(raw: string): boolean {
  const digits = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  let d = digits;
  if (d.startsWith('00966')) d = d.slice(5);
  else if (d.startsWith('966')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d);
}

/**
 * Validate a single step. Returns an Arabic error string, or null when the
 * step's answer is acceptable to advance.
 */
export function validateStep(id: QuestionId, a: Answers): string | null {
  switch (id) {
    case 'full_name':
      return a.full_name.trim().length >= 2 ? null : 'يرجى إدخال اسمك الكامل';
    case 'phone':
      return isValidKsaMobile(a.phone) ? null : 'يرجى إدخال رقم جوال سعودي صحيح';
    case 'current_situation':
      return a.current_situation ? null : 'يرجى اختيار وضعك الحالي';
    case 'experience_level':
      return a.experience_level ? null : 'يرجى اختيار مستوى خبرتك';
    case 'experience_results':
      return a.experience_results.trim().length >= 3 ? null : 'يرجى ذكر النتائج التي حققتها';
    case 'can_commit':
      return a.can_commit ? null : 'يرجى اختيار إجابة';
    case 'salary_commission':
      if (!a.expected_salary.trim()) return 'يرجى إدخال الراتب الأساسي المتوقع';
      if (!a.expected_commission.trim()) return 'يرجى إدخال نسبة العمولة المتوقعة';
      return null;
    case 'cv':
      return a.cv_path ? null : 'يرجى إرفاق سيرتك الذاتية';
    case 'audio':
      if (!a.audio_path) return 'يرجى تسجيل أو رفع مقطع صوتي';
      if (a.audio_duration_sec && a.audio_duration_sec < AUDIO_MIN_SEC) return 'المقطع الصوتي قصير جدًا (الحد الأدنى دقيقة واحدة)';
      if (a.audio_duration_sec && a.audio_duration_sec > AUDIO_MAX_SEC + 5) return 'المقطع الصوتي طويل جدًا (الحد الأقصى ثلاث دقائق)';
      return null;
    case 'additional_notes':
      return null; // optional
    default:
      return null;
  }
}

// ── localStorage persistence (survives an accidental refresh) ────────────────

const ANSWERS_KEY = 'wassel_careers_answers_v1';
const SUBMISSION_KEY = 'wassel_careers_submission_id_v1';

export function loadAnswers(): Answers {
  try {
    const raw = localStorage.getItem(ANSWERS_KEY);
    if (raw) return { ...emptyAnswers(), ...(JSON.parse(raw) as Partial<Answers>) };
  } catch {
    // ignore
  }
  return emptyAnswers();
}

export function saveAnswers(a: Answers): void {
  try {
    localStorage.setItem(ANSWERS_KEY, JSON.stringify(a));
  } catch {
    // ignore — private mode / quota
  }
}

export function clearAnswers(): void {
  try {
    localStorage.removeItem(ANSWERS_KEY);
    localStorage.removeItem(SUBMISSION_KEY);
  } catch {
    // ignore
  }
}

/** A stable per-application idempotency key (prevents duplicate submissions on
 *  double-click / refresh). Persisted so a refresh reuses the same id. */
export function getSubmissionId(): string {
  try {
    const existing = localStorage.getItem(SUBMISSION_KEY);
    if (existing) return existing;
  } catch {
    // ignore
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(SUBMISSION_KEY, id);
  } catch {
    // ignore
  }
  return id;
}
