// ============================================================================
// Bridge from the W-AI role adapter (worker/src/ai) to the narrow `CvAi`
// interface the cv modules code against. Production passes `{ sb }` so
// mos_settings.ai_roles is honoured (resolveRoles caches 60 s); tests inject a
// fake CvAi and never touch this file.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRole, embed, type AiContext } from '../../ai/index.js';
import type { CallRoleInput, CallRoleResult, CvAi, EmbedInput, EmbedResult, RoleKey } from './types.js';

export function makeCvAi(sb: SupabaseClient): CvAi {
  const ctx: AiContext = { sb };
  return {
    async callRole<T>(role: RoleKey, input: CallRoleInput): Promise<CallRoleResult<T>> {
      const r = await callRole<T>(role, {
        system: input.system,
        user: input.user,
        images: input.images?.map((im) => (im.base64 !== undefined ? { base64: im.base64, mime: im.mime } : { url: im.url ?? '', mime: im.mime })),
        schema: input.schema,
        cache: input.cache,
      }, ctx);
      return { output: r.output, usage: { in: r.usage.in, out: r.usage.out }, cost_usd: r.cost_usd, provider: r.provider, model: r.model, version: r.version, latency_ms: r.latency_ms };
    },
    async embed(role: RoleKey, input: EmbedInput): Promise<EmbedResult> {
      const r = await embed(role, input, ctx);
      return { vectors: r.vectors, model: r.model, version: r.version, dim: r.dim };
    },
  };
}
