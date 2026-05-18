// One-time / re-runnable upload of the wassel-general-ppt skill folder
// to the Anthropic Skills API. Prints the skill_id to wire into Vercel env.
//
// Run: $env:ANTHROPIC_API_KEY = "sk-ant-..."; node scripts/upload-wassel-skill.mjs
//
// Each successful run creates a NEW skill (different skill_id). To bump an
// existing skill to a new version instead, use --version-of <skill_id>.

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKILL_DIR = "C:\\Users\\rayan\\.claude\\skills\\wassel-general-ppt";
const SKILL_ROOT_PREFIX = "wassel-general-ppt"; // common root in upload paths
const DISPLAY_TITLE = "Wassel General PPT";

const MIME_BY_EXT = {
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".txt": "text/plain",
};

function* walk(dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__" || entry.name === ".git") continue;
      yield* walk(full, base);
    } else {
      if (entry.name.endsWith(".pyc")) continue;
      if (entry.name === ".DS_Store") continue;
      const rel = path.relative(base, full).split(path.sep).join("/");
      yield { full, rel, size: statSync(full).size };
    }
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Set it in this shell first:");
    console.error('  $env:ANTHROPIC_API_KEY = "sk-ant-..."');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const versionOfIdx = args.indexOf("--version-of");
  const versionOf = versionOfIdx >= 0 ? args[versionOfIdx + 1] : null;

  console.log(`Skill folder: ${SKILL_DIR}`);
  console.log(`Mode:         ${versionOf ? `new version of ${versionOf}` : "create new skill"}\n`);

  const files = [];
  let totalBytes = 0;
  // Collect-then-sort so SKILL.md is the FIRST entry in the files array.
  // Empirically the Anthropic Skills API validation prefers SKILL.md to be
  // the first file in the multipart form. With the natural walk order
  // (assets/, scripts/, SKILL.md) the API rejects the upload with
  // "SKILL.md file must be exactly in the top-level folder." even though
  // SKILL.md IS at the top level. Putting it first satisfies the check.
  //
  // Paths are kept inside a single top-level folder (`SKILL_ROOT_PREFIX`)
  // per the SDK docs: "All files must be in the same top-level directory
  // and must include a SKILL.md file at the root of that directory."
  const collected = [];
  for (const f of walk(SKILL_DIR)) {
    const ext = path.extname(f.full).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const apiPath = `${SKILL_ROOT_PREFIX}/${f.rel}`;
    collected.push({ ...f, ext, mime, apiPath });
  }
  collected.sort((a, b) => {
    const aIsSkill = a.rel === "SKILL.md" ? 0 : 1;
    const bIsSkill = b.rel === "SKILL.md" ? 0 : 1;
    if (aIsSkill !== bIsSkill) return aIsSkill - bIsSkill;
    return a.apiPath.localeCompare(b.apiPath);
  });
  for (const f of collected) {
    const file = await toFile(createReadStream(f.full), f.apiPath, { type: f.mime });
    files.push(file);
    totalBytes += f.size;
    console.log(`  + ${f.apiPath}  (${f.mime}, ${f.size} bytes)`);
  }

  if (totalBytes > 30 * 1024 * 1024) {
    console.error(`\nBundle is ${(totalBytes / 1024 / 1024).toFixed(2)} MB — exceeds 30 MB limit.`);
    process.exit(1);
  }

  console.log(`\nTotal: ${files.length} files, ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log("Uploading to Anthropic Skills API...\n");

  const client = new Anthropic();

  let skill;
  if (versionOf) {
    // The SDK's `client.beta.skills.versions.create()` strips the folder
    // prefix from each file's name (it calls multipartFormRequestOptions
    // WITHOUT the stripFilenames=false third arg that skills.create has).
    // Result: every uploaded file ends up as just its basename, and the
    // API rejects with "SKILL.md file must be exactly in the top-level
    // folder." Bug confirmed in @anthropic-ai/sdk@0.91.0 by reading
    // worker/node_modules/@anthropic-ai/sdk/resources/beta/skills/{skills,versions}.js.
    //
    // Workaround: skip the SDK and call the API directly with a multipart
    // body where we control the Content-Disposition filename (including
    // the folder prefix) ourselves.
    const apiBase = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const form = new FormData();
    for (const f of files) form.append("files[]", f, f.name);
    const res = await fetch(`${apiBase}/v1/skills/${versionOf}/versions?beta=true`, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "skills-2025-10-02",
      },
      body: form,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(payload?.error?.message || `HTTP ${res.status}`);
      // eslint-disable-next-line no-throw-literal
      throw Object.assign(e, { status: res.status, error: payload?.error ?? payload });
    }
    skill = payload;
    console.log(`✓ New version created`);
    console.log(`  skill_id:       ${versionOf}`);
    console.log(`  version:        ${skill.version ?? skill.id ?? "(unknown)"}`);
  } else {
    skill = await client.beta.skills.create({ display_title: DISPLAY_TITLE, files });
    console.log(`✓ Skill created`);
    console.log(`  id:             ${skill.id}`);
    console.log(`  display_title:  ${skill.display_title}`);
    console.log(`  latest_version: ${skill.latest_version}`);
    console.log(`  source:         ${skill.source}`);
    console.log(`  created_at:     ${skill.created_at}`);
    console.log(`\nAdd to .env.local AND Vercel env:`);
    console.log(`  ANTHROPIC_WASSEL_SKILL_ID=${skill.id}`);
  }
}

main().catch((err) => {
  console.error("\n✗ Skill upload failed");
  if (err.status) {
    console.error(`  HTTP ${err.status}`);
    console.error(`  ${err.message}`);
    if (err.error) console.error(`  body: ${JSON.stringify(err.error, null, 2)}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
