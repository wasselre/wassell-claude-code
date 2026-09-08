/**
 * Branded A4 job-offer letter for a careers applicant, built client-side with
 * the same rasterize→A4 recipe as the units PDFs (`@/lib/projects/unitsPdf`).
 *
 * This is the CANDIDATE-FACING document: it carries the offered salary, the
 * commission, and (optionally) the free-text details/bonuses. It deliberately
 * does NOT include the internal cost projection shown in the admin drawer.
 */
import { rasterizeToPdf } from '@/lib/projects/unitsPdf';

const BRAND = {
  chocolate: '#4A2C2A',
  copper: '#B8734F',
  sand: '#D4B896',
  cream: '#F5EDE0',
  charcoal: '#4A4E54',
};

export interface OfferLetterInput {
  candidateName: string;
  candidatePhone: string;
  /** Base monthly salary in SAR. */
  salary: number | null;
  /** Rep's commission share, in percent (e.g. 12 = 12 %). */
  commissionPct: number | null;
  /** Free-text terms / bonuses. Rendered only when `includeDetails` is true. */
  details: string | null;
  includeDetails: boolean;
  isAr: boolean;
}

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Multi-line free text → escaped paragraphs (blank lines preserved as spacing). */
function paragraphs(s: string): string {
  return s
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `<p style="margin:0 0 6px">${esc(line)}</p>` : '<div style="height:6px"></div>'))
    .join('');
}

const money = (n: number | null, isAr: boolean) =>
  n == null || !Number.isFinite(n) ? null : `${Math.round(n).toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`;

const pct = (n: number | null, isAr: boolean) =>
  n == null || !Number.isFinite(n) ? null : `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US', { maximumFractionDigits: 2 })}${isAr ? '٪' : '%'}`;

function factRow(label: string, value: string | null, isAr: boolean): string {
  return `<div style="display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid ${BRAND.sand}66">
    <span style="color:${BRAND.charcoal}99">${esc(label)}</span>
    <span style="font-weight:700;color:${BRAND.chocolate};text-align:${isAr ? 'left' : 'right'}">${esc(value) || '—'}</span>
  </div>`;
}

