# PRD: Templates Library

**Status:** Live
**Last updated:** 2026-05-09
**Related PRDs:** [marketing-operations.md](marketing-operations.md) (the consumer of these templates), [model-builder.md](model-builder.md) (image field type, table field type)

## What it is (in plain English)

A reusable catalog of design templates. Each row defines one design that the marketing team can produce repeatedly — a reference image, the prompts the image generator should run, and the list of variables those prompts contain.

A template stays in the library forever. Same template + different project = same brand styling, different copy.

## Why it exists

The team needs to make many similar-looking designs across many projects (sale promo, off-plan launch, post-handover congratulations…). Without a library, every design generation re-types the same prompts. Templates Library promotes the prompts + variables into reusable rows so a marketer just picks a template and fills variables.

## Key behaviors

- **Each template carries three things:** a reference image (visual target Higgsfield steers toward), a cleanup prompt (used in phase 1 of generation), and a design prompt (used in phase 2).
- **Variables are defined inline as a `table` field.** Each row is one variable: `name` (the placeholder slug), `label_ar`, `label_en`, `type` ∈ {text, number, currency}. The `name` is what appears in `{{...}}` tokens inside the prompts.
- **Reference image lives in Supabase Storage.** Uploaded via the standard image field; stored under `marketing-assets/reference/<uuid>.png`.
- **No agents touch this model.** It's pure CRUD — admins curate, marketers consume. The Generate button on a marketing record reads the template at run time.
- **Templates are not versioned.** Editing a template's prompt or variable list affects every future generation that uses it. Existing finished designs aren't regenerated.

## User flows

1. **Admin curates a template:**
   1. Sidebar → Designs → Templates Library → New.
   2. Type a name (e.g. "Off-plan launch — landscape").
   3. Upload a reference image (the visual target).
   4. Paste the cleanup prompt and design prompt with `{{PLACEHOLDER}}` tokens.
   5. Add variable rows: `{ name: 'PROJECT_NAME_AR', label_ar: 'اسم المشروع', label_en: 'Project Name (AR)', type: 'text' }` etc.
   6. Save.

2. **Marketer consumes the template:** picks it from the lookup on a Marketing Operations record. The marketing record's "Template Variables" section auto-populates with one input row per variable.

3. **Empty state:** Templates Library with no rows shows the standard record list "No records yet — click New to add one" message.

## Data touched

- Reads/writes: `records` (JSONB) for the `design_templates` model
- Writes: `marketing-assets` Supabase Storage bucket (reference images)

## Key files

| File | What it does |
|---|---|
| [src/data/seedModels.ts](../../src/data/seedModels.ts) | Seeds the `design_templates` model: name, reference_image, cleanup_prompt, design_prompt, variables table, notes. |
| [src/pages/Records/components/DynamicField.tsx](../../src/pages/Records/components/DynamicField.tsx) | Renders the image field (reference image upload). |
| [src/pages/Records/components/TableField.tsx](../../src/pages/Records/components/TableField.tsx) | Renders the variables table editor. |
| [src/lib/imageUpload.ts](../../src/lib/imageUpload.ts) | Stores reference images in `marketing-assets/reference/<uuid>.png`. |
| [src/lib/templateUtils.ts](../../src/lib/templateUtils.ts) | Defines `TemplateVariableSpec` / `TemplateFieldValues` types consumed by the marketing-operations form. |

## Open questions / known limitations

- **No template versioning.** Editing a template's prompts changes future generations; existing records keep the design they already have. If the team needs versioning, add a `version` column + freeze policy later.
- **No template "preview" beyond the reference image.** The reference image is what the marketer sees when picking a template — there's no in-app render of "what the design might look like with these variables filled" without actually clicking Generate.
- **Variable types are intentionally narrow** (text / number / currency). Extending to lookup-style variables (e.g. "pick from a dropdown of districts") would require schema work on the table field's column types.
