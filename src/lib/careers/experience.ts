/**
 * Browser client for the per-candidate recruitment-experience link.
 *
 * Fails soft on purpose: the experience must still render in local dev (no /api)
 * and in internal preview (`/careers/experience/preview`) where the token does
 * not resolve to a real application. A null / false result → demo mode, never a
 * broken page.
 */
export interface InviteInfo {
  name: string;
  phone: string;                                   // display form, e.g. 05XXXXXXXX
  decision: 'interested' | 'declined' | null;
  status: string;
}

/** Resolve a link token → candidate name/phone. null = unknown token / demo. */
export async function resolveInvite(token: string): Promise<InviteInfo | null> {
  if (!token || token === 'preview') return null;
  try {
    const r = await fetch(`/api/careers/experience?token=${encodeURIComponent(token)}`);
    if (!r.ok) return null;
    return (await r.json()) as InviteInfo;
  } catch {
    return null;
  }
}

/** Record confirm / interested / declined against the application. Best-effort. */
export async function postExperience(
  token: string,
  action: 'confirm' | 'interested' | 'declined',
  reason?: string,
): Promise<boolean> {
  if (!token || token === 'preview') return false;
  try {
    const r = await fetch('/api/careers/experience', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action, reason }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