/** Build the offer letter and return it as a PDF Blob. */
export async function buildOfferLetterPdf(input: OfferLetterInput): Promise<Blob> {
  const { isAr } = input;
  const date = new Date().toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'long' });
  const details = input.includeDetails && input.details?.trim() ? input.details.trim() : null;

  const t = isAr
    ? {
        title: 'عرض عمل',
        subtitle: 'مستشار مبيعات عقارية',
        greeting: `الأستاذ/ة ${input.candidateName} المحترم/ة،`,
        salutation: 'تحية طيبة وبعد،',
        intro: 'يسر شركة وصل العقارية أن تتقدم إليكم بعرض العمل التالي لشغل وظيفة مستشار مبيعات عقارية، وذلك بعد اطلاعنا على طلبكم ومقابلتكم:',
        role: 'المسمى الوظيفي',
        roleValue: 'مستشار مبيعات عقارية',
        salary: 'الراتب الأساسي الشهري',
        commission: 'العمولة',
        commissionValue: (p: string) => `${p} من عمولة الشركة عن كل عملية بيع`,
        location: 'مقر العمل',
        locationValue: 'الرياض — دوام حضوري، 6 أيام أسبوعيًا',
        detailsTitle: 'التفاصيل والمكافآت',
        closing: 'نأمل أن يحظى هذا العرض بقبولكم، ونتطلع إلى انضمامكم إلى فريق وصل العقارية.',
        regards: 'وتقبلوا فائق الاحترام،',
        company: 'وصل العقارية',
        signCompany: 'عن الشركة — التوقيع',
        signCandidate: 'المرشح — التوقيع والتاريخ',
        phone: 'الجوال',
        dateLabel: 'التاريخ',
      }
    : {
        title: 'Job Offer',
        subtitle: 'Real-estate sales consultant',
        greeting: `Dear ${input.candidateName},`,
        salutation: '',
        intro: 'Wassel Real Estate is pleased to offer you the position of Real-estate Sales Consultant, following the review of your application and interview:',
        role: 'Position',
        roleValue: 'Real-estate sales consultant',
        salary: 'Base monthly salary',
        commission: 'Commission',
        commissionValue: (p: string) => `${p} of the company's commission on each sale`,
        location: 'Work location',
        locationValue: 'Riyadh — on-site, 6 days a week',
        detailsTitle: 'Details & bonuses',
        closing: 'We hope this offer meets your expectations and look forward to welcoming you to the Wassel team.',
        regards: 'Kind regards,',
        company: 'Wassel Real Estate',
        signCompany: 'For the company — signature',
        signCandidate: 'Candidate — signature & date',
        phone: 'Mobile',
        dateLabel: 'Date',
      };

  const commissionStr = pct(input.commissionPct, isAr);

  const html = `
  <!-- min-height is deliberately a few px UNDER A4 at 794px width (1123px): the
       canvas→mm rounding otherwise spills a blank second page. -->
  <div dir="${isAr ? 'rtl' : 'ltr'}" style="width:794px;min-height:1110px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal};display:flex;flex-direction:column">
    <div style="background:${BRAND.chocolate};color:#fff;padding:22px 36px;display:flex;justify-content:space-between;align-items:center">
      <img src="/assets/logo-horizontal-white.png" alt="" style="height:54px;width:auto;display:block" />
      <div style="text-align:${isAr ? 'left' : 'right'}">
        <div style="font-size:22px;font-weight:700">${t.title}</div>
        <div style="font-size:12px;opacity:.85;margin-top:2px">${t.subtitle}</div>
        <div style="font-size:11px;opacity:.7;margin-top:4px">${t.dateLabel}: ${esc(date)}</div>
      </div>
    </div>

    <div style="padding:34px 40px 28px;flex:1;font-size:14px;line-height:1.8">
      <div style="font-size:17px;font-weight:700;color:${BRAND.chocolate}">${esc(t.greeting)}</div>
      <div style="font-size:12px;color:${BRAND.charcoal}99;margin-top:2px" dir="ltr">${esc(input.candidatePhone)}</div>
      ${t.salutation ? `<p style="margin:14px 0 0">${t.salutation}</p>` : ''}
      <p style="margin:10px 0 18px">${t.intro}</p>

      <div style="border-top:2px solid ${BRAND.copper};padding-top:4px;margin-bottom:18px">
        ${factRow(t.role, t.roleValue, isAr)}
        ${factRow(t.salary, money(input.salary, isAr), isAr)}
        ${factRow(t.commission, commissionStr ? t.commissionValue(commissionStr) : null, isAr)}
        ${factRow(t.location, t.locationValue, isAr)}
      </div>

      ${
        details
          ? `<div style="background:${BRAND.cream}66;border:1px solid ${BRAND.sand}88;border-radius:10px;padding:14px 18px;margin-bottom:18px">
              <div style="font-size:12px;font-weight:700;color:${BRAND.copper};margin-bottom:6px">${t.detailsTitle}</div>
              <div style="font-size:13.5px">${paragraphs(details)}</div>
            </div>`
          : ''
      }

      <p style="margin:8px 0 0">${t.closing}</p>
      <p style="margin:14px 0 0">${t.regards}</p>
      <p style="margin:2px 0 0;font-weight:700;color:${BRAND.chocolate}">${t.company}</p>

      <div style="display:flex;gap:40px;margin-top:56px">
        <div style="flex:1;border-top:1px solid ${BRAND.charcoal}66;padding-top:6px;font-size:11.5px;color:${BRAND.charcoal}99">${t.signCompany}</div>
        <div style="flex:1;border-top:1px solid ${BRAND.charcoal}66;padding-top:6px;font-size:11.5px;color:${BRAND.charcoal}99">${t.signCandidate}</div>
      </div>
    </div>

    <div style="background:${BRAND.cream};color:${BRAND.charcoal}99;font-size:10.5px;padding:10px 40px;display:flex;justify-content:space-between">
      <span>${t.company}</span>
      <span>wassel.re</span>
    </div>
  </div>`;

  return rasterizeToPdf(html, 'portrait');
}

/** Filename with a safe slug of the candidate's name (Arabic is fine in `download=`). */
export function offerPdfFilename(candidateName: string): string {
  const base = candidateName.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-');
  return `wassel-offer-${base || 'candidate'}.pdf`;
}
