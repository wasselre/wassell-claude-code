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
  for (const f of walk(SKILL_DIR)) {
    const ext = path.extname(f.full).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const apiPath = `${SKILL_ROOT_PREFIX}/${f.rel}`;
    const file = await toFile(createReadStream(f.full), apiPath, { type: mime });
    files.push(file);
    totalBytes += f.size;
    console.log(`  + ${apiPath}  (${mime}, ${f.size} bytes)`);
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
    skill = await client.beta.skills.versions.create(versionOf, { files });
    console.log(`✓ New version created`);
    console.log(`  skill_id:       ${versionOf}`);
    console.log(`  version:        ${skill.version ?? skill.id}`);
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
