# PRD: Recruitment Experience (private pre-interview walkthrough)

**Status:** Live (Stage 1 = the intro walkthrough; Stage 2 = the video, which now plays the real bundled recording. Practical task / offer / booking / decline are future work)
**Last updated:** 2026-09-17
**Related PRDs:** [job-applications.md](job-applications.md) (the public application that precedes this), [clients.md](clients.md), [projects-units.md](projects-units.md), [chats.md](chats.md), [followups-workspace.md](followups-workspace.md), [sales-rep-workspace.md](sales-rep-workspace.md) (the real surfaces this page reproduces)

## What it is (in plain English)
A private, guided pre-interview experience for a single shortlisted sales candidate — sent as a personal invitation link **after** we've reviewed their application. Its purpose is to make sure the first office meeting isn't spent explaining the job from scratch: before booking an interview the candidate learns how the daily work happens inside Wassel, watches a short video, tries a small guided task, reviews the offer, and decides whether they're still interested.

**What's built now is only the first content page** of that flow, in two parts. It **opens with the value story** (the visual anchor of the page): a salesperson isn't limited to one project/city/country — at Wassel they can sell across **100+ current projects (Riyadh + Dubai, expanding to new markets)** — and that's possible because the system manages the knowledge, recommendations, customer history and follow-ups, so nothing has to be memorized. **Then** a calm, fully-Arabic/RTL scrolling **workflow walkthrough** provides the evidence — faithful reproductions of the real Wassel interface showing one customer's journey from first call to next follow-up. A "شاهد طريقة العمل" button hands off to **Stage 2, the video** — a full-screen page that plays the walkthrough recording (~7 min, 1080p, hosted in the public Supabase Storage bucket `hire-assets`, not in the repo) with the progress rail on الفيديو — which in turn leads to the practical-task stage (still a stub).

## Why it exists
Real-estate salespeople normally can only carry one or two projects because of how much information a sale involves. The page reassures a candidate that inside Wassel they don't have to memorize projects, units, prices or plans — the system surfaces the right information at the moment they're talking to a customer — so a strong candidate self-selects in (or out) before we spend an interview slot on them.

