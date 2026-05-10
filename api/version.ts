/**
 * GET /api/version
 *
 * Returns the deployment's build identifier. The SPA polls this endpoint
 * every minute and compares against the literal `__BUILD_VERSION__`
 * baked into its bundle at build time. On mismatch the app raises a
 * persistent "new version available — reload" banner.
 *
 * No auth — the response is cache-safe metadata about the deployment
 * itself, not user data, and we want it readable from the very first
 * request the SPA makes.
 *
 * No CDN caching — the whole point is for the response to reflect the
 * CURRENT live deploy, not a cached one.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export const config = {
  runtime: 'nodejs',
};

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  // VERCEL_GIT_COMMIT_SHA is injected per deploy. Locally we don't run this
  // (Vite dev doesn't serve /api), so the fallback is mostly defensive.
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev').slice(0, 12);
  const deployedAt = process.env.VERCEL_DEPLOYMENT_CREATED_AT ?? null;
  const body = JSON.stringify({ sha, deployedAt });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  // No edge or browser caching — we always want the live answer.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.end(body);
}
