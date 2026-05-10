// Time a real Anthropic skill + code_execution call locally to find out
// whether the Vercel 300s timeout is caused by Vercel buffering (fix:
// switch to Edge runtime) or by Anthropic genuinely taking >300s (fix:
// kick-off + poll architecture).
//
// Run: node scripts/time-anthropic-deck.mjs

import Anthropic from "@anthropic-ai/sdk";

const SKILL_ID = "skill_01WfZySZ4829ynH3zaLB9nao";
const BETAS = [
  "skills-2025-10-02",
  "code-execution-2025-08-25",
  "files-api-2025-04-14",
];

const SYSTEM = `You are building a Wassel Real Estate brand-compliant PowerPoint per the user's brief.
The 'wassel-general-ppt' skill is loaded — read its SKILL.md and use scripts/wassel_chrome.py.
Compose a custom Python build script and save the output to /mnt/user-data/outputs/<slug>.pptx.
Reply with one short sentence describing what you built.`;

const BRIEF = `A 4-slide capability deck for Wassel Real Estate. Slide 1: brand title. Slide 2: what we do (marketing + sales for KSA real estate). Slide 3: how we work (CRM + AI agents + workflows). Slide 4: contact placeholder. Arabic, RTL, modern minimal layout.`;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }
  const client = new Anthropic();

  for (const model of ["claude-sonnet-4-6"]) {
    console.log(`\n=== ${model} ===`);
    const t0 = Date.now();

    const response = await client.beta.messages.create({
      model,
      max_tokens: 8192,
      betas: BETAS,
      container: { skills: [{ type: "custom", skill_id: SKILL_ID, version: "latest" }] },
      system: SYSTEM,
      messages: [{ role: "user", content: BRIEF }],
      tools: [{ type: "code_execution_20250825", name: "code_execution" }],
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`elapsed: ${elapsed}s`);
    console.log(`stop_reason: ${response.stop_reason}`);
    console.log(`usage: ${JSON.stringify(response.usage)}`);
    console.log(`content blocks: ${response.content.length}`);

    let outputFileId = null;
    for (let i = 0; i < response.content.length; i++) {
      const block = response.content[i];
      console.log(`  [${i}] type=${block.type}`);
      // Recursive scan for any field named file_id at any depth
      const seen = new Set();
      const stack = [{ k: "$", v: block }];
      while (stack.length) {
        const { k, v } = stack.pop();
        if (v && typeof v === "object" && !seen.has(v)) {
          seen.add(v);
          for (const [kk, vv] of Object.entries(v)) {
            if (kk === "file_id" && typeof vv === "string") {
              console.log(`        ${k}.${kk} = ${vv}`);
              outputFileId = vv;
            } else if (kk === "type" && typeof vv === "string") {
              console.log(`        ${k}.type = ${vv}`);
            } else if (vv && typeof vv === "object") {
              stack.push({ k: `${k}.${kk}`, v: vv });
            }
          }
        }
      }
      if (block.type === "text") {
        console.log(`        text: "${block.text?.slice(0, 200)}"`);
      }
    }
    console.log(`final output_file_id: ${outputFileId}`);

    if (outputFileId) {
      const meta = await client.beta.files.retrieveMetadata(outputFileId);
      console.log(`file: name=${meta.filename} size=${meta.size_bytes}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
