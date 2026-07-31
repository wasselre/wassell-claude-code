# PRD: Internationalization (Arabic / English, RTL/LTR)

**Status:** Live
**Last updated:** 2026-07-31 (**Bilingual record VALUES + DeepSeek:** free-typed record data — project names, notes, analyses — now displays AI-translated in the opposite language via a `value_translations` overlay cache (`/api/value-translate`, DeepSeek `deepseek-chat` primary / Claude Haiku fallback); `/api/translate` also moved from Qwen to DeepSeek primary (user decision: "we will use DeepSeek"); inline-created dropdown options from the record form now auto-translate — this was the source of every Arabic-in-English dropdown gap) | 2026-07-18 (translate provider Qwen swap, now superseded) | 2026-06-18 (table-field column labels auto-translate)
**Related PRDs:** navigation-layout.md, model-builder.md

## What it is (in plain English)
The entire app works in two languages: Arabic (right-to-left) and English (left-to-right). A toggle in the header switches between them live. Every user-facing label — static UI strings, model names, section names, field names, dropdown options — has both an Arabic and an English version stored side by side.

Whenever the user creates anything new in the Builder (model, section, field, option, group, workflow, dashboard, widget), an in-app live translator fills the opposite-language label and a clean snake_case slug **automatically** as the user types — no need to write the Arabic and English versions separately. The translator routes through `/api/translate` to **DeepSeek (`deepseek-chat`)** (primary since 2026-07-31; the original Claude Haiku path remains as an automatic fallback if DeepSeek fails).

**Record VALUES are bilingual too (2026-07-31):** what users type into text/textarea fields (project names, unit notes, analyses) is stored in whatever language they typed — and displays AI-translated when the UI is in the other language. Nobody ever writes a translation by hand. Names transliterate (`مساكن الأصيل` → "Masaken Al Aseel"); prose translates faithfully. Translations are a **display overlay** cached in the `value_translations` table keyed by sha256 of the source text — `records.data` is never modified, and editing a value automatically invalidates (new text = new cache key). On a cache miss the UI shows the source text, quietly batches the miss to `/api/value-translate`, and re-renders translated when the response lands (typically 2-5s the first time; instant forever after).

There's also a Translation Settings page where admins can edit the static UI strings themselves.

## Why it exists
Wassell is a Saudi Arabian real-estate company. Arabic is the primary language, but English is needed for international partners and for technical users. The product is unusable in either direction without first-class RTL support.

