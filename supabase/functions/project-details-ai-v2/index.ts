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
// x-supabase-api-version). With the echo we never have to chase them.

import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.35.0";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;

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

let cachedAnthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (cachedAnthropic) return cachedAnthropic;
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY missing from env");
  cachedAnthropic = new Anthropic({ apiKey: key });
  return cachedAnthropic;
}

// deno-lint-ignore no-explicit-any
function extractFinalText(content: any[]): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "text") return String(block.text ?? "").trim();
  }
  return "";
}

// Tolerant JSON extraction — Claude usually returns clean JSON but may wrap
// in ```json fences or add stray text. Tries pure parse, fenced parse, then
// first balanced { ... } block.
// deno-lint-ignore no-explicit-any
function extractJson(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { /* fall through */ }
          break;
        }
      }
    }
  }
  throw new Error("Could not extract JSON");
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function draftWithClaude(projectData: Record<string, unknown>): Promise<unknown> {
  const client = getAnthropic();
  const HIDDEN_KEYS = new Set(["is_public","image_url","location_url","created_by","updated_by"]);
  const factSheet: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(projectData)) {
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

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });

  // deno-lint-ignore no-explicit-any
  const text = extractFinalText(response.content as any[]);
  const parsed = extractJson(text);
  const features = Array.isArray(parsed.features) ? parsed.features : [];
  const landmarks = Array.isArray(parsed.landmarks) ? parsed.landmarks : [];
  return {
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
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "missing Bearer token" }, 401, cors);
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anonKey) return json({ error: "server misconfigured" }, 500, cors);
    const sb = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: auth } },
    });
    const body = await req.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    if (!projectId) return json({ error: "projectId missing" }, 400, cors);
    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid token" }, 401, cors);
    const { data: project, error: projErr } = await sb
      .from("records")
      .select("id, model_id, data, created_at")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) return json({ error: 'project read failed: ' + projErr.message }, 500, cors);
    if (!project) return json({ error: "project not found or not readable" }, 404, cors);
    const draft = await draftWithClaude(project.data ?? {});
    return json(draft, 200, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[project-details-ai-v2]", msg);
    return json({ error: msg }, 500, cors);
  }
});
