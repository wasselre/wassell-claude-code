---
description: Run the full Wassel deck routine — Paseetah (/ar/chat, 9 categories) → research + merge + build + review → main-thread uploads to Drive via Connectors
argument-hint: <project name, district, developer, any known details>
---

Run the full Wassel Real Estate (وصل العقارية) deck pipeline for this project.

**Project brief:** $ARGUMENTS

## Why this command is split across threads

Two MCPs the pipeline needs — the Chrome browser MCP (for Paseetah) and the Google Drive Connectors MCP (for uploads) — do **not** reliably propagate into subagents. Confirmed by diagnostic. So the main thread handles **both** MCP-driven steps (Paseetah at the start, Drive at the end), and the subagent runs the heavy middle — web research, merge, deck build, deck review — in isolated context so none of that noise lands in the main conversation window.

---

## Step 0 — Validate settings (hard gate)

Before doing anything else:

1. Read `~/.claude/settings.json` — look for `wassel.parentDriveFolderId`.
2. If the field is missing, empty, or still the placeholder `"<paste Drive folder ID>"`, **stop immediately** and print this one-line instruction:

   > **Before running /wassel**: set `wassel.parentDriveFolderId` in `C:\Users\rayan\.claude\settings.json` to the Drive folder ID where project subfolders should be created. See `wassel-project-research/references/google_setup.md` for how to find the ID and how to connect Google Drive via the Connectors panel.

3. If the value looks like a full Drive URL (`https://drive.google.com/drive/folders/ABC...`), extract the ID via regex (`/folders/([a-zA-Z0-9_-]+)`) and proceed.
4. Check that the **Google Drive Connectors MCP** is available. It surfaces as UUID-prefixed tools — look for any tool matching `mcp__*__create_file` in the deferred/available tool list. If none is present, **warn but continue** — the pipeline will build locally and return local paths instead of Drive URLs, and the user can upload manually.

