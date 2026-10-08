# PRD: Tracked Links (per-customer project & unit pages)

**Status:** Live
**Last updated:** 2026-10-08 (single-project «إرسال للعميل» is now one click — `quickSendProject` mints this customer's links (`sent_via='rep'`) and sends with no preview; the old `ProjectWhatsAppFlow` popup was deleted; a failed mint falls back to brochure + top-3 photos with an info toast) | 2026-10-05 (the project-message preview now says the website link is swapped for this customer's tracked links on continue — the swap always happened on accept, but the preview still showed the old wassel.re link and the button read "Next: files", so reps thought it went out as-is. Measured: no rep or AI message has carried the old link since 2026-09-29.) | 2026-09-30
**Related PRDs:** [chats.md](chats.md) (project messages, composer, bubbles), [ai-agent.md](ai-agent.md) / the WhatsApp sales agent (sends through the same path), [record-management.md](record-management.md) (project detail + client options)

## What it is (in plain English)
When we send a customer a project on WhatsApp, we no longer send a gallery, a brochure PDF, videos and a Google Maps link. We send the project card, ONE cover photo, and a few links that belong to THAT customer and THAT message: «📸 الصور», «🎥 الفيديوهات», «📄 البروشور», «🏠 الوحدات المتاحة», «📍 الموقع». Each link opens a light page on `app.wassel.re/v/<token>/<section>` (no login). The location link records the tap and then forwards to Google Maps. Units work the same way: instead of a units-table PDF or a unit-sheet PDF, the customer gets a link to the available-units page or to one unit's own page.

Everything the customer does on those pages is recorded against the message: which photos they opened, how many videos they played and how far, how long they read the brochure and which pages, which units they opened and how long they stayed, whether they tapped the map, and on how many different days they came back. That rolls up into a 0–100 **interest score** per message, and per customer × project.

## Why it exists
We had no idea whether a customer looked at what we sent. A rep sent ten projects and could not tell which one the customer actually studied. Now the rep sees it on the message itself, the client's record lists the projects they cared about, and the project page lists the customers who cared about it — most interested first.

