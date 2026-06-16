/* eslint-disable */
// AUTO-GENERATED — do not hand-edit.
// Regenerate with:  node scripts/gen-arabic-enums.mjs
//
// Source of truth: the live `clients` model's `client_stage` / `client_status`
// dropdown option `value`s on wassell-prod. These Arabic strings are the
// canonical stage/status values the workflow engine and sales-process config
// write to client records. This file mirrors them as typed unions so config
// references are checked at build time; `assertSalesProcessEnums()` re-checks at
// runtime against the actually-loaded model (the belt-and-suspenders for
// correction #7 — a Builder edit that adds/removes an option is caught loudly).
//
// Reflects live state after the Phase-1 sales-OS option additions.

export const CLIENT_STAGE_VALUES = [
  'جديد',                  // New
  'غير مؤهل',              // Not Qualified
  'الاتصال لحجز موعد',     // Call to Book
  'موعد زيارة',            // Visit Appointment
  'زيارة',                 // Visit
  'متابعة بعد الزيارة',    // Post-Visit Follow-up
  'عرض سعر',               // Quotation
  'حجز',                   // Booking
  'تمويل',                 // Financing
  'الإفراغ',               // Title Transfer
  'خاسر',                  // Lost            (added — sales OS)
  'مغلق ناجح',             // Closed Won      (added — sales OS)
] as const;

export type ClientStageValue = (typeof CLIENT_STAGE_VALUES)[number];

export const CLIENT_STATUS_VALUES = [
  'لا يوجد رد',             // No Answer
  'الوقت غير مناسب',        // Inconvenient Time
  'مهتم',                  // Interested
  'مهتم جدًا',             // Very Interested
  'غير مهتم',              // Not Interested
  'غير مؤهل',              // Not Qualified
  'تم حجز موعد',           // Appointment Booked
  'لا يوجد رد 10 مرات',    // No Answer x10
  'تم تأكيد الحضور',        // Attendance Confirmed
  'تم إلغاء الموعد',        // Appointment Cancelled
  'تمت إعادة الجدولة',     // Rescheduled
  'لم يحضر الموعد',         // No-show
  'تم طلب عرض سعر',        // Quote Requested
  'تم إرسال عرض السعر',    // Quote Sent
  'تم توقيع عرض السعر',    // Quote Signed
  'تم استلام شيك الحجز',   // Booking Cheque Received
  'تم إرسال نموذج الحجز',  // Booking Form Sent
  'تم توقيع نموذج الحجز',  // Booking Form Signed
  'تم الحجز',              // Booked
  'البنك',                 // Bank
  'التقييم',               // Appraisal
  'تم إصدار نموذج الإفراغ', // Title Form Issued
  'تم الإفراغ',            // Title Transferred
  'رقم خاطئ',              // Invalid Number          (added — sales OS)
  'مكرر',                  // Duplicate               (added — sales OS)
  'تم رفض العرض',          // Offer Rejected          (added — sales OS)
  'يحتاج معلومات تمويل',   // Needs Financing Info    (added — sales OS)
  'نقاش عائلي',            // Family Discussion       (added — sales OS)
  'بانتظار القرار',        // Waiting Decision        (added — sales OS)
  'تم إرسال واتساب',       // WhatsApp Sent           (added — sales OS)
  'إعادة تواصل لاحقًا',    // Recontact Later         (added — sales OS)
  'بارد',                  // Cold                    (added — sales OS)
  'بانتظار دفعة الحجز',    // Waiting Reservation Payment (added — sales OS)
] as const;

export type ClientStatusValue = (typeof CLIENT_STATUS_VALUES)[number];
