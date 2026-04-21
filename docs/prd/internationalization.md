# PRD: Internationalization (Arabic / English, RTL/LTR)

**Status:** Live
**Last updated:** 2026-04-18
**Related PRDs:** navigation-layout.md, model-builder.md

## What it is (in plain English)
The entire app works in two languages: Arabic (right-to-left) and English (left-to-right). A toggle in the header switches between them live. Every user-facing label — static UI strings, model names, section names, field names, dropdown options — has both an Arabic and an English version stored side by side. There's also a Translation Settings page where admins can edit the static UI strings themselves.

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
- **Auto-translate** helper fills the opposite-language label when only one is typed (rough machine translation fallback in the Builder).
- **Translation Settings page** (`/settings/translations`) lets an admin edit any key in the i18n dictionary without redeploy.

## User flows
1. **Switch language:** Click language toggle in Header → whole UI flips AR/EN and LTR/RTL instantly.
2. **Edit a static string:** `/settings/translations` → find the key → edit the AR or EN value → save → change reflects in the UI.
3. **Auto-translate assist:** In the Model Builder, type an Arabic field label → English field is auto-filled with a suggestion (editable).

## Data touched
- Reads/writes: `localStorage` (language preference).
- Reads/writes: i18n dictionary (client-side store, synced to Supabase if a `translations` table is provisioned).
- Every model/record label_ar / label_en field.

## Key files
| File | What it does |
|---|---|
| `src/lib/i18n.ts` | i18n setup, translation dictionary, `t()` helper |
| `src/lib/autoTranslate.ts` | Auto-fill AR↔EN labels in the Builder |
| `src/components/layout/Header.tsx` | Language toggle control |
| `src/pages/Settings/TranslationSettingsPage.tsx` | Admin UI for editing translations |
| `src/App.tsx` | Applies `dir` and `lang` on language change |
| `src/index.css` / `tailwind.config.js` | RTL-aware styles, Amiri font setup |
| `src/stores/appStore.ts` | `language`, `setLanguage` |

## Open questions / known limitations
- Auto-translate is a stub — not tied to a real translation API.
- No pluralization rules beyond i18next defaults.
- No RTL-aware date picker localization yet (date fields display Gregorian).
- Mixed-direction text inside a single field isn't fully handled (bidi quirks in some inputs).
