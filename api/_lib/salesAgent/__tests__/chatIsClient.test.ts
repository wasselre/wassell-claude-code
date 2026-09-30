import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatIsClient } from '../conversation';

const CLIENT = '2b7c2692-2bb9-4229-a25b-1623419c467d';

/** A service client whose chat record carries `link` and whose phone matcher returns `match`. */
function fake(link: unknown, match: unknown, opts: { readError?: boolean; rpcError?: boolean } = {}) {
  const rpc = vi.fn(async () => (opts.rpcError ? { data: null, error: { message: 'boom' } } : { data: match, error: null }));
  const svc = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (opts.readError ? { data: null, error: { message: 'boom' } } : { data: { client_link: link }, error: null }) }) }) }),
    rpc,
  } as unknown as SupabaseClient;
  return { svc, rpc };
}

describe('chatIsClient — the agent answers clients only', () => {
  it('a chat linked to a client is a client chat (no phone lookup needed)', async () => {
    const { svc, rpc } = fake(CLIENT, null);
    expect(await chatIsClient(svc, '966500000001@c.us')).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('an unlinked chat whose phone matches a client is a client chat', async () => {
    expect(await chatIsClient(fake(null, CLIENT).svc, '966500000001@c.us')).toBe(true);
  });
  it('a contact / officer / unknown number (no client) is not', async () => {
    expect(await chatIsClient(fake(null, null).svc, '966500000001@c.us')).toBe(false);
  });
  it('a group or a LID-only chat is never a client chat', async () => {
    expect(await chatIsClient(fake(null, CLIENT).svc, '120363407863381873@g.us')).toBe(false);
  });
  it('fails closed on a read or match error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await chatIsClient(fake(CLIENT, null, { readError: true }).svc, '966500000001@c.us')).toBe(false);
    expect(await chatIsClient(fake(null, CLIENT, { rpcError: true }).svc, '966500000001@c.us')).toBe(false);
  });
});
