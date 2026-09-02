# A-UI report — Post Creative Director UI

2026-09-02. Typecheck: **`npx tsc --noEmit -p tsconfig.json` → exit 0, no output** (full repo, includes every file below).

## Files created

| File | What it is |
|---|---|
| `src/pages/Marketing/components/creative/labels.ts` | Shared bilingual label maps (placements, AI modes/statuses, rights, natures, sources, ref aspects/kinds, slide roles, image-change, job kinds/stages) + `platformLabel` over `PLATFORM_LABELS` |
| `src/pages/Marketing/components/creative/CreativeTab.tsx` | The container: flags/packages/job load → empty-state TargetsPicker → concepts → full editor → Apply/Revert/Regenerate; **4 s polling** of `fetchCreativeJobStatus` while queued/running (reloads packages + toasts on terminal); 6 s polling while an AI execution is queued/running (preserves unsaved human draft); version switching with unsaved-edit confirm |
| `src/pages/Marketing/components/creative/TargetsPicker.tsx` | Organic + paid target checklists (pre-checked from server `selected`), per-target dims from `PLACEMENT_SPECS`, `intended_use` authored here (never derived), optional recipe, suggested master aspect shown |
| `src/pages/Marketing/components/creative/ConceptCards.tsx` | 2–3 concept cards (title/angle/format/design idea/leans-on/suggested targets/why + recommended tag) + custom-concept form; warnings/missing rendered |
| `src/pages/Marketing/components/creative/BaseCreativeEditor.tsx` | Editable strategy (message/objective/audience/angle/desired response), on-design text (project lead, latin, headline lines, CTA), per-slide editor; visual direction read-only |
| `src/pages/Marketing/components/creative/SlideNavigator.tsx` | Carousel slide chips (index · role) |
| `src/pages/Marketing/components/creative/DerivativesPanel.tsx` | Per target: platform/placement/kind chips, aspect+px, `requires_separate_design` badge, editable copy (organic caption+hashtags with live `caption_max`/`hashtags_max` counters from `limits`; the five paid fields), collapsible **full VisualAdaptation** (image change/instructions, text+logo reposition, layout changes, scaling, slide-mapping table, asset substitutions) |
| `src/pages/Marketing/components/creative/ReferencesPanel.tsx` | Real previews (previews map → `preview_url` fallback), aspect chip, why/study/adapt/do-not-copy/differ, remove (edits draft base → new human version on save) |
| `src/pages/Marketing/components/creative/AssetsPanel.tsx` | Thumbnails, nature/source/rights(+verified)/production/usage badges, placement/treatment/why, needs-confirmation ribbon, **Replace → FilePickerModal** with `linked_record_id` = the project, `primary_category:'image'`, `usage_rights` excluding restricted/do_not_use, `showMeta` → `replaceCreativeAsset` |
| `src/pages/Marketing/components/creative/AiRecommendationsPanel.tsx` | Mode/prompt/sources/must-keep/must-change/policy line; **Approve execution only when `flags.ai_image_execution`** (+ write + not applied); Dismiss; execution status, error, and candidate-output preview with the "needs review" caveat |
| `src/pages/Marketing/components/creative/PalettePanel.tsx` | Swatches with name/hex/role/source, kit mode tag (advisory/constraint + version), deviations, WCAG contrast hint for text-on-background pairs < 3:1 |
| `src/pages/Marketing/components/creative/WarningsPanel.tsx` | Blocking base warnings (bad notice), missing facts, per-derivative notes |
| `src/pages/Marketing/components/creative/VersionsBar.tsx` | Version chips (vN · AI/human · concepts/applied) |
| `src/pages/Marketing/components/creative/HandoffView.tsx` | Designer handoff: message/objective/targets → verbatim on-design copy → slide plan → palette → exact assets (thumbs + rights flags) → references → composition/treatment + per-target adaptations → approved AI production (+ unapproved count) → warnings/missing. Per-section copy buttons (clipboard + loud failure), Print button with `@media print` rules hiding workspace chrome, draft banner when the latest package isn't applied |
| `src/pages/Marketing/components/creative/__fixtures__/package.json` | Realistic Arabic fixture in `CreativePackageGetResult` shape: 4-slide carousel, organic (IG carousel, IG story w/ separate-design + slide mapping, X) + paid (Meta ad_feed) derivatives, 2 assets (one needs-rights-confirmation), 2 references, 2 AI recs. Validated: parses + structurally satisfies the type (isolated tsc pass — only ambient-env errors from the scratch config, none from the fixture) |
| `src/pages/Marketing/components/SettingsBrandKit.tsx` | Kit editor (palette rows w/ color input, typography, logo, character, image treatment, prohibited, combinations, sources) + **Approve** (approve_creative → `reviewBrandKit`) + approved design examples registry with retire |
| `src/pages/Marketing/components/SettingsWriterRules.tsx` | shared/post/video rule lists (one per line) + read-only decisions log |
| `src/pages/Marketing/components/SettingsAiRoles.tsx` | Role table (provider select incl. runner, model, version, params JSON validated client-side before save); saves are additive (full map sent back; keys never removed) |
| `src/pages/Marketing/components/SettingsCreativeFlags.tsx` | The five `creative_writer` flags (described in plain language) + role map editor (`design_owner`, `design_reviewer` over the five path roles) |
| `src/pages/Marketing/components/SettingsCreativeRoutes.tsx` | Four route wrappers reading `useWorkspace()` and passing `canManage`/`canReview` down |

