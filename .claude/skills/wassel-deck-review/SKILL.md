---
name: wassel-deck-review
description: Review and auto-patch a Wassel Real Estate (وصل العقارية) PowerPoint deck for brand compliance and typography bugs. Use this skill whenever a Wassel deck has just been built and needs a final check before delivery, or when the user asks to "review", "audit", "lint", "check", or "QA" a Wassel presentation. Also trigger this after wassel-presentation produces its output — it's the final gate before handing the deck to the user. The skill auto-fixes mechanical issues (wrong fonts, blue hyperlinks, broken RTL, spacing glitches, missing LRM marks on numbers) and reports judgment calls (banned phrases like "Wassel CRM", drifted exact-phrase subtitles, colors outside the brand palette, missing or extra footers). Produces a reviewed pptx plus a markdown report.
---

# Wassel Deck Review

This is the final gate before a Wassel deck ships. It exists because the builder (`wassel-presentation`) is deterministic but not perfect, and because humans (or future Claude instances editing the pptx by hand) can introduce issues that slip past casual inspection — wrong font slots that make Arabic render as the theme default, blue underlined hyperlinks, tables that lost their RTL ordering, banned phrases like "Wassel CRM" sneaking back into copy.

Two outputs every time:
1. A **patched pptx file** (`<input>_reviewed.pptx`) with all mechanical issues auto-fixed.
2. A **markdown report** listing what was auto-fixed and what needs human judgment.

## When to use

- Immediately after `wassel-presentation` finishes building a deck — run this as the automatic final step before the parent agent uploads the reviewed pptx to Google Drive
- When the user hands over a pptx that "looks off" and wants it audited
- When someone edited the deck manually in PowerPoint/WPS and you want to verify brand compliance
- When a client reports a specific issue and you want to confirm it's a one-off vs a systemic drift

**Pipeline position:** this skill runs locally on `./<slug>/deck/raw.pptx` and writes `reviewed.pptx` alongside it. The orchestrator agent (`wassel-builder`) then uploads `reviewed.pptx` to Google Drive as `العرض - <project>.pptx` with `convertToGoogleFormat=false` (pptx must stay native — converting to Google Slides destroys Amiri/RTL/exact-position layout). Upload is the orchestrator's job, not this skill's.

## How to run it

The review is a single function call. You don't need to load any tools.

```python
import sys
sys.path.insert(0, "/path/to/wassel-deck-review/scripts")
from review import review_deck

report = review_deck(
    input_path="/mnt/user-data/outputs/my_deck.pptx",
    output_path="/mnt/user-data/outputs/my_deck_reviewed.pptx",
    fix=True,   # auto-patch mechanical issues. Set False for report-only.
)
print(report.markdown())
```

The function saves the patched pptx to `output_path` and returns a `Report` object.

## What gets auto-fixed (you don't need to touch these)

**Font slots.** Every text run should have Amiri set on all three OOXML font slots: `<a:latin>`, `<a:ea>`, `<a:cs>`. The complex-script slot is what PowerPoint and WPS actually use to render Arabic. If it's empty or wrong, Arabic silently falls back to the theme font even though the UI's font dropdown says "Amiri". The linter detects missing or mismatched slots and writes all three correctly.

**Hyperlink styling.** PowerPoint's theme auto-applies blue color + underline to runs with `<a:hlinkClick>`. The `wassel.re` footer and any other hyperlink run must be copper and un-underlined. The linter adds `u="none"` to suppress the underline on every hyperlink run.

**Spacing around separators.** Arabic typography with Latin separators (— – |) needs exactly one space on each side. Common drift: `حي النرجس —مدارس` (no space before), `حي النرجس  — مدارس` (double space), `حي النرجس|مدارس` (no spaces at all). The linter normalizes all of these to a single space on each side.

**LRM marks on Latin/numeric tokens inside Arabic text.** Without Left-to-Right marks, number runs like `918,400` or `A/B/C/D` can visually drift inside an Arabic paragraph — the comma might end up detached, or the letters might flip order in some renderers. The linter wraps each numeric/Latin token in `\u200E` marks if the surrounding text is Arabic.

