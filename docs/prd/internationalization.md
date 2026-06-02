# PRD: Internationalization (Arabic / English, RTL/LTR)

**Status:** Live
**Last updated:** 2026-06-02
**Related PRDs:** navigation-layout.md, model-builder.md

## What it is (in plain English)
The entire app works in two languages: Arabic (right-to-left) and English (left-to-right). A toggle in the header switches between them live. Every user-facing label — static UI strings, model names, section names, field names, dropdown options — has both an Arabic and an English version stored side by side.

Whenever the user creates anything new in the Builder (model, section, field, option, group, workflow, dashboard, widget), an in-app live translator fills the opposite-language label and a clean snake_case slug **automatically** as the user types — no need to write the Arabic and English versions separately. The translator routes through `/api/translate` to Claude Haiku 4.5 and returns natural Saudi/professional English in ~300-500ms.

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
- **Live auto-translate**: as the user types in the Builder, a debounced (~450ms) call to `/api/translate` fills the opposite-language label AND derives a snake_case Latin slug from the English version. No more `item_<timestamp>` slugs for Arabic input. Wired into model/section/field/option/group creation, plus workflow/dashboard/widget rename. Failures surface as a red toast and block save — never silently fall back to gibberish. `/api/translate` runs on the Vercel **edge** runtime (like the other Anthropic endpoints) so the bursty, open-modal-translate-a-few-close usage pattern doesn't pay a Node cold-start on the first call each session.
- **Bulk "Translate all" (dropdown options editor)**: the options modal shows a `Translate all (N)` button whenever N options still lack their other-language label or a real `api_name`. It translates every blank option **in parallel** (one round-trip's latency, not N staggered debounced calls), only ever filling blanks — never overwriting a label or slug the user typed. Reuses the same in-memory cache as the live translator, so options already filled live this session resolve instantly. Per-option failures are tallied into a single red toast.
- **Translation Settings page** (`/settings/translations`) lets an admin edit any key in the i18n dictionary without redeploy.

## User flows
1. **Switch language:** Click language toggle in Header → whole UI flips AR/EN and LTR/RTL instantly.
2. **Edit a static string:** `/settings/translations` → find the key → edit the AR or EN value → save → change reflects in the UI.
3. **Live auto-translate (Builder):** type a label in your current language → after ~450ms of quiet, the opposite-language label and a clean Latin slug appear as a small helper line under the input. Save is blocked while a translation is in flight or after a translation error — the user retries until it succeeds. The translation can still be manually overridden by typing into the opposite-language input or the API-name input.
4. **Translate a whole dropdown at once:** in the options editor modal, type just the Arabic (or just the English) for several options → click `Translate all (N)` → all blank options fill their other language + `api_name` together in one parallel batch. Faster than waiting for each row's debounced live translation to fire one at a time.

## Data touched
- Reads/writes: `localStorage` (language preference).
- Reads/writes: i18n dictionary (client-side store, synced to Supabase if a `translations` table is provisioned).
- Every model/record label_ar / label_en field.

## Key files
| File | What it does |
|---|---|
| `src/lib/i18n.ts` | i18n setup, translation dictionary, `t()` helper |
| `src/lib/autoTranslate.ts` | `slugify` (Latin-only sync) and `needsTranslation` predicate |
| `src/lib/translateLabel.ts` | Client wrapper around `/api/translate` with in-memory cache |
| `src/hooks/useDebouncedTranslation.ts` | React hook — debounced (~450ms) live translation for input fields |
| `src/pages/Builder/components/OptionsEditor.tsx` | Dropdown options editor modal — per-row live translation + the bulk `Translate all` parallel-batch button |
| `api/translate.ts` | Server endpoint (Claude Haiku 4.5 + force tool-use, **edge** runtime) — returns label_ar + label_en + snake_case slug |
| `src/components/layout/Header.tsx` | Language toggle control |
| `src/pages/Settings/TranslationSettingsPage.tsx` | Admin UI for editing translations |
| `src/App.tsx` | Applies `dir` and `lang` on language change |
| `src/index.css` / `tailwind.config.js` | RTL-aware styles, Amiri font setup |
| `src/stores/appStore.ts` | `language`, `setLanguage` |

## Open questions / known limitations
- Auto-translate runs against Claude Haiku — requires network + a valid `ANTHROPIC_API_KEY` server-side. Offline-only mode means the user has to manually fill both languages on creation.
- Translation calls are not cached across sessions (in-memory only). Re-typing the same label in a new tab triggers a fresh API call.
- Legacy data created before 2026-05-10 may have copy-of-input labels and `item_<timestamp>` slugs. The Translation Settings page surfaces items with `needsTranslation` true — users can clean these up over time.
- User display names (`UsersPage`) are NOT auto-translated — proper-noun transliteration is a user choice, not a machine choice.
- No pluralization rules beyond i18next defaults.
- No RTL-aware date picker localization yet (date fields display Gregorian).
- Mixed-direction text inside a single field isn't fully handled (bidi quirks in some inputs).
