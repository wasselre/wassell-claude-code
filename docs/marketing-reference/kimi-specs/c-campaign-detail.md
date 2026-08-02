TASK: Rebuild the campaign-detail surfaces to EXACTLY match design screens 15 (تفاصيل الحملة), 20 (التنفيذات), 21 (تفاصيل التنفيذ), 39 (الحملة — المحتوى), 40 (الحملة — النتائج). Files: src/pages/Marketing/CampaignDetailPage.tsx, ExecutionDetailPage.tsx, a NEW file src/pages/Marketing/styles/campaign-detail.css (import from CampaignDetailPage.tsx; .mos-root-scoped; do NOT touch mos.css).

GROUND TRUTH: READ docs/marketing-reference/source/screens/s15.html, s20.html, s21.html, s39.html, s40.html. Bilingual verbatim-Arabic; num() digits.

DATA/API (api-contract.md): campaign_detail, campaign_events, campaign_event_add, campaign_outcomes, campaign_sign, budget_shift, execution_save (platform_campaign_id/purpose), ad_save/ad_delete, daily_save, asset/content linkage actions.

S15: goal card with يُقاس بـ/الجمهور/العرض/الوجهة fields (the new brief columns — editable per capability); «مقابل الهدف» pace + projection exactly as mocked (deterministic math from daily entries vs target; show the formula result the mockup shows); «ماذا تقول الأرقام» rules card — sentences GENERATED deterministically from on-screen values per the mockup's rule patterns (no LLM, no randomness; transcribe each rule's trigger condition from the mockup notes); «ما بعد الإعلان» block from campaign_outcomes; signature banner when requires_signature&&!signed (CEO sees sign button).
S20 (executions tab): execution cards with pace meters + verdicts exactly as mocked; weak-performer red card per the mockup's stated criterion; reallocation banner + «تحويل الميزانية» modal calling budget_shift (logs the event server-side); platform_campaign_id shown; purpose pill.
S21 (execution detail): platform_campaign_id field editable; re-verify the whole page against s21.html and fix drift (it was built earlier — treat the mockup as truth).
S39 (content tab): per-item ad rollups; «يعمل في» chips (which executions run this content); status pills; dimmed waiting rows; فك (unlink keeps history — content_unlinked event + the link removed but the event ledger shows it); ربط محتوى قائم picker; deterministic coverage card exactly as the mockup computes it.
S40 (results tab): cumulative qualified vs target chart + required-pace line with the gap verdict sentence; weekly CPL bars; «ما الذي تغيّر» timeline from campaign_events; «ما بعد الإعلان» from campaign_outcomes. Charts: recharts (repo dep) styled to the mockup exactly (colors/gridlines/labels).

VERIFY: npx tsc --noEmit clean. Print exactly: CAMPAIGN-DETAIL REBUILT + files changed.