**RTL paragraphs.** Arabic-containing paragraphs should have `rtl="1"` on their `<a:pPr>`. The linter adds this where missing.

**Parentheses in body copy.** Brand rule from `wassel-presentation/SKILL.md → Punctuation enforcement`: body/callout copy must not contain `(...)`. The linter replaces `(text)` with `— text —` (em-dashes with spaces). Three exceptions that are left alone:
- Parens already wrapped in LRM marks (`\u200E(A/B/C/D)\u200E`) — this is the builder's intentional wrap for building-code lists where parens are layout, not prose.
- URL-like runs (contain `://` or start with `http`) — parens inside URLs are structural.
- Numeric-range content like `(1,490,000 - 2,090,000)` — replacing these with em-dashes would produce nonsense (`— 1,490,000 - 2,090,000 —`). Reported for human review instead.

## What gets reported (needs your judgment)

**Banned phrases.** The linter will NEVER auto-replace these because the correct substitution depends on context:
- `Wassel CRM` / `CRM وصل` → the approved phrase is `نظام وصل`, but where to insert it depends on the sentence.
- `نادٍ` (with kasra) → should be `نادي` (without kasra), but worth checking the surrounding text is still grammatical.

**Exact-phrase drift.** These phrases are part of the Wassel brand script and must match byte-for-byte:
- Slide 4 subtitle must contain `مربع مشروع`
- Slide 7 subtitle must be exactly `الهدف: صناعة الطلب، وجلب المهتمين`
- Slide 11 subtitle must be exactly `تحويل الطلب والاهتمام إلى مبيعات`

When these drift, the linter reports the slide and the required text. It doesn't rewrite them because the project name inside slide 4's subtitle needs to change per project, and automatic rewriting risks overwriting legitimate variations.

**Colors outside the brand palette.** Every auto-shape fill should be one of: copper `#B8734F`, sand `#E8D9C0`, brown `#6B4226`, cream `#F8F5E9`, gold `#D9B57F`, charcoal `#3F3F3F`, white `#FFFFFF`. Plus the explicitly-allowed platform-brand colors on slide 9 (Snapchat yellow, TikTok black, Instagram pink, LinkedIn blue) and the slide-10 tagline background (`#FFF7F2`) and the slide-14 darkest funnel level (`#5A371F`). Anything else is reported as info — might be intentional (a legitimate accent introduced on purpose) or might be drift. Human decides.

**Footer presence / absence.** Content slides (2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15) must have a `wassel.re` footer. Divider slides (3, 7, 11) must NOT. The linter reports violations but doesn't add/remove footers automatically — doing so blindly would break layout.

**Slide count.** Wassel spec is exactly 16 slides. Anything else gets flagged.

## How to respond to the report

After running, show the user the markdown report first, then the patched file. Something like:

> The deck has been reviewed. Auto-fixed N mechanical issues; M items need your attention. Here's the summary: [report]. The patched file is at [path].

If the report has zero issues reported, that's a green light — the deck is ready. If there are critical items, walk the user through them briefly and ask whether they want to regenerate from `wassel-presentation` with corrected content, or edit the pptx manually.

## Run with `fix=False` when you want a diagnostic-only pass

If the user asks "is anything wrong with this deck?" and doesn't want it modified, pass `fix=False`. The report will list everything the linter WOULD have fixed, as reported issues. Useful for auditing a client deliverable after the fact without changing it.

## What this skill doesn't do

- It doesn't render slides to images and do visual-layout review. That requires LibreOffice/headless rendering plus a Claude visual check and is out of scope for the automated linter. If a slide looks misaligned despite passing the linter, that's a builder bug to fix in `wassel-presentation`, not something to patch here.
- It doesn't re-run the research or regenerate content. If the numbers on slide 4 are wrong, that's a content issue — go back to the source tables from `paseetah-research` and rebuild with `wassel-presentation`.
- It doesn't validate that the deck matches a specific project brief. The linter knows the Wassel brand spec; it doesn't know which project the deck is supposed to represent.
