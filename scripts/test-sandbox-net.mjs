// Test whether the Anthropic code_execution sandbox has outbound internet.
// If it does, we can pre-mint a Supabase signed upload URL and have Claude
// curl-upload the .pptx directly, bypassing Anthropic's flaky Files API.

import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const c = new Anthropic();
  const turn = c.beta.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    betas: ["code-execution-2025-08-25"],
    system: "Run the bash commands the user gives you. Don't add commentary.",
    messages: [
      {
        role: "user",
        content:
          'Run these three bash checks and tell me the output of each:\n' +
          '1) `which curl` (is curl available)\n' +
          '2) `curl -fsS --max-time 5 -o /dev/null -w "httpbin_status=%{http_code}\\n" https://httpbin.org/get` (any external HTTP)\n' +
          '3) `curl -fsS --max-time 5 -o /dev/null -w "supa_status=%{http_code}\\n" https://zhqqsxwealdwqzrbpwyv.supabase.co/storage/v1/health` (Supabase reachable)',
      },
    ],
    tools: [{ type: "code_execution_20250825", name: "code_execution" }],
  });

  for await (const _ of turn) {
    /* drain */
  }
  const r = await turn.finalMessage();
  for (const b of r.content) {
    if (b.type === "bash_code_execution_tool_result") {
      const c = b.content;
      console.log(`rc=${c?.return_code} stdout=${c?.stdout?.trim() ?? ''} stderr=${c?.stderr?.trim() ?? ''}`);
    } else if (b.type === "server_tool_use") {
      console.log(`bash: ${b.input?.command?.slice(0, 200)}`);
    } else if (b.type === "text") {
      console.log(`text: ${b.text?.slice(0, 400)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
