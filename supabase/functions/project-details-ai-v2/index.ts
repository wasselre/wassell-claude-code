// Project Details AI — drafts the editorial fields for a project's public
// detail page (description, short hero copy, features, nearby landmarks)
// based on what the admin already entered on the all_projects record.
//
// Called from src/lib/projectDetailsAi.ts → ProjectDetailsBridgePage when
// the admin chooses "Draft with AI" while creating a new project_details
// sidecar. Returns strict JSON the bridge page maps onto the new record's
// fields before opening the standard editor for review.
//
// Slug is `project-details-ai-v2` because the v1 slug got stuck in a
// Supabase platform deploy-error state — versions are owned by Supabase,
// not git, so the v2 name is the durable contract.
//
// CORS: dynamic — echoes whatever headers the browser asks for in
// `Access-Control-Request-Headers`. Static allow-lists were repeatedly
// broken by supabase-js adding new headers (apikey, x-client-info,
// x-supabase-api-version). The echo means we never have to chase them.
//
// Error reporting: every failure path returns `{ error, step }` with the
// specific step that blew up (parse_auth, read_env, create_client,
// parse_body, verify_user, read_project, call_claude, parse_response).
// The frontend wrapper (src/lib/projectDetailsAi.ts) extracts this from
// FunctionsHttpError.context and surfaces it instead of the generic
// "Edge Function returned a non-2xx status code" toast.

import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.35.0";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;

// Writing/translation routing (user decision 2026-07-18): Qwen3 30B on
// Cloudflare Workers AI is the PRIMARY writer; Claude stays as the fallback
// on any Qwen failure (quota/rate-limit/timeout/garbage). Mirrors
// api/_lib/textLlm.ts (this Deno function can't import it). Kill switch:
// TEXT_LLM_PROVIDER=anthropic.
const QWEN_MODEL_DEFAULT = "@cf/qwen/qwen3-30b-a3b-fp8";
const QWEN_MAX_TOKENS = 4096;

/** Remove Qwen3 <think>…</think> reasoning blocks (incl. an unclosed one). */
function stripThink(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/g, "")
    .trim();
}