Also confirm:
- The project brief names a district AND city (Arabic or transliterated).
- The user is signed in to paseet.ai in the Chrome window (ask once if you're unsure).

---

## Step 1 — Main thread: Paseetah market data (/ar/chat, 9 categories)

**Progress signal.** Before starting this step, print this exact line on its own (no code fence, no extra text):

```
###PRESENTATION-PROGRESS###{"stage":"paseetah","message_ar":"جاري جمع بيانات السوق من بسيطة","message_en":"Gathering market data from Paseetah"}
```

Invoke the `paseetah-research` skill **yourself** in this main thread. Pass it:

- District and city from the brief
- Unit type (e.g. شقة، دور، فيلا)
- Instruction to run the full 9-category query loop, not ad-hoc queries

The skill navigates to `https://paseet.ai/ar/chat`, runs one query pass per category, and produces a 15-column Arabic markdown table. If Paseetah requires login, the skill will stop and ask the user to sign in.

Save the skill's output to:

```
C:\Users\rayan\.claude\ppt\<project-slug>\market\paseetah.md
```

Where `<project-slug>` is an ASCII transliteration of the project name (e.g. `adwar-alolaya`, `maqam-17`). Local filenames stay ASCII; Arabic names are for the Drive deliverables only.

If Paseetah errors out entirely, save a stub `paseetah.md` with a one-line note explaining the failure, and continue. The subagent will treat it as a verification gap and bias web research harder.

Keep your own narration in this thread minimal: one sentence before the skill call, one sentence after confirming the file is saved.

---

## Step 2 — Delegate to `wassel-builder` subagent

**Progress signal.** Before delegating, print this exact line:

```
###PRESENTATION-PROGRESS###{"stage":"research","message_ar":"جاري التحقق من المشروع وبناء العرض","message_en":"Verifying project and building deck"}
```

Use the Agent tool with `subagent_type: "wassel-builder"`. In the prompt, include:

- The full project brief from `$ARGUMENTS` verbatim
- Absolute path to the Paseetah file you just saved
- The project slug you chose for the working directory

The subagent will run the 5-phase build pipeline in isolated context:
1. Web research (9-category coverage) — `wassel-project-research`
2. Merge → `sources.csv` (via `merge_to_sheet.py`)
3. Build the .pptx — `wassel-presentation`
4. Review — `wassel-deck-review`
5. Return local paths + status

The subagent does **NOT** touch Drive. It returns:
- Absolute path to `sources.csv`
- Absolute path to `reviewed.pptx`
- Absolute path to `review_report.md`
- Project name (Arabic) for the Drive folder / file names
- Blocking issues, verification gaps, research stats

Do **NOT** run any of those skills yourself in the main thread. The whole point is to keep heavy research, build, and review out of the main context window.

---

## Step 3 — Main thread: upload to Drive via Connectors MCP

**Progress signal.** Before the first `create_file` call, print this exact line:

```
###PRESENTATION-PROGRESS###{"stage":"upload","message_ar":"جاري رفع الملفات إلى Google Drive","message_en":"Uploading files to Google Drive"}
```

Once the subagent returns, use the Google Drive Connectors MCP (UUID-prefixed `create_file` tool) from the main thread.

### 3a — Create the project subfolder

```
create_file(
    title="<Arabic project name>",
    mimeType="application/vnd.google-apps.folder",
    parentId="<parentDriveFolderId from settings.json>"
)
```

Save the returned folder `id`. Construct the folder URL as:
`https://drive.google.com/drive/folders/<folderId>`

### 3b — Upload `sources.csv` as a Google Sheet

Base64-encode the CSV (use Bash with Python one-liner: `python -c "import base64,sys; sys.stdout.write(base64.b64encode(open(r'<csv-path>','rb').read()).decode())"`). Then:

```
create_file(
    title="مصادر البيانات - <Arabic project name>",
    mimeType="text/csv",
    content="<base64 of csv bytes>",
    parentId="<folderId from 3a>"
)
```

Because the default behavior converts `text/csv` to `application/vnd.google-apps.spreadsheet`, this lands as a native Google Sheet. Save the returned `id` as `spreadsheetId`. The Sheet URL is:
`https://docs.google.com/spreadsheets/d/<spreadsheetId>/edit`

**RTL note:** The Connectors MCP doesn't expose a sheet-properties toggle for right-to-left direction. Tell the user to flip it manually once: **File → Settings → Locale → Saudi Arabia, then File → Settings → right-to-left**.

### 3c — Upload the reviewed .pptx (keep as native PowerPoint)

Base64-encode the .pptx the same way. Then:

```
create_file(
    title="العرض - <Arabic project name>.pptx",
    mimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation",
    content="<base64 of pptx bytes>",
    parentId="<folderId from 3a>",
    disableConversionToGoogleType=true
)
```

**Why `disableConversionToGoogleType=true` is non-negotiable:** converting the .pptx to Google Slides destroys the Amiri font, the RTL bidi marks (LRM/RLM), exact-position layout, and color fidelity. The uploaded file must stay a native .pptx that Google Slides simply stores (openable via "Open with → Microsoft PowerPoint"). If this flag is omitted, the brand deliverable is broken the moment it lands in Drive.

Save the returned `id` as `deckFileId`. The deck URL is:
`https://drive.google.com/file/d/<deckFileId>/view`

### Fallback — if Drive upload fails

If the Connectors MCP is not available, or any `create_file` call errors out, or the .pptx is too large to inline as base64 (> ~8 MB), stop the Drive work and return local paths to the user instead. Tell them exactly which upload failed and provide the local paths so they can upload manually.

---

## Step 4 — Summarize for the user

Write one short paragraph covering:

- **Ready to ship or not?** Lead with this.
- **Drive links** — folder, sheet, deck (as clickable markdown links).
- **Sheet RTL reminder** — one line telling the user to flip RTL in the Sheet's File → Settings once.
- **Blocking issues** (if any) — the 1–5 things needing user decision before sending to a client.
- **Verification gaps** (if any) — facts that couldn't be confirmed.
- **Research stats** — one line: `filled=N rows of 45, gaps=N, conflicts=N`.

Flag any blocking issue that could embarrass the brand if unresolved (wrong developer name, price conflict, banned wording) — those come first.

If Drive upload fell back to local paths, lead with that instead of Drive links, show the local paths, and point the user to `google_setup.md` for the Connectors setup.

---

## Step 5 — Emit the machine-readable result sentinel

After the human-readable summary above, print **exactly one additional line** at the very end of your output that the Presentations daemon can parse unambiguously. It must be a single line (no line breaks inside the JSON, no extra whitespace before the prefix) with this shape:

```
###PRESENTATION-RESULT###{"ok":true,"drive_folder_url":"<folder URL or null>","drive_deck_url":"<deck URL or null>","drive_sheet_url":"<sheet URL or null>","warnings":["..."]}
```

Rules:

- Use `"ok": true` only when the deck was produced AND uploaded to Drive successfully (or produced successfully with local-paths fallback — then include `"local_paths": {...}` and set drive fields to `null`).
- Use `"ok": false` when the deck couldn't be produced at all. Put the short human reason in `warnings[0]`.
- `drive_folder_url`, `drive_deck_url`, `drive_sheet_url` — use `null` for any that weren't created.
- `warnings` — an array of short strings. Include anything the user should know but that didn't block completion (e.g. "Paseetah had no matching transactions for this district", "Sheet RTL not flipped yet").
- Optionally include `"research_stats": {"filled": N, "total": 45, "gaps": N, "conflicts": N}` — the app's detail page renders this as a footnote.

This line is parsed by `daemon/src/runner.ts`. Do not vary the prefix. Do not wrap it in a code fence. Do not print anything after it.

**Example final line for a successful run:**

```
###PRESENTATION-RESULT###{"ok":true,"drive_folder_url":"https://drive.google.com/drive/folders/ABC","drive_deck_url":"https://drive.google.com/file/d/XYZ/view","drive_sheet_url":"https://docs.google.com/spreadsheets/d/QRS/edit","warnings":["Sheet RTL not flipped — do it once in File → Settings"],"research_stats":{"filled":41,"total":45,"gaps":4,"conflicts":0}}
```

**Example final line for a local-paths fallback (Drive upload failed):**

```
###PRESENTATION-RESULT###{"ok":true,"drive_folder_url":null,"drive_deck_url":null,"drive_sheet_url":null,"local_paths":{"deck":"C:/Users/rayan/.claude/ppt/adwar-alolaya/reviewed.pptx","sheet":"C:/Users/rayan/.claude/ppt/adwar-alolaya/sources.csv"},"warnings":["Drive Connectors MCP unavailable — files saved locally"]}
```

**Example final line for a full failure:**

```
###PRESENTATION-RESULT###{"ok":false,"warnings":["paseet.ai session expired; retry after signing in"]}
```

Emitting this sentinel does not replace the human summary — print both. The human summary is for the interactive user; the sentinel is for the daemon.
