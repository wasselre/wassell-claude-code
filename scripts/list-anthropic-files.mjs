// List recent Anthropic Files API entries to see whether Claude created
// a .pptx during the user's failed run.

import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const client = new Anthropic();
  const files = [];
  for await (const f of client.beta.files.list({ limit: 50 })) {
    files.push(f);
  }
  files.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  for (const f of files.slice(0, 20)) {
    const ageMin = ((Date.now() - new Date(f.created_at).getTime()) / 60000).toFixed(1);
    console.log(`${f.id}  ${ageMin}m  ${f.filename ?? '?'}  ${f.size_bytes ?? '?'}B  ${f.type ?? '?'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
