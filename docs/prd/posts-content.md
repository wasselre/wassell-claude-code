# Posts Content Writer — كاتب المحتوى

**Last updated:** 2026-07-27
**Route:** `/marketing/posts` · **Page id:** `posts_content` · **Default access:** admin (grantable per profile in Settings → Profiles)

## What it is

A marketing-copy generator. The user picks one or more projects from **Our Projects (مشاريعنا)**, says how many posts they want, in which language and style, and gets that many social/brochure posts written from the project's **real database facts** — then approves, rejects, edits or rewrites each one.

It exists because writing project posts by hand doesn't scale across a 49-project portfolio, and because a generic AI writer invents amenities and prices. Every factual line in a post here comes from the database, and every claim the model makes must cite a fact that exists.

## Key behaviors

### 1. Marketing angles, not property types

The 15 client-supplied templates (`src/lib/postsContent/templates.ts`) are treated as **marketing ANGLES**, not property descriptions:

فخامة · إطلالة وارتفاع · استقلالية عائلية · استقرار عائلي · أمان ومجتمع مغلق · طبيعة وخصوصية · منزل ذكي · موقع مميز ومساحة · انطلاقة ذكية · هيبة وثبات · توازن وقيمة · بيع على الخارطة · جودة وضمانات · موقع وسهولة وصول · واجهات وإضاءة

This is not a stylistic choice. Every one of the 49 `our_projects` rows sells exactly **one** unit type, so taking the templates literally would advertise villas for an apartment project. The project's real `unit_types` is always the source of truth; the angle only sets the theme. The prompt states this explicitly and the model is told never to change the property type.

### 2. Supported-angle ranking — unsupported angles are never generated

Before any tokens are spent, `rankAngles()` scores all 15 angles against the project's real text (features, services, amenities, landmarks, guarantees, construction status):

- **+1** per distinct evidence keyword the project's data actually contains
- **+1** if the project's unit type is one the angle naturally fits
- Angles scoring below **`MIN_ANGLE_SCORE` (2)** are **excluded outright**, not generated-with-a-warning

The floor of 2 was set after reviewing live output: a single incidental keyword produced junk eligibility (a rooftop feature «سطح» made "family independence" eligible for an apartment tower; «حديقة» made "prestige" eligible). Two keywords, or one plus a fitting unit type, is the bar.

Surviving angles are ranked strongest-first and assigned in that order. **An angle is only reused once every supported angle has been used**, and each reuse carries a `variationIndex` plus the headlines already written for that project, so the prompt is told to change the hook, headline structure, lead benefit, supporting facts and sentence rhythm.

If a project supports no angles at all, it produces **no posts** and the shortfall is reported explicitly — never padded with invented claims.

### 3. Two independent anti-fabrication gates

Checking for digits is not sufficient: "مع مسبح خاص وحديقة" contains no numbers and is still a fabrication. So there are two gates, both enforced server-side in `api/templates/posts-content.ts`:

| Gate | What it stops | How |
| --- | --- | --- |
| **Structural** | Invented prices, areas, warranty durations, room/unit counts | The model writes ONLY a headline + prose. Every specification line is rendered by `composeSpecBlock()` from database values. `checkNoNumbers()` rejects prose containing a currency token, an area unit, or any 3+ digit number. |
| **Referential** | Invented features — pools, gardens, security, smart systems, private entrances, landmarks, financing, completion dates | The model is given a **fact catalog** (`buildFactCatalog()`) of id'd facts and must return `used_fact_ids[]`. Any id not in the catalog, or an empty list, is a rejection. |

A rejected generation is retried **once** with the violation (and the list of valid ids) fed back, then reported as a failure for that post alone. Nothing that fails a gate is ever published.

The deterministic spec block may contain only: unit type, location, available area range, available price range, top features, top guarantees, and the project link.

### 4. Available-only pricing (QA-003)