## Key behaviors
- **Opens with the "why", before any product screen.** A dedicated value summary leads the page (visually stronger than the workflow steps): the "one project vs 100+" framing + the value sequence مشروع واحد → أكثر من 100 مشروع → فرص عملاء أكثر → فرص بيع أكثر; a "في وصل، أنت لا تعمل على مشروع واحد" band with four figures (+100 مشروع · الرياض ودبي · أسواق جديدة · لا مشروع واحد يحدد فرصك); "كيف تستطيع العمل على كل هذه المشاريع؟" (you don't memorize — the system does); and "ما الذي تحتاج إليه أنت؟" (know how to communicate, understand the need, build trust) with the seven things Wassel then handles. Ends by bridging into the workflow. The three take-aways: one project limits your customers → Wassel gives 100+ across Riyadh & Dubai (expanding) → you can handle that scale because the system manages the knowledge/recommendations/history/follow-ups.
- **Private, public-link, no auth.** Renders outside `AppLayout`, forces `dir=rtl` / `lang=ar` on mount (restores on unmount), and requires no login. A `:token` identifies the invitation; there is **no token validation yet** (out of scope for stage 1) — the page renders for any token, and `/careers/experience` with no token is a testable preview.
- **Invitation progress rail (sticky).** A five-stage indicator pinned to the top — التعريف ← الفيديو ← التجربة ← العرض ← القرار — with التعريف active. Shows the candidate where this page sits in the wider experience.
- **Scale over documentation.** Each of the seven steps shows ONE **enlarged, focused** product screen (a clean titled `Screen` panel — **no app sidebar**, generous padding, larger type) so the detail is readable without zooming. Deliberately reworked away from the first pass, which shrank whole dashboard pages (with a repeated sidebar) and read like a help article.
- **One continuous journey, not seven screenshots.** The steps hang off a single connected copper timeline spine (numbered nodes), with short causal **flow connectors** between them ("حُفظت التفضيلات — يبدأ واصل بالمطابقة" → "اختار الموظف واحة النرجس" → …). One fictional customer (خالد العتيبي) runs throughout, and the captured preferences are echoed as chips in step 2's matching header. Data is fictional but shaped exactly like real records (field slugs, labels, option colors from the live `clients` / `all_projects` / `units` schemas). **No real client PII and no live data** — deliberate for an external link.
- **Visible, causal interactions:** step 2 runs a ~2s "matching 312 projects" search (IntersectionObserver) that resolves to recommendation cards (ours first); step 4's "إرسال رسالة المشروع الجاهزة" animates the fact-checked message + image gallery + the client's reply into the thread; step 5 selects a unit (updates panel + floor plan) and "إرسال المخطط" shows a sent confirmation; step 6's auto-task pops in. Sections fade up on scroll.
- **Real-looking project imagery, never empty placeholders.** `ProjectImage` renders self-contained, layered SVG architectural scenes (sky + sun/moon + massed building with lit windows + palms + ground) in four variants (villa day/dusk, tower, pool), used in the cards, the project hero, the media gallery and the WhatsApp message. Crisp at any size, on-brand, PII-safe. The unit floor plan is a hand-drawn SVG.
- **Reuses the real design system** (copper/sand/charcoal tokens, Amiri, `.card`/`.form-input`/`.badge`, pure `Button`/`Badge`); store-bound screens are transcribed as static markup.
- **The seven steps:** (1) active call + preference form; (2) recommendation cards; (3) project detail (hero + KPIs + tabs); (4) WhatsApp project message send; (5) units table + floor plan + send; (6) auto-created follow-up task; (7) client 360 + AI-style summary.
- **Dominant video hand-off.** The page ends with a large video-thumbnail block (oversized play button) plus a big «شاهد طريقة العمل» button → the (stubbed) video stage.
- **Off-plan always surfaced** («على الخارطة» pill); **no salary/commission anywhere** (that comes later in the flow).

## User flows
1. **Main happy path:** candidate opens their invitation link → reads the opening copy → scrolls the seven product steps → reads the closing statement → taps **شاهد طريقة العمل** → routed to the video stage.
2. **Preview (internal):** open `/careers/experience` (no token) to review the page.
3. **Next stage (stub):** the video route currently renders a clearly-labelled placeholder ("مرحلة الفيديو … قريبًا") with a link back to the walkthrough.

## Data touched
- **None.** Fully static/self-contained by design (public link, no auth, no PII). No tables read or written.

## Key files
| File | What it does |
|---|---|
| `src/pages/Hire/HireExperiencePage.tsx` | Stage 1 page shell: sticky `ProgressRail`, the `OpeningSummary`, the seven steps as one connected journey with `FlowConnector` bridges, closing statement, dominant video CTA, plus `HireStagePlaceholder` (the practical-task **التجربة** stub, progress rail on التجربة) |
| `src/pages/Hire/HireVideoPage.tsx` | Stage 2 — plays the walkthrough video from Supabase Storage (`VIDEO_URL` const → public `hire-assets` bucket), progress rail on الفيديو, back-to-intro + "ابدأ التجربة العملية" (→ task stub) |
| Supabase Storage `hire-assets/system-intro.mp4` | The walkthrough recording (~43 MB, 1080p) — public bucket, served via CDN, kept out of the git repo |
| `src/pages/Hire/OpeningSummary.tsx` | The opening value story: one-project→100+ framing, value `SequenceBand`, the "في وصل" figures band, the "how / what you need" sections and the seven things Wassel handles |
| `src/pages/Hire/hireScenario.ts` | The single continuous fictional-customer scenario (customer, preferences with `image` variants, projects, units, chat, task, summary, `JOURNEY_FILTERS`) shaped like real records |
| `src/pages/Hire/hireUi.tsx` | Shared primitives: `Reveal` (fade-up on scroll), `Screen` (focused panel, no sidebar), `ProgressRail`, `JourneyStep` (timeline spine + node), `FlowConnector`, `ProjectImage` (SVG architectural renders), plus `Kpi`/`Fact`/`Chips`/`Row`/`SourcePill`/`BandBadge`/`OffPlanPill`/`Spec`/`FromCallChip` |
| `src/pages/Hire/steps/Step*.tsx` | The seven reproduced screens (preferences, recommendations, project detail, WhatsApp, units + floor plan, follow-up task, client 360 summary) |
| `src/App.tsx` | Public routes `/careers/experience`, `/careers/experience/:token`, `/careers/experience/:token/video`, `/careers/experience/:token/task` |

## Open questions / known limitations
- **Stages 1–2 exist (intro + video).** The practical task, offer review, interest/decline choice, appointment booking, and decline-reason capture are all future work.
- **The video lives in Supabase Storage** (public `hire-assets` bucket), referenced by a hardcoded public URL in `HireVideoPage.tsx` — not in the git repo. To replace the recording, upload a new `system-intro.mp4` to that bucket (or upload under a new name and update `VIDEO_URL`). The object is served with `cache-control: no-cache` (Supabase default); if bandwidth matters, re-upload with a long `cache-control`.
- **No invitation token backend.** Links aren't validated or tracked yet; anyone with the URL sees the page. A real per-candidate invite (issue token, mark opened, gate stages) is future work.
- **Project/unit media are self-contained SVG renders** (`ProjectImage` architectural scenes + a hand-drawn floor plan), not real photos — no photographic assets are bundled and the public page must stay PII-safe. A later version could serve real, curated, PII-free project photos via the public website's data.