## Files edited

| File | Change (all additive) |
|---|---|
| `src/pages/Marketing/ContentDetailPage.tsx` | `'creative'` added to Tab; lazy `fetchCreativeFlags` only for post/carousel; header button **«اكتب بوست» / “Write post”** (post\|carousel + `write_content` + project linked + `flags.post_enabled`) → opens the tab; **creative tab** (post\|carousel, `view_content_body` gate, rendered only when the flag is on) rendering `CreativeTab` with `designOwnerActive = openTask.role === role_map.design_owner` |
| `src/App.tsx` | Four lazy routes `/m/settings/{brand-kit,writer-rules,ai-roles,creative-flags}` placed before `/m/settings/:section` (static segments outrank it) |
| `src/pages/CompetitorWatch/components/ContentLibrary.tsx` | **Design-read chip**: on expand, lazy `fetchDesignRead('competitor_post', id)`; chip + one-line summary (slide: layout/density/palette/branding; post: format/arc/branding + summary) in the detail; failures shown, never swallowed. **«مثال للدراسة»**: admin-only (resolved via `resolveEffectiveProfile(...).is_admin`) inline strengths/caveats/note form → `setDesignExample({example_kind:'study_only'})` + «في سجل الأمثلة» state |
| `docs/prd/marketing-workspace.md` | Last updated → 2026-09-02; Key behaviors bullet; Key files rows for the creative dir + settings screens + ContentDetailPage note |
| `docs/prd/competitor-watch.md` | Last updated → 2026-09-02; design-read chip + study-example bullets; ContentLibrary Key files row updated |

## Exported signatures (new, consumed by the above)

All UI components are default-exported React components; props are self-documenting in each file's header. Route wrappers: `BrandKitSettingsRoute`, `WriterRulesSettingsRoute`, `AiRolesSettingsRoute`, `CreativeFlagsSettingsRoute` (named, from `SettingsCreativeRoutes.tsx`).

## Deviations / decisions (proposed, not contract changes)

1. **Job polling lives inside `CreativeTab`, not `ContentDetailPage`.** The brief assigned the 4 s `fetchCreativeJobStatus` poll to the page; the tab is its only consumer, so the poll (and the 6 s AI-execution poll) lives there — same user-visible behavior, smaller page diff.
2. **Settings routes went into `src/App.tsx`** (explicit static routes, per the brief's OWN list) instead of `SettingsPage.tsx`'s `SECTIONS` registry — `SettingsPage.tsx` is in nobody's ownership list and I did not touch it. **Consequence for the lead:** the settings HOME index (`/m/settings`) does not list the four new screens; they're reachable by URL. If you want index cards, add four `SECTIONS` entries + `IndexCard`s there (the slugs then also work via the generic `:section` route — my explicit routes would shadow it harmlessly; pick one).
3. **Rail nav unchanged.** `MarketingWorkspace.tsx` needed no edit: the single «الإعدادات» rail item already covers settings sub-screens (same posture as workflows/audiences/etc., which also have no rail entries).
4. **Blocking-warning rule:** Apply is disabled while `base.warnings.length > 0` (those are validation issues that survived the AI's self-repair, §8) and while any asset has `needs_rights_confirmation` without the confirm checkbox. Derivative warnings are advisory (shown, non-blocking). Also disabled while the draft is dirty (unsaved edits must land as a version first).
5. **Editing scope:** strategy/message/on-design text/slides/derivative copy + adaptation prose are editable; visual direction is read-only (rewritten by Regenerate, not typed). Reference removal edits the draft base and lands with the next save (there is no per-ref delete action in the API).
6. **`role_map.design_owner` comparison uses `openTask.role`** (MosRole) vs the role-map string — per the brief's "the open task's `role_key` equals `role_map.design_owner`".

## Verification

- `npx tsc --noEmit -p tsconfig.json` → **clean (exit 0)**.
- Fixture: `node -e JSON.parse…` OK + isolated `tsc --strict --resolveJsonModule` pass against `CreativePackageGetResult` (no fixture-attributable errors).
- **Not done (no headless browser here):** the dev-server render behind a `window.fetch` mock. Manual check for the lead/QA: `npm run dev`, log in, open any post-type content with a linked project; the Creative tab shows the flag-off notice until `creative_writer.post_enabled` is flipped in `/m/settings/creative-flags`; then TargetsPicker → (mock or live API) concepts → package. To render against the fixture without the API, mock `/api/marketing-os` for `creative_flags`, `creative_package_list`, `creative_package_get` (return the fixture), `creative_job_status` (`{job:null}`).

## Needs from others

- **A-API:** endpoints must exist for all 27 wrappers (report says done). `creative_package_get.previews` should key asset file ids AND ref ids (both panels read `previews[file_id]` / `previews[ref_id]`); AI execution outputs are previewed via `previews[execution.output_file_id]` when present.
- **Lead:** decide the settings-index registration (deviation 2); apply migrations (none from me); the `post_creative_ready` notification rule seed is A-DB's `_25`.
- Nothing needed in peer-owned files.