Price and area come from `available_price_range` / `available_area_range` — the AVAILABLE-units-only rollups — never the all-unit ranges. A sold-out project shows **no price and no area** rather than a stale one. Verified live against يمام فلورز 8 (0 available units): both lines are omitted from the spec block and the picker shows no price.

### 5. Flexible quantities

- **Total, distributed**: N posts spread across the selected projects. Even split, remainder to the earliest projects, deterministically — 10 across 3 → **4, 3, 3**. The split is shown *before* generation and is exactly what runs.
- **Per project**: an explicit count for each selected project (e.g. A: 8, B: 4, C: 6).

Limits: **60** posts per batch, **30** per project, **10** projects per batch. An over-limit request is a **blocking error naming the limit** — the count is never silently trimmed.

### 6. Language

Arabic is the default. `ar` / `en` / `both`.

- **Arabic only** — no English is generated; the request does not require or spend tokens on English keys.
- **English only** — the English body uses the authoritative English city/district names from the geo models; a geography record that isn't fully localized is omitted rather than leaking Arabic.
- **Both** — an independently written English equivalent carrying the same verified facts, not a literal translation.

### 7. Review

Statuses: `draft` · `approved` · `rejected`.

| Action | Transition | Notes |
| --- | --- | --- |
| Approve | draft → approved | stamps `approved_at` / `approved_by` |
| Unapprove | approved → draft | clears the approval. **Explicitly NOT a rejection** — writes no rejection verdict |
| Reject | draft/approved → rejected | requires a reason; stamps `rejected_at` / `rejected_by` / `rejection_reason` / `rejection_feedback` |
| Restore | rejected → draft | clears both verdicts |
| Rewrite | any → draft (replaced content) | the previous verdict was about text that no longer exists |
| Edit | in-place | debounced write-through, stamps `edited_at` |

Rejection reasons: معلومات غير صحيحة · عنوان ضعيف · تكرار في الصياغة · زاوية تسويقية خاطئة · رسمي أكثر من اللازم · غير رسمي بما يكفي · طويل · قصير · أخرى — plus an optional free-text note.

**On rewrite the reason and note are sent to the model** along with the previous headline and prose, instructing it to fix that specific problem without changing any verified fact or drifting off the angle.

Bulk actions operate on the **currently filtered** set and say so in the label ("اعتماد الظاهر (7)"), so approving while a filter is active can't silently approve posts nobody looked at. **Bulk reject is deliberately absent** — a reason per post is what makes the regeneration loop work, and one blanket reason is worse than useless.

### 8. Generation behavior

Posts stream in progressively: work is chunked (up to 4 posts per request, grouped by project, 3 requests in flight) so no request approaches the 60 s ceiling and cards fill in as results land. Per-post loading / ready / failed states; a failure affects only its own card and is retryable alone. Each post is persisted **as it arrives**. A second click on Generate is ignored while a run is in flight.

**No queue.** Text generation is ~5-15 s per post, unlike the deck / image / document / preview pipelines which genuinely need one.

## User flows

**Generate** → Setup: search + multi-select projects (name, district/city, available units, available price) → quantity mode + counts → language → style → read the distribution preview and any warnings → Write.
**Review** → cards per post with project, angle, evidence chips, language tabs, headline, editable body, the DB-rendered spec block, and approve/reject/rewrite/copy → filter by project / angle / status / free text → live counts.
**Reopen** → Previous batches panel → statuses, edits and rejection feedback all restored.

## Data touched

| Model | Role |
| --- | --- |
| `our_projects` | the picker; RLS-scoped via `useApplyViewScope` |
| `all_projects` | the linked master — the actual source of every fact |
| `units` | indirectly, via the stored rollups on all_projects |
| `cities` / `districts` | authoritative bilingual place names |
| `developers` | developer name |
| **`posts_content`** | one record per generated post |
| **`posts_batches`** | one record per generation run |

