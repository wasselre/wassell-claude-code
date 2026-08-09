# Google Drive Setup for /wassel (Connectors path)

One-time setup. After this, every `/wassel` run creates a Drive subfolder + Google Sheet + native .pptx automatically. Takes ~2 minutes. No Google Cloud project needed.

## What you need

1. A Google account (personal is fine).
2. Google Drive connected via Claude's **Connectors** panel (built-in OAuth, no Cloud console required).
3. A parent Drive folder where `/wassel` will create one subfolder per project.

---

## Step 1 — Connect Google Drive via Connectors (1 min)

1. In Claude, open the **Connectors** panel (sidebar or settings, depending on your client).
2. Find **Google Drive** in the connector list.
3. Click **Connect** → sign in with your Google account → approve the requested scopes (read/write files you create via the connector).
4. Done. The MCP tools become available as UUID-prefixed names like `mcp__<uuid>__create_file`, `mcp__<uuid>__read_file_content`, etc. `/wassel` detects them automatically.

## Step 2 — Create the parent Drive folder

1. Open [drive.google.com](https://drive.google.com).
2. Create a new folder — name it whatever you like (e.g. `Wassel Projects`, `مشاريع وصل`).
3. Open the folder. Copy the ID from the URL:

   ```
   https://drive.google.com/drive/folders/1AbC2dEfG3hIjK4lMnOp5qRsT6uVwXyZ
                                          ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                                          that's the folder ID
   ```

## Step 3 — Paste the folder ID into settings.json

Open `C:\Users\rayan\.claude\settings.json`. Find the `wassel` block and replace the placeholder:

```json
"wassel": {
  "parentDriveFolderId": "1AbC2dEfG3hIjK4lMnOp5qRsT6uVwXyZ",
  "deckNamePattern": "العرض - {project}",
  "sheetNamePattern": "مصادر البيانات - {project}"
}
```

A full Drive URL pasted here also works — `/wassel` extracts the ID with a regex.

That's it. Run `/wassel <project brief>` and a new subfolder with the project name + the Sheet + the .pptx will land in your parent folder.

---

## How the pipeline uses the Connectors MCP

The `/wassel` command's Step 3 runs three calls against the `create_file` tool:

1. **Folder**: `mimeType="application/vnd.google-apps.folder"`, `parentId=<your parent folder>`, no content.
2. **Sheet**: `mimeType="text/csv"`, `content=<base64 of sources.csv>`, `parentId=<new folder>`. Auto-converts to Google Sheets on the way in.
3. **Deck**: `mimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation"`, `content=<base64 of reviewed.pptx>`, `parentId=<new folder>`, `disableConversionToGoogleType=true`. Stays a native .pptx so the Amiri font, RTL bidi marks, and exact layout survive.

The subagent (`wassel-builder`) does NOT call the Connectors MCP itself — the Connectors MCP doesn't reliably propagate into subagents, so the main thread does the uploads after the subagent returns local file paths.

---

## Troubleshooting

**"MCP tools not available"** — Reconnect Google Drive in the Connectors panel and restart Claude Code.

**Deck uploaded as Google Slides icon, not native .pptx** — `disableConversionToGoogleType` was not passed as `true`. Delete the uploaded file and re-upload with the flag set. The exact call shape is in `commands/wassel.md`.

**Sheet renders LTR (columns flowing left-to-right)** — The Connectors MCP has no dedicated RTL toggle. Open the sheet manually once: **File → Settings → right-to-left**. One-time click per sheet.

**"Insufficient Permission" errors** — Disconnect Google Drive in the Connectors panel, reconnect, and accept the full scope set.

**Base64 upload fails for large .pptx (> ~8 MB)** — The main-thread fallback saves the file locally and hands you the path. Upload it manually to the project folder.

---

## If you skip this setup

`/wassel` still works — Step 0 will see an unset `parentDriveFolderId` and stop with an instruction. Or you can connect Drive and set the folder ID later; the pipeline will save `sources.csv` + `reviewed.pptx` locally either way, so nothing is lost — just less automated.

---

## Legacy: Google Cloud OAuth path (deprecated for this workflow)

The pipeline previously required a Google Cloud project, OAuth Desktop client, and the `@piotr-agier/google-drive-mcp` npm package — roughly 10 minutes of setup through console.cloud.google.com. That path still works if you prefer it, but it's overkill given Connectors does the same job in one click. If a future version of this workflow ever needs service-account auth (e.g. server-side automation, CI pipelines), revisit the Cloud setup then. For local /wassel runs, use Connectors.