## Key behaviors
- Language state lives in Zustand (`useAppStore().language`), persisted to localStorage.
- On language change, an effect in `App.tsx` sets `document.documentElement.dir` to `rtl` or `ltr` and `document.documentElement.lang` to `ar` or `en`.
- **Static UI strings** go through `react-i18next` via `t('key')`. Translations live in `src/lib/i18n.ts`.
- **Dynamic user labels** (models, sections, fields, options) follow the pattern `isAr ? x.label_ar : x.label_en`. The Model Builder enforces both fields on every save.
- **Typography:** Amiri font (Google Fonts) for both Arabic and English — chosen for readability in both scripts and matching the Wassell brand.
- **Layout inversion:** Tailwind's `rtl:` prefix and CSS logical properties (margin-inline-start etc.) are used so the sidebar, icons, and forms flip correctly.
- **Currency:** SAR (Saudi Riyal, ر.س) — currency inputs/display use this unit and an Arabic-friendly format.
- **PDF generation** supports Arabic RTL text via jsPDF with a custom font setup (see import-export.md).
- **Live auto-translate**: as the user types in the Builder, a debounced (~450ms) call to `/api/translate` fills the opposite-language label AND derives a snake_case Latin slug from the English version. No more `item_<timestamp>` slugs for Arabic input. Wired into model/section/field/option/group creation, the **table-field column editor** (each `table` column's Arabic label fills its English label + `col` slug; AR→EN only, added 2026-06-18), plus workflow/dashboard/widget rename. Failures surface as a red toast and block save — never silently fall back to gibberish. `/api/translate` runs on the Vercel **edge** runtime (like the other AI endpoints) so the bursty, open-modal-translate-a-few-close usage pattern doesn't pay a Node cold-start on the first call each session.
- **Bulk "Translate all" (dropdown options editor)**: the options modal shows a `Translate all (N)` button whenever N options still lack their other-language label or a real `api_name`. It translates every blank option **in parallel** (one round-trip's latency, not N staggered debounced calls), only ever filling blanks — never overwriting a label or slug the user typed. Reuses the same in-memory cache as the live translator, so options already filled live this session resolve instantly. Per-option failures are tallied into a single red toast.
- **Translation Settings page** (`/settings/translations`) lets an admin edit any key in the i18n dictionary without redeploy.
- **Value-translation overlay (2026-07-31):** `resolveDisplayText(raw, lang)` in `src/lib/valueTranslation/runtime.ts` is the ONE resolver for record values. Wired into: `DynamicCell` (text/textarea/notes preview/lookup display — covers table view, card shown-fields, read-only form fields, mirror comparison, dashboard table widget, drill-through), `CardView` title/subtitle formatters, `MapsView.formatFieldValue` (map popups + pills), `LookupCombobox` (picker labels — search matches BOTH the Arabic source and the English transliteration), and `analytics/grouping.ts` (chart group labels fill both language slots). Eligibility rules in `src/lib/valueTranslation/config.ts`: text/textarea/notes fields whose slug doesn't end `_ar`/`_en`; name-like slugs transliterate, the rest translate. Fields that are bilingual by design and models with custom surfaces (chats, market_listings, website copy) are excluded.
- **Inline-created dropdown options auto-translate (2026-07-31):** creating an option from the record form (not the Builder) used to copy the typed Arabic into BOTH label slots — the source of every Arabic-in-English dropdown gap found in the 2026-07-31 audit (31 options across projects/units, all fixed in-DB). `DynamicField.createOptionOnField` now saves instantly with the typed label, then backfills the other language asynchronously via `translateLabel`; a user's manual label edit always wins over the late-arriving translation.
- **Backfill:** `scripts/backfill-value-translations.mjs` (service role) translated all ~8,300 distinct pre-existing Arabic strings via the `value_translation_candidates` RPC. Idempotent — re-run any time; it only ever processes uncached strings.

## User flows
1. **Switch language:** Click language toggle in Header → whole UI flips AR/EN and LTR/RTL instantly.
2. **Edit a static string:** `/settings/translations` → find the key → edit the AR or EN value → save → change reflects in the UI.
3. **Live auto-translate (Builder):** type a label in your current language → after ~450ms of quiet, the opposite-language label and a clean Latin slug appear as a small helper line under the input. Save is blocked while a translation is in flight or after a translation error — the user retries until it succeeds. The translation can still be manually overridden by typing into the opposite-language input or the API-name input.
4. **Translate a whole dropdown at once:** in the options editor modal, type just the Arabic (or just the English) for several options → click `Translate all (N)` → all blank options fill their other language + `api_name` together in one parallel batch. Faster than waiting for each row's debounced live translation to fire one at a time.

## Data touched
- Reads/writes: `localStorage` (language preference).
- Reads/writes: i18n dictionary (client-side store, synced to Supabase if a `translations` table is provisioned).
- Every model/record label_ar / label_en field.
- Reads/writes: `value_translations` table (display-overlay cache of AI-translated record values; SELECT for authenticated, writes via service role only from `/api/value-translate` + the backfill script). Never writes `records.data`.

## Key files
| File | What it does |
|---|---|
| `src/lib/i18n.ts` | i18n setup, translation dictionary, `t()` helper |
| `src/lib/autoTranslate.ts` | `slugify` (Latin-only sync) and `needsTranslation` predicate |
| `src/lib/translateLabel.ts` | Client wrapper around `/api/translate` with in-memory cache |
| `src/hooks/useDebouncedTranslation.ts` | React hook — debounced (~450ms) live translation for input fields |
| `src/pages/Builder/components/OptionsEditor.tsx` | Dropdown options editor modal — per-row live translation + the bulk `Translate all` parallel-batch button |
| `api/translate.ts` | Server endpoint (**edge** runtime) — DeepSeek primary (`api/_lib/deepseek.ts`), Claude Haiku force-tool fallback — returns label_ar + label_en + snake_case slug |
| `api/value-translate.ts` | Batch record-value translation endpoint (**edge**) — checks/fills the `value_translations` cache, DeepSeek primary / Haiku fallback, ≤25 items per call |
| `api/_lib/deepseek.ts` | DeepSeek chat-completions client (`deepseek-chat`), `DEEPSEEK_API_KEY` env |
| `src/lib/valueTranslation/runtime.ts` | `resolveDisplayText` sync resolver + miss queue + cache boot-load + `useValueTranslationVersion` re-render hook |
| `src/lib/valueTranslation/config.ts` | Which fields translate, name-vs-text kind heuristic |
| `src/lib/optionLabels.ts` | Shared dropdown option-label resolution helper (new code uses this; 40+ legacy inline copies migrate opportunistically) |
| `src/hooks/useLang.ts` | `useLang()` / `useIsAr()` — the one way to read UI language in new code |
| `scripts/backfill-value-translations.mjs` | One-shot/resumable backfill of existing Arabic record values |
| `supabase/migrations/2026-07-31_value_translations.sql` | Cache table + RLS + `value_translation_candidates` RPC |
| `src/components/layout/Header.tsx` | Language toggle control |
| `src/pages/Settings/TranslationSettingsPage.tsx` | Admin UI for editing translations |
| `src/App.tsx` | Applies `dir` and `lang` on language change |
| `src/index.css` / `tailwind.config.js` | RTL-aware styles, Amiri font setup |
| `src/stores/appStore.ts` | `language`, `setLanguage` |

## Open questions / known limitations
- Auto-translate runs against DeepSeek (`DEEPSEEK_API_KEY` server-side), falling back to Claude Haiku (`ANTHROPIC_API_KEY`) if DeepSeek fails or the key is unset. Requires network either way — offline-only mode means the user has to manually fill both languages on creation, and record values display in their source language.
- Value-translation coverage is the DynamicCell/CardView/Maps/LookupCombobox/charts surfaces; page-specific adapters that bypass those (Marketing Workspace `/m`, Project Finder, some Sales pages) still render source-language values — they're the next sweep, along with dual-language record search and export-language policy.
- Translation calls are not cached across sessions (in-memory only). Re-typing the same label in a new tab triggers a fresh API call.
- Legacy data created before 2026-05-10 may have copy-of-input labels and `item_<timestamp>` slugs. The Translation Settings page surfaces items with `needsTranslation` true — users can clean these up over time.
- User display names (`UsersPage`) are NOT auto-translated — proper-noun transliteration is a user choice, not a machine choice.
- No pluralization rules beyond i18next defaults.
- No RTL-aware date picker localization yet (date fields display Gregorian).
- Mixed-direction text inside a single field isn't fully handled (bidi quirks in some inputs).
