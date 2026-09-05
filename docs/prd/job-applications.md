# PRD: Job Applications (طلبات التوظيف)

**Status:** Live
**Last updated:** 2026-09-05
**Related PRDs:** [access-control.md](access-control.md) (admin gate), [data-storage.md](data-storage.md) (dedicated table + private bucket), [files.md](files.md) (signed-URL pattern reused)

## What it is (in plain English)
A public, mobile-first, fully-Arabic application page for the **مستشار مبيعات عقارية** role, plus an internal admin screen to review who applied. Candidates arrive from a paid Instagram/Meta ad, land on a premium branded page, and answer questions **one card at a time** (not a long form): name, phone, situation, experience, expected pay, a CV upload, and a 1–3 minute voice recording. They review their answers, consent, and submit. Authorized team members open **Settings → طلبات التوظيف** to search, filter, read each application, securely view the CV + play the recording, and move it through a small status pipeline.

## Why it exists
Wassel runs paid hiring ads and needed a fast, polished intake that (a) feels on-brand and effortless on a phone, (b) captures ad attribution so hiring spend can be measured, and (c) keeps the sensitive files (CV, voice) private while still giving the team a usable review interface. Building it inside the existing app reuses the brand system, auth, storage, and RLS instead of a bolt-on tool.

## Key behaviors
- **Public route, no login, no app layout:** `/careers/sales-consultant`. Forces `dir=rtl` / `lang=ar` regardless of the app's language setting.
- **One question per card** with a `X من N` progress indicator, `التالي` / `السابق` controls, restrained fade animation, and per-step validation before advancing.
- **Conditional Q5:** "ما النتائج التي حققتها…" appears **only** if the applicant selected a real-experience level (`أقل من سنة` / `من سنة إلى 3 سنوات` / `أكثر من 3 سنوات`). Choosing `لا توجد لدي خبرة` skips it and `N` is 9 instead of 10.
- **Answers persist to `localStorage`** (`wassel_careers_answers_v1`) so an accidental refresh resumes ("متابعة التقديم"); already-uploaded files keep their uploaded state. The draft is cleared on successful submit.
- **Duplicate prevention:** a per-application `submission_id` (persisted) makes submit idempotent (double-click / refresh returns the same row). The server also soft-dedupes by canonical phone within 24h.
- **CV upload:** PDF / DOC / DOCX, ≤ 10 MB. Shows filename, upload progress, success, and replace/remove.
- **Voice recording:** record in-browser (mic-permission handling, live timer, pause/resume/stop/re-record, playback, 1-min min / 3-min max with auto-stop) **or** upload an audio file as a fallback when recording is unavailable.
- **Attribution captured** from the landing URL: UTM params + click ids (`fbclid`, `gclid`, `ttclid`, …), persisted so they survive a refresh.
- **Files are private.** Uploads go straight to a **private** `job-applications` bucket via one-shot signed upload URLs; they are never exposed by public URL. The admin screen fetches them through short-lived signed URLs.
- **Server-side validation (never trusts the client):** the submit endpoint re-checks every field, canonicalizes the KSA phone, and sniffs the **real bytes** of the uploaded CV (PDF/DOC/DOCX magic numbers) and audio (webm/ogg/mp3/mp4/wav/aac signatures) plus size — a `.pdf` that is really an executable is rejected. Both public endpoints are IP-rate-limited (salted hash; raw IPs never stored).
- **Internal review is admin-only** (route `RequireAdmin` **and** table RLS `wassell_is_admin`). Search by name/phone, filter by status + experience, open a detail drawer, view/download CV, play audio, see attribution, and set status: `جديد` → `قيد المراجعة` → `للمقابلة` → `مرفوض` / `تم التوظيف`.

## User flows
1. **Apply (happy path):** ad → `/careers/sales-consultant` → intro screen (role, on-site Riyadh/النزهة, 6-day week, fixed salary + commissions + bonuses, 3–5 min estimate) → `ابدأ التقديم` → answer each card → `مراجعة الطلب` → tick consent → `إرسال الطلب` → success screen (`تم استلام طلبك بنجاح`). No promise of a reply to every applicant.
2. **No-experience branch:** at Q4 pick `لا توجد لدي خبرة` → the results question is skipped automatically.
3. **Recording unavailable:** mic denied / unsupported → clear Arabic error + "رفع ملف صوتي" fallback.
4. **Refresh mid-application:** reload → intro shows `متابعة التقديم` → resumes with answers (and uploaded files) intact.
5. **Review (internal):** Settings → طلبات التوظيف → search/filter → open applicant → view CV / play recording / read answers + attribution → change status.
6. **Error/empty states:** per-step validation messages; upload errors; a submit error keeps the review screen; empty admin list shows "لا توجد طلبات مطابقة".

## Data touched
- **Writes:** `public.job_applications` (dedicated table — answers, status, file paths, attribution, debug metadata) via the service-role `api/careers/submit` endpoint. `public.job_application_rate` (rate-limit counters) via `job_application_rate_hit`.
- **Storage:** private `job-applications` bucket — `cv/<submission_id>/…` and `audio/<submission_id>/…` (service-role signed upload/download only; no bucket policies).
- **Reads (internal):** `job_applications` via the admin's JWT under RLS; CV/audio via admin-gated signed URLs.
- Not a Builder model — it never appears in `models` / `records`.

## Key files
| File | What it does |
|---|---|
| `src/pages/Careers/SalesConsultantApplicationPage.tsx` | Public flow orchestrator (intro → cards → review → success) |
| `src/pages/Careers/components/CvUploadField.tsx` | CV upload widget (progress, replace/remove) |
| `src/pages/Careers/components/AudioRecorder.tsx` | Record/upload voice note (timer, pause/stop, playback, min/max) |
| `src/pages/Careers/JobApplicationsPage.tsx` | Internal admin review (list, filters, detail drawer, status) |
| `src/lib/careers/form.ts` | Questions, options, conditional rule, validation, persistence |
| `src/lib/careers/attribution.ts` | UTM + click-id capture |
| `src/lib/careers/client.ts` | Signed-upload + submit API client (XHR progress) |
| `api/careers/upload-url.ts` | Public: mint one-shot signed upload URL (rate-limited) |
| `api/careers/submit.ts` | Public: validate + byte-sniff + dedupe + insert |
| `api/careers/file-url.ts` | Admin: short-lived signed view/download URL |
| `api/_lib/careers.ts` | Shared constants, phone canon, magic-byte sniffers, IP hash |
| `supabase/migrations/2026-09-05_job_applications.sql` | Table + RLS + private bucket + rate-limit fn |

## Open questions / known limitations
- Access is **admin-only**. If HR needs access without full admin, add a `page_access` id + widen the RLS policy (kept simple deliberately).
- Abandoned uploads (form never submitted) leave orphan objects in the bucket keyed by `submission_id` — safe to prune later by "paths with no matching row"; not automated.
- Uploaded-audio duration is best-effort from browser metadata (some containers report unknown); recorded-audio duration is exact from the timer.
- No applicant-facing status tracking or email/WhatsApp auto-reply — intentionally out of scope ("not a large ATS").
