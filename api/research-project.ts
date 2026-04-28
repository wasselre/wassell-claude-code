/**
 * POST /api/research-project
 *
 * Fires the Claude Code "research project" routine for one All Projects
 * record. The browser sends `{ project_name, location }` and this route
 * forwards a plain-text trigger message to the routine's /fire endpoint
 * with the long-lived OAuth token in the Authorization header.
 *
 * The routine itself is configured at console.anthropic.com → Routines.
 * Its trigger URL and token live in env vars (CLAUDE_ROUTINE_URL +
 * CLAUDE_ROUTINE_TOKEN) and never reach the browser.
 *
 * Failure modes are surfaced via JSON errors — the caller renders a toast.
 */

import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

interface RequestBody {
  project_name?: string;
  location?: string;
  record_id?: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const projectName = (body.project_name ?? '').trim();
    const location = (body.location ?? '').trim();
    if (!projectName) return jsonError(400, 'project_name is required');
    if (!location) return jsonError(400, 'location is required');

    const url = process.env.CLAUDE_ROUTINE_URL;
    const token = process.env.CLAUDE_ROUTINE_TOKEN;
    if (!url) return jsonError(500, 'CLAUDE_ROUTINE_URL is not configured');
    if (!token) return jsonError(500, 'CLAUDE_ROUTINE_TOKEN is not configured');

    // Format matches the routine's documented INPUT contract:
    //   PROJECT: <name>
    //   LOCATION: <url>
    const triggerMessage = `PROJECT: ${projectName}\nLOCATION: ${location}`;

    let routineRes: Response;
    try {
      routineRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          // Required by the Claude Code routines API. Probed against
          // /fire on 2026-04-28 — the endpoint validates body keys
          // strictly (only `text` is accepted) and gates non-beta
          // callers with "this API is in beta".
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ text: triggerMessage }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Routine request failed: ${msg}`);
    }

    if (!routineRes.ok) {
      const text = await routineRes.text().catch(() => '');
      return jsonError(
        routineRes.status,
        `Routine returned ${routineRes.status}: ${text.slice(0, 500)}`,
      );
    }

    let result: unknown = null;
    try {
      result = await routineRes.json();
    } catch {
      // Routine may return an empty body on success — treat as ok.
      result = null;
    }

    return jsonOk({ ok: true, routine: result });
  });
}