**Derived vs stored on `posts_batches`:** `requested_count` and `failed_count` are STORED because they cannot be recovered from the post rows (a post that failed to generate has no row). Completed / approved / rejected counts are **DERIVED** from `posts_content` at read time — storing them would be a second source of truth that drifts the moment someone approves a post from the record list instead of the writer page.

## Permissions

Page access is gated by `RequirePageAccess pageId="posts_content"` and `default_access: 'admin'` in `src/lib/customPages.ts` — hidden until an admin grants it per profile. The generate endpoint additionally RLS-gates the source project under the caller's JWT; the service client is used only for reference geography and developer names.

## Failure handling

| Failure | Behavior |
| --- | --- |
| One post fails a gate twice | that card shows the error, retryable alone; batch continues |
| A whole chunk fails (network/500) | every item in it is marked failed and retryable; batch continues |
| Project supports no angles | skipped with an explicit toast + a pre-generation warning |
| Requested > supported angles | pre-generation warning; angles reused with forced variation |
| Save fails | red toast + `console.error`; never silent |
| Qwen unavailable/invalid | falls back to Anthropic, logged via `logQwenFallback` |

## Key files

| File | Role |
| --- | --- |
| `src/lib/postsContent/templates.ts` | the 15 angles, evidence keywords, tone references |
| `src/lib/postsContent/planning.ts` | distribution, angle ranking, assignment, quantity validation (pure) |
| `src/lib/postsContent/facts.ts` | fact types, fact catalog + validation, spec-block composer |
| `src/lib/postsContent/client.ts` | preflight, work-item building, chunked fan-out, single rewrite |
| `api/templates/posts-content.ts` | fact resolution, prompts, both gates, Qwen→Anthropic routing |
| `src/pages/PostsContent/PostsContentPage.tsx` | stage orchestration, persistence, review actions |
| `src/pages/PostsContent/components/{SetupStage,ReviewStage,PostCard,RejectModal}.tsx` | UI |
| `src/pages/PostsContent/lib/persistence.ts` | post/batch ⇄ record mapping, review transitions |
| `supabase/migrations/2026-07-26_posts_content_v2.sql` | both models |

## Assumptions

- Angle eligibility is **keyword-based** over the project's Arabic free text. It is a heuristic: it can miss a genuinely-supported angle whose feature is worded unusually, and (above the score floor) can admit a weakly-related one. Ranking puts weak angles last, so they are only reached at high requested counts.
- The **evidence keywords are Arabic-only**. Matching normalizes alef/ya/ta-marbuta variants, diacritics and tatweel, but a project whose features were entered in English would score 0.
- One `posts_content` record = one post. Rewrites **update the record in place** rather than versioning it; the previous text is not retained.
- Batch metadata assumes a batch is generated by one user in one session.

## Known limitations

1. **English posts carry Arabic feature and warranty text.** `features` / `guarantees` / `services` on `all_projects` are Arabic-only free text with no English column, so an English post's «المزايا» and «الضمانات» lines render their Arabic values. This is the documented "unless no English value exists" fallback, not a leak of translatable data. Fix path: add English columns to those tables on `all_projects`.
2. **Project names are not romanized.** A project name has no official English form, so the prompt instructs the model to use the Arabic name verbatim in English text. Left to the model, the transliteration varied between posts ("Ston Al Nada" vs "Stoon Al Nada") — an invented, unstable spelling. Fix path: an English-name field on `all_projects`, or reuse `/api/transliterate-name` server-side.
3. **Anthropic fallback is currently out of credits** (verified 2026-07-27: `credit balance is too low`). Production routes to Qwen first (`TEXT_LLM_PROVIDER=qwen`) and every live test passed on Qwen, so the feature works — but the fallback path will fail until the account is topped up.
4. **Angle reuse variation is best-effort.** `variationIndex` is deterministic, but `avoid_headlines` only carries headlines from chunks that have already returned, so the earliest concurrent chunks see fewer of them.
5. **No image attachment.** Posts are text only; the project gallery is not offered.