/** One Qwen chat call via Cloudflare's OpenAI-compatible endpoint. Throws on any failure. */
async function qwenChat(accountId: string, apiToken: string, system: string, user: string): Promise<string> {
  const model = Deno.env.get("CLOUDFLARE_AI_MODEL") || QWEN_MODEL_DEFAULT;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: QWEN_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`cloudflare ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) throw new Error("qwen returned no content");
  const text = stripThink(content);
  if (!text) throw new Error("qwen returned only a think block");
  return text;
}

function buildCorsHeaders(req: Request): Record<string, string> {
  const requested = req.headers.get("access-control-request-headers");
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": requested || "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

// Mirror the curated icon options from migration
// 2026-05-10_b_project_details_model.sql. Claude must pick from these
// exact slugs — anything else falls through to the website's fallback dot.
const FEATURE_ICONS = ["building","home","car","smart_home","ac","camera","key","facade","bed","box","sparkle","elevator","shield","wifi","pool","gym"];
const LANDMARK_ICONS = ["metro","road","shop","school","hospital","park","mosque","airport","restaurant","gas","pin"];

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed", step: "method" }, 405, cors);

  let step = "start";
  try {
    step = "parse_auth";
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "missing Bearer token", step }, 401, cors);

    step = "read_env";
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!url) return json({ error: "SUPABASE_URL missing", step }, 500, cors);
    if (!anonKey) return json({ error: "SUPABASE_ANON_KEY missing", step }, 500, cors);
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY missing", step }, 500, cors);

    step = "create_client";
    const sb = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: auth } },
    });

    step = "parse_body";
    const body = await req.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    if (!projectId) return json({ error: "projectId missing", step }, 400, cors);

    step = "verify_user";
    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr) return json({ error: "auth.getUser failed: " + userErr.message, step }, 401, cors);
    if (!userData?.user) return json({ error: "no user in token", step }, 401, cors);

    step = "read_project";
    const { data: project, error: projErr } = await sb
      .from("records")
      .select("id, model_id, data, created_at")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) return json({ error: "project read failed: " + projErr.message, step, code: projErr.code, hint: projErr.hint }, 500, cors);
    if (!project) return json({ error: "project not found", step, projectId }, 404, cors);

    step = "call_claude";
    const client = new Anthropic({ apiKey: anthropicKey });
    const HIDDEN_KEYS = new Set(["is_public","image_url","location_url","created_by","updated_by"]);
    const factSheet: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(project.data ?? {})) {
      if (HIDDEN_KEYS.has(k)) continue;
      if (v === null || v === undefined || v === "") continue;
      factSheet[k] = v;
    }
    const system = [
      'You are a real-estate marketing copywriter for Wassel Real Estate, Riyadh, Saudi Arabia.',
      'Write in formal Arabic only. Tone: refined, confident, professional.',
      'Never invent numbers or facts not in the project data.',
      'Each project must read distinctly.',
      'Feature icons must come from: ' + FEATURE_ICONS.join(', '),
      'Landmark icons must come from: ' + LANDMARK_ICONS.join(', '),
      'Distances may be reasonable estimates; add تقريباً when uncertain.',
      'Return ONLY valid JSON — no preamble.',
    ].join('\n');
    const user = [
      'بيانات المشروع:',
      '```json',
      JSON.stringify(factSheet, null, 2),
      '```',
      '',
      'اكتب JSON بهذا الشكل:',
      '{',
      '  "hero_short_description": "جملة واحدة (20–30 كلمة)",',
      '  "description": "ثلاث فقرات مفصولة بسطرين فارغين",',
      '  "features": [{"icon":"<من القائمة>","title":"...","description":"..."}],',
      '  "landmarks": [{"icon":"<من القائمة>","name":"...","distance":"0.8 كم"}]',
      '}',
      '',
      'features: 8–12 عنصر. landmarks: 5–8 عناصر.',
    ].join('\n');

    let text = "";

    // ── Primary: Qwen on Cloudflare Workers AI ─────────────────────────
    const cfAccount = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") ?? "";
    const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN") ?? "";
    const qwenOn =
      (Deno.env.get("TEXT_LLM_PROVIDER") ?? "").trim().toLowerCase() !== "anthropic" &&
      cfAccount !== "" && cfToken !== "";
    if (qwenOn) {
      try {
        text = await qwenChat(cfAccount, cfToken, system, user);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[project-details-ai-v2] qwen failed — falling back to Anthropic: ${m}`);
      }
    }

    // ── Fallback: Claude (original path, unchanged) ────────────────────
    if (!text) {
      const response = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      });
      // deno-lint-ignore no-explicit-any
      const content = response.content as any[];
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (block.type === "text") { text = String(block.text ?? "").trim(); break; }
      }
    }

    step = "parse_response";

    // deno-lint-ignore no-explicit-any
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* fall through */ }
    if (!parsed) {
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) { try { parsed = JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
    }
    if (!parsed) {
      const start = text.indexOf("{");
      if (start !== -1) {
        let depth = 0;
        for (let i = start; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") {
            depth--;
            if (depth === 0) {
              try { parsed = JSON.parse(text.slice(start, i + 1)); } catch { /* fall through */ }
              break;
            }
          }
        }
      }
    }
    if (!parsed) return json({ error: "Could not extract JSON from Claude response", step, first_300: text.slice(0, 300) }, 500, cors);

    const features = Array.isArray(parsed.features) ? parsed.features : [];
    const landmarks = Array.isArray(parsed.landmarks) ? parsed.landmarks : [];
    return json({
      hero_short_description: String(parsed.hero_short_description || '').trim(),
      description: String(parsed.description || '').trim(),
      // deno-lint-ignore no-explicit-any
      features: features.slice(0, 12).map((f: any) => ({
        icon: FEATURE_ICONS.includes(String(f.icon)) ? String(f.icon) : 'sparkle',
        title: String(f.title || '').trim(),
        description: String(f.description || '').trim(),
      // deno-lint-ignore no-explicit-any
      })).filter((f: any) => f.title),
      // deno-lint-ignore no-explicit-any
      landmarks: landmarks.slice(0, 10).map((l: any) => ({
        icon: LANDMARK_ICONS.includes(String(l.icon)) ? String(l.icon) : 'pin',
        name: String(l.name || '').trim(),
        distance: String(l.distance || '').trim(),
      // deno-lint-ignore no-explicit-any
      })).filter((l: any) => l.name),
    }, 200, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[project-details-ai-v2] step=" + step + " error=" + msg + (stack ? "\n" + stack : ""));
    return json({ error: msg, step, stack: stack?.split('\n').slice(0, 5).join('\n') }, 500, cors);
  }
});
