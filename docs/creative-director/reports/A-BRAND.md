# A-BRAND report — Brand kit (Post Creative Director)

*2026-09-02. Agent: A-BRAND. Worktree: `marketing-writing-posts-590cfc`.*

## Files created (all owned by A-BRAND per contracts §12)

| File | What |
|---|---|
| `docs/brand/brand-kit.draft.json` | The `BrandKit` draft: `version:1, status:'draft', mode:'advisory', reviewed_by:null, reviewed_at:null`, 10 palette entries with roles, 50/30/15/5 usage ratio, 5 allowed + 3 avoid combinations, typography, logo rules, character/motifs, image treatment, 8 prohibited entries, `approved_example_ids: []`, 18 provenance sources |
| `docs/brand/brand-kit-notes.md` | Provenance per entry — every item labelled **[documented]** (source quoted) vs **[inferred]** (needs reviewer), the palette conflict, 7 open questions for the reviewer |
| `supabase/migrations/2026-09-02_26_creative_brand_kit_seed.sql` | **WRITTEN, NOT APPLIED.** `INSERT INTO public.mos_settings (key, value) VALUES ('brand_kit', $kit$…$kit$::jsonb) ON CONFLICT (key) DO NOTHING` inside BEGIN/COMMIT. `brand_kit` ONLY — `writer_rules` left to A-DB's `_25` per contracts §2 `_26` |
| `api/_lib/marketing/creative/brandKit.ts` | Master module (see exports below) |
| `worker/src/creative/brandKit.ts` | Verbatim copy, marked. `diff` confirms the ONLY differences are the copy header (8 lines) and the contracts import (`../../../../src/lib/creative/contracts.js` → `./contracts.js`) — same posture as `worker/src/imageGen.ts` |
| `worker/src/creative/__tests__/brandKit.test.ts` | 28 vitest cases incl. draft-JSON shape/canon/ratio guards and a migration⇄draft parity test |
| `docs/creative-director/reports/A-BRAND.md` | This report |

## Exported signatures (`brandKit.ts`, identical in both copies)

```ts
export type BrandKitPaletteEntry = BrandKit['palette'][number];
export type SettingsClient = Pick<SupabaseClient, 'from'>;
export async function loadBrandKit(sb: SettingsClient): Promise<BrandKit | null>;
export function brandKitPromptBlock(kit: BrandKit, language: 'ar' | 'en'): string;
export function normalizeHex(hex: string): string | null;
export function isHexInKit(kit: BrandKit, hex: string): boolean;
export function nearestKitColor(kit: BrandKit, hex: string): BrandKitPaletteEntry | null;
export function paletteRolesFor(kit: BrandKit, opts: { ground: 'light' | 'dark' }): Record<string, string>;
export function validatePaletteAgainstKit(kit: BrandKit, palette: PaletteEntry[]): { deviations: string[]; errors: string[] };
```

Semantics worth knowing:
- `loadBrandKit` returns `null` when the row is missing (quiet — seed may not have run), and `null` + `console.error` on read failure or shape-check failure. Callers treat null as "no kit configured."
- `validatePaletteAgainstKit`: off-kit hex from `project_identity`/`asset` → **deviation** (advisory) / **error** (constraint). A `source:'brand_kit'` entry whose hex is off-kit is **always an error** (false provenance). Messages name the nearest kit colour.
- `paletteRolesFor` never invents a hex — slots whose role no palette entry carries are absent.
- `brandKitPromptBlock` renders the compact block (palette+roles, ratio, typography, logo, character, motifs, image treatment, prohibited, mode statement) in Arabic or English labels.

## Brand truth gathering — what was read

Read in full: `brand/README.md`; the images `الألوان.png` (palette sheet — hex/RGB/CMYK/Pantone + 50/30/15/5 ratio + print/digital combos, matches the README), `الخط.png` (wordmark colourways: copper/chocolate/charcoal/pale), `نمط3.png` (Sadu chevron + rosette band), `نمط 4.png` (opposing triangles + dot columns), `نمط5.png` (stepped-diamond Sadu columns), `نمط6.png` (diamond lattice), `نمط 7.png` (stepped crenellation notch strip), `الأيقونة.png` (monoline fortress mark), `الشعار العرضي.png` (horizontal lockup, chocolate wordmark + copper mark); `.claude/skills/wassel-general-ppt/SKILL.md` + `scripts/wassel_chrome.py`; `.claude/skills/wassel-presentation/SKILL.md` + `references/slide_templates.md`; palette/banned-phrase sections of `.claude/skills/wassel-deck-review/scripts/review.py`; `.claude/skills/client-study/assets/render_study.py` (all 8 colours incl. terracotta `#A6482A`); `src/pages/Marketing/mos.css` 1–60; both Decisions Logs (writing-post, writing-video-script); `tailwind.config.js` + `src/index.css` (retired-palette conflict confirmed).

**Could NOT read:** `C:\Users\rayan\Claude\Wassel Website\index.html` — outside this session's allowed working directories; both the Read tool and shell were refused. The website facts in the kit (dark surfaces `#352013`/`#1A1009`, Najdi arch/Sadu ribbon/crenellation motifs, Tajawal observed-unsanctioned) are recorded **secondhand from the brief** and flagged for reviewer verification in the notes and in the kit's own `sources`/palette notes.

