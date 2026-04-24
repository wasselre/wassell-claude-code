// Outbound webhook helper for the marketing-pipeline agents. Each agent
// keeps its legacy direct DB writes (dual-write mode — phase 3B) AND
// POSTs a structured payload to the app's own /functions/v1/inbox so
// user-editable workflows can react. Once the workflow-driven path is
// proven, the legacy writes can be removed in phase 3D.
//
// Fire-and-forget with EdgeRuntime.waitUntil — same pattern as the
// cross-function invoker in supabase.ts, so the isolate stays alive long
// enough for the fetch to complete even after the agent returns its
// response.

export async function postToInbox(slug: string, payload: Record<string, unknown>): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) {
    console.warn("[postToInbox] SUPABASE_URL missing — skipping webhook POST");
    return;
  }
  const target = `${url.replace(/\/$/, "")}/functions/v1/inbox/${slug}`;
  const p = fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(async (r) => {
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn(`[postToInbox] ${slug} returned ${r.status}: ${text.slice(0, 300)}`);
    }
  }).catch((err) => {
    console.warn(`[postToInbox] ${slug} failed:`, err);
  });
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(p);
  } else {
    await p;
  }
}
