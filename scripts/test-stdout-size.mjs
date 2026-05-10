// Test how large a single bash stdout can be in code_execution.
// If Anthropic returns the full 250KB base64 of a 200KB file, we can
// use stdout as the return channel (since Files API and sandbox internet
// are both unreliable / unavailable).

import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const c = new Anthropic();
  const turn = c.beta.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    betas: ["code-execution-2025-08-25"],
    system: "Run the bash command the user asks. No commentary, no analysis.",
    messages: [
      {
        role: "user",
        content:
          "Run exactly this bash command and report what you observe (don't truncate or summarize):\n" +
          "`python3 -c \"import os, base64; data=os.urandom(200_000); print('===B64START==='); print(base64.b64encode(data).decode()); print('===B64END===')\" | wc -c`\n" +
          "Then run the same command WITHOUT the wc -c to see the raw output: `python3 -c \"import os, base64; data=os.urandom(200_000); print('===B64START==='); print(base64.b64encode(data).decode()); print('===B64END===')\"`",
      },
    ],
    tools: [{ type: "code_execution_20250825", name: "code_execution" }],
  });

  for await (const _ of turn) { /* drain */ }
  const r = await turn.finalMessage();
  for (let i = 0; i < r.content.length; i++) {
    const b = r.content[i];
    if (b.type === "bash_code_execution_tool_result") {
      const cc = b.content;
      const stdoutLen = (cc?.stdout ?? "").length;
      const stderrLen = (cc?.stderr ?? "").length;
      const startsWithMarker = (cc?.stdout ?? "").includes("===B64START===");
      const endsWithMarker = (cc?.stdout ?? "").includes("===B64END===");
      console.log(`[${i}] bash rc=${cc?.return_code} stdout_len=${stdoutLen} stderr_len=${stderrLen} hasStart=${startsWithMarker} hasEnd=${endsWithMarker}`);
      console.log(`    stdout_first_80=${(cc?.stdout ?? '').slice(0, 80).replace(/\n/g, '\\n')}`);
      console.log(`    stdout_last_80=${(cc?.stdout ?? '').slice(-80).replace(/\n/g, '\\n')}`);
    } else if (b.type === "server_tool_use") {
      console.log(`[${i}] bash command: ${(b.input?.command ?? '').slice(0, 200)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