**Palette conflict recorded:** `tailwind.config.js`, `src/index.css`, `CLAUDE.md` still carry the retired palette (`#8E4E3A #D4B896 #4A2C2A #F5EDE0 #4A4E54 #C09B5F`). The kit uses the 2026 canon only; retired values are deliberately absent (guarded by a test). A secondary intra-canon conflict is documented in the notes: `wassel-general-ppt`/`review.py` allow 7 colours (no terracotta) while `render_study.py` uses all 8; kit includes terracotta.

## Tests + typecheck — BLOCKED BY SESSION PERMISSIONS (honest status)

Every interpreter/runner invocation was refused by the permission layer ("This command requires approval" / "contains multiple operations … requires approval"): `npx tsc --noEmit -p tsconfig.api.json`, `cd worker && npm run typecheck`, `cd worker && npx vitest run src/creative/__tests__/brandKit.test.ts`, `node -e …`, `python -c …`, and piped `sed|diff` extractions. There is no operator present to approve, so **none of the mandated commands could be executed.**

What was verified statically instead:
- `diff api/_lib/marketing/creative/brandKit.ts worker/src/creative/brandKit.ts` → only the header + import-path lines differ (output confirmed verbatim-copy posture).
- The migration's embedded JSON was written in the same pass as the draft and visually audited line-by-line; the vitest parity test (`migration parity` describe block) hard-enforces equality whenever tests next run.
- The api file was audited against `tsconfig.json` (`strict`, `noUnusedLocals/Parameters`, `noUncheckedIndexedAccess`): no indexed-access hazards in the module (tuple/Record indexing only), all imports `import type`, `.js` suffixes matching the repo's api→src convention (`api/_lib/analyticsRun.ts` precedent), worker copy matches the worker's `.js`-suffix convention (`worker/src/ai/roles.ts` precedent).
- Test file sits under `worker/src/creative/__tests__/`, which `worker/tsconfig.json` excludes from `tsc` (vitest-only, same as `worker/src/ai/__tests__/`).

**Action for the lead:** please run, when permissions allow —
```
npx tsc --noEmit -p tsconfig.api.json
cd worker && npm run typecheck && npx vitest run src/creative/__tests__/brandKit.test.ts
```
Expected: api typecheck clean (no new files touched outside `api/_lib/marketing/creative/`); worker typecheck clean; 28 tests pass. No peer files were imported, so no peer-missing errors are expected from my files.

## Contract deviations proposed

1. **`loadBrandKit` failure posture.** The brief specifies `→ BrandKit|null` without semantics. I made read-failure/shape-failure LOUD (`console.error`) but still `null` (not a throw), so a brand-kit outage degrades the creative lane to "no brand grounding" instead of failing jobs. If A-GEN/A-FACTS would rather hard-fail validation when the kit is unreadable, say so — the loader already logs, so the lane can distinguish "absent" from "broken" only via the log line. (Proposed, not a deviation from any written contract line.)
2. **`validatePaletteAgainstKit` treats `source:'brand_kit'` + off-kit hex as an error in BOTH modes.** Contracts §8 says "palette ⊂ brand kit or listed in deviations (advisory) / error (constraint)"; a mislabeled provenance claim is a data bug, not a deviation. Flagging in case A-FACTS wants the pure reading instead.
3. **`paletteRolesFor` signature returns `Record<string,string>`** (slot→hex, sparse). The brief didn't pin the return shape; if A-GEN/A-UI wants a fixed-slot object with `| null` values, trivial to change — one file, both copies.

## For other agents / the lead

- **Lead:** apply `supabase/migrations/2026-09-02_26_creative_brand_kit_seed.sql` (idempotent, ON CONFLICT DO NOTHING — safe before/after A-DB's `_25`). Then run the two typecheck commands + vitest above.
- **A-DB:** `_26` seeds `brand_kit` only; `writer_rules` remains yours per contracts §2.
- **A-GEN:** `brandKitPromptBlock(kit, language)` is the prompt block to inject into the director prompts (stage 'brand'). Pull the kit once per job via `loadBrandKit(sb)`; record `brand_kit.version`/`mode` on the package (already in the `_21` schema).
- **A-FACTS:** `validatePaletteAgainstKit` is the §8 palette rule — wire its `{deviations, errors}` into `validateBase`'s palette check; deviations land in `base.brand_kit.deviations` (advisory) or the error list (constraint).
- **A-API:** `brand_kit_get/save/review` can reuse `loadBrandKit`; the review action flips `status='reviewed', mode='constraint', reviewed_by/at` and bumps `version` (per §4) — the module intentionally has NO writer (settings writes stay in your endpoints).
- **A-UI:** `SettingsBrandKit` renders/edits the same JSON; the notes file (`docs/brand/brand-kit-notes.md`) holds the 7 open questions the reviewer should answer before promoting to `constraint` — most importantly: verify the two website dark surfaces (`#352013`/`#1A1009`) against `Wassel Website/index.html` (unreadable from my worktree), and make the Tajawal call (sanction or migrate).