## Key behaviors
- **One interest per customer × project, summed over every kind of link.** A whole-project message, a units-list link and a single-unit link all carry the project, so their activity adds into ONE score for that customer and project (`v_project_interest`). Each link records what it was (`tracked_links.focus` = `project` / `units` / `unit`), and the interest lists show the mix — «أرسلنا: 2 رسالة مشروع · 1 قائمة وحدات · 1 رابط وحدة» — so the rep sees what the total was made of.
- **History with points.** In the interest lists, tapping a row opens its timeline: every link we sent and every action the customer took, oldest first, grouped by day, each with the points it added — e.g. «18:45 فتح الصور وبقي 6 ث +10», «فتح الموقع في الخريطة +10», «فتح الوحدة U-49431 +4» — ending in «مجموع نقاط المشروع 37 / 100». The points come from SQL (`tracked_interest_timeline` replays the events through the one scoring function), so the rows always add up to the score; an action shows «—» when it adds nothing (its part is capped, or it is not scored). One stay on a tab is one line (the open plus the seconds).
- **Client total.** The client's list header shows «مجموع نقاط العميل N» = the sum of that client's project scores. It is a points total, not out of 100.
- **Units go out as links only.** The units window, a unit's panel and the client's Options tab send a tracked link — there is no PDF send option any more (the dialog keeps «تنزيل PDF» for the rep's own use, and the PDF remains the send format only where no link can be made: a unit with no project).
- **All units or only the filtered ones.** When the rep has filters on in the units window, the send dialog ASKS «أي وحدات ترسل؟» — «المفلترة فقط (N)» or «كل الوحدات المتاحة (M)» — with no default; Send stays disabled until one is picked. «المفلترة فقط» mints a link that carries those unit ids (`tracked_links.unit_ids`), and the customer's units page then shows only them (still limited to units available at the moment they open it). Counts are AVAILABLE units, because that is all the page ever shows.
- **One token per sent message.** The same project sent twice (different days) gets two tokens, so each message has its own numbers; the per-project view sums them.
- **Only real opens count.** Events are written by the page's own JavaScript, so WhatsApp's link-preview crawler (which runs no JS) never counts as an open. No IP address or user agent is stored.
- **An "open" is a VISIT, not a page view.** Switching tabs (photos → units), reloading, or coming back from Google Maps stays in the same visit; a new visit starts after 30 minutes idle or in a new browser tab (visit id in `sessionStorage`, per link). Until 2026-09-29 every tab switch counted as an open — one test link showed 13 opens for 3 visits. If the browser blocks storage, each page view counts as its own visit (over-counts rather than breaks).
- **The units page has filters:** type and bedrooms as chips, a budget cap (up to six steps spanning the project's own available prices, rounded to 50k), floor, and sort (cheapest / largest), with a live unit count and «مسح الفلاتر». Each combination the customer settles on (1.5 s after the last tap) is recorded as a `units_filter` event, e.g. `bed=3;max=1500000`, and the chat chip shows the latest one as «يبحث عن: 3 غرف · حتى 1,500,000».
- **What the pages show** is the same customer-safe material a project message may carry: the send-safety filters of the file picker (no designs/posters, no unit plans on the photos page, no tiny icons), **available** prices only (a sold-out project shows no price), the newest brochure, direct video files plus the project's external videos.
- **Sections appear only when there is something behind them** (no «الفيديوهات» link for a project without videos; no «الوحدات المتاحة» when nothing is available).
- **Language:** the page follows the message's language (`?lang=en` for English messages); Arabic pages are RTL.
- **Links expire after 365 days** (the page says the link is no longer available).
- **Degrade, never lie:** if a link can't be minted, the send falls back to the old files package — the server logs it, the browser shows a toast (red in the composer; a blue info toast on the one-click project send, which then sends the brochure + top-3 photos). Nothing goes out half-built silently.
- **Where links are minted (all project sends):**
  - the WhatsApp sales agent / bot (`aiSendProject.ts`, `SEND_TRACKED_LINKS`): card → cover photo (held behind the card) → no gallery;
  - a rep picking a project template in the composer (links replace the website line; images become the cover only);
  - the one-click single-project «إرسال للعميل» (2026-10-08, `quickSendProject`, `sent_via='rep'`) on Project Finder, Suggested Projects and Client Options cards and the chat's project browser: links + cover photo go with no preview; if the link can't be minted the brochure + top-3 photos go instead (blue info toast). Replaces the old `ProjectWhatsAppFlow` popup, which skipped the file picker when the link minted;
  - bulk project send (one link per project, `sent_via='bulk'`, works for a brand-new number too);
  - the broker portal ([broker-portal.md](broker-portal.md), `sent_via='broker'`): the send from our line (same `aiSendProject` path), the broker's «copy project message» and «share unit» (`api/broker-portal-send.ts` — these two have no chat, so they appear in no engagement list yet);
  - the units window / unit drawer / client options («طريقة الإرسال: رابط متتبَّع | PDF» — link is the default; the PDF and Download remain).
- **Interest score (0–100), computed in SQL** (`tracked_interest_score`), each part capped: opened 10 · photos 2 each (≤14) · videos 5 each (≤10) + 10 for one watched to ≥75% · brochure 1 per 6 s (≤10) + 1 per page (≤5) · units 4 each (≤16) + 1 per 20 s (≤5) · map tap 10 · came back on another day 5 each (≤10) · media time 1 per 30 s (≤5).
- **Where the rep sees it:**
  - under every tracked message in the chat: «لم يفتح الروابط بعد», or visits · photos (opened + time on the tab) · videos (played, % and time) · units · what they filtered for · map · score (refreshed every minute while the chat is open);
  - Client → Options tab: «اهتمامه بالمشاريع» (hidden until a tracked message exists);
  - Project page → «اهتمام العملاء» tab. A row opens the conversation.
- A tracked message no longer contains the website link, so the chat's project buttons resolve the project from the token.

## User flows
1. **Rep sends a project:** picks a project template → the box fills with the text + this customer's links, attachment = cover photo → Send. The customer taps «الصور» → the gallery page opens; the rep's bubble shows «فتحها 1 مرة · 5 صور · 🔥 20» within a minute.
1b. **Rep sends a project from a card (one click, 2026-10-08):** «إرسال للعميل» on a Finder / Suggested Projects / Client Options card or in the chat's project browser → the project message goes out with this customer's links + cover photo, no preview; the button turns green «تم الإرسال». Engagement then shows on the bubble exactly as in flow 1.
2. **Rep sends units:** in the units window → «إرسال للعميل» → the dialog defaults to «رابط متتبَّع» → the customer gets «قائمة وحدات X» + one link to the available-units page; each unit they expand is recorded.
3. **Location:** the customer taps «📍 الموقع» → our page records the tap and forwards to Google Maps after a moment (with a button if the redirect is blocked).
4. **Error states:** an unknown/expired token shows «الرابط غير متاح»; a failed page load shows a retry; a failed mint in the composer toasts and keeps the template's files.

## Data touched
- Writes: `tracked_links` (one row per sent message: token, project_id, unit_id, chat_wid, conversation_record_id, client_id, device_id, sent_via, sections, created_by_user_id) — service role only.
- Writes: `tracked_link_events` (link_id, session_id, kind ∈ view/time/photo_open/video_play/video_progress/brochure_page/unit_open/units_filter/map_open, section, item, value) — only through the anonymous `POST /api/tracked-link {action:'track'}`, validated (kinds, sections, time ≤ 120 s per beat, ≤ 40 events per call).
- Reads (anonymous page): the project record, `file_links` → `files` (signed URLs), `project_videos`, available units, districts.
- Reads (app): `v_tracked_link_engagement` (per message) and `v_project_interest` (per customer × project) — both `security_invoker`, RLS on `tracked_links` mirrors `chat_messages`, so a rep sees engagement only for chats they can see.
- Migrations: `2026-09-29_tracked_links.sql`, `2026-09-29_tracked_links_units.sql`, `2026-09-29_tracked_links_filter.sql`, `2026-09-30_tracked_links_focus.sql`, `2026-09-30_tracked_interest_timeline.sql` (the timeline function), `2026-09-30_tracked_links_unit_ids.sql` (`unit_ids` — a units link limited to chosen units) (`focus` + the three per-kind counts on `v_project_interest`) (`units_filter` kind + `last_units_filter` on the engagement view).

## Key files
| File | What it does |
|---|---|
| `api/_lib/trackedLinks.ts` | Mint a link, load the customer-safe media, build the links block |
| `api/tracked-link.ts` | Anonymous page data (`page`, `unit`) + event intake (`track`) |
| `api/tracked-links/create.ts` | Rep-side mint (JWT must see the chat, or the chat doesn't exist yet) |
| `api/_lib/aiSendProject.ts` | Agent/bot project send — card + cover + links |
| `src/lib/trackedLinks/{text,client}.ts` | Replace links in a message; mint + send unit/units links |
| `src/pages/TrackedLink/**` | The public pages (`/v/:token[/:section]`) and the event tracker |
| `src/pages/Chats/components/{Composer,MessageThread,LinkEngagementChip}.tsx` | Template links, bubble chip |
| `src/pages/Chats/components/SendUnitsPdfModal.tsx` | «رابط متتبَّع / PDF» choice for units |
| `src/lib/projects/bulkProjectSend.ts` | Bulk send with one link per project |
| `src/lib/projects/quickSendProject.ts` | One-click single-project send with links (2026-10-08; replaced the deleted `src/pages/Followups/components/ProjectWhatsAppFlow.tsx`) |
| `src/components/interest/InterestTimeline.tsx`, `src/lib/trackedLinks/timeline.ts` | The per-project history with points (folding only — scoring is SQL) |
| `src/components/interest/TrackedInterestList.tsx` | Interest lists (project page tab, client options) |

## Open questions / known limitations
- A message carrying several unit links (client options → several units) shows the chip for the FIRST unit only; the per-project interest view still counts all of them.
- The units link shows ALL available units, not the rep's filtered subset from the units window.
- If the rep changes the recipient inside the new-chat dialog after the link was minted, the link stays attributed to the original number.
- Rich previews: the link preview in WhatsApp is the app's generic one (no project image yet).
- Finance calculator on the unit / units pages — requested, planned for later.
