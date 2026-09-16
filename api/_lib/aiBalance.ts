/**
 * aiBalance — ask each provider what is ACTUALLY left in the account.
 *
 * `ai_usage` answers "what did the app spend". It cannot answer "did anything
 * ELSE spend", because a ledger only sees the call sites somebody wired. On
 * 2026-09-15 that gap was measured: the Anthropic console had lost $0.45 while
 * the ledger accounted for $0.02, and the difference was an operator-run
 * calibration batch executed from a laptop — real money, through the same key,
 * invisible to the meter by construction.
 *
 * Comparing our computed remaining against the vendor's own balance is the only
 * check that cannot be fooled by an unwired call site, because it starts from
 * the vendor's number instead of ours.
 *
 * WHY API AND NOT A SCRAPER, where an API exists: a balance endpoint returns a
 * documented number and survives a redesign; a headless browser reading a
 * billing dashboard breaks on a layout change, needs a stored dashboard
 * password, and has to survive SSO and 2FA. Browserbase is reserved for the two
 * providers that genuinely publish no endpoint.
 *
 * Endpoints verified against first-party docs on 2026-09-15 — see each adapter.
 */

export type BalanceSource = 'api' | 'browser' | 'manual';

export interface BalanceProbe {
  provider: string;
  source: BalanceSource;
  status: 'ok' | 'error' | 'unsupported';
  /** Always dollars. Never a converted figure without a cited rate — see CNY note. */
  balanceUsd?: number;
  currency?: string;
  raw?: unknown;
  error?: string;
}

const TIMEOUT_MS = 15_000;

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body is itself the diagnosis (an HTML login page, a proxy
      // error). Keep the text so the recorded error says what came back.
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * DeepSeek — GET https://api.deepseek.com/user/balance
 * Docs: api-docs.deepseek.com/api/get-user-balance (read 2026-09-15)
 *
 * Returns `balance_infos[]`, one entry per currency, each a DECIMAL STRING.
 * An account can report CNY. We pick the USD entry; if there is only CNY we
 * record an error rather than converting — the same rule the price book
 * follows, that a number you cannot cite is worse than no number.
 */
async function probeDeepseek(): Promise<BalanceProbe> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) return { provider: 'deepseek', source: 'api', status: 'error', error: 'DEEPSEEK_API_KEY is not set' };

  const r = await getJson('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}` });
  if (!r.ok) {
    return { provider: 'deepseek', source: 'api', status: 'error', error: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
  }
  const infos = (r.body as { balance_infos?: Array<Record<string, unknown>> } | null)?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return { provider: 'deepseek', source: 'api', status: 'error', raw: r.body, error: 'response carried no balance_infos' };
  }
  const usd = infos.find((i) => String(i.currency).toUpperCase() === 'USD');
  if (!usd) {
    const currencies = infos.map((i) => String(i.currency)).join(', ');
    return {
      provider: 'deepseek', source: 'api', status: 'error', raw: r.body,
      error: `balance reported only in ${currencies}; refusing to convert without a cited FX rate`,
    };
  }
  const total = num(usd.total_balance);
  if (total === null) {
    return { provider: 'deepseek', source: 'api', status: 'error', raw: r.body, error: 'total_balance was not a number' };
  }
  return { provider: 'deepseek', source: 'api', status: 'ok', balanceUsd: total, currency: 'USD', raw: r.body };
}

/**
 * Moonshot / Kimi — GET https://api.moonshot.ai/v1/users/me/balance
 * Docs: platform.kimi.ai/docs/api/balance (read 2026-09-15)
 *
 * `data.available_balance` is USD and already includes vouchers + cash.
 * `cash_balance` may legitimately be negative, which is why we read the
 * available figure rather than summing the parts.
 */
async function probeMoonshot(): Promise<BalanceProbe> {
  const key = process.env.KIMI_API_KEY?.trim();
  if (!key) return { provider: 'moonshot', source: 'api', status: 'error', error: 'KIMI_API_KEY is not set' };

  const base = (process.env.KIMI_BASE_URL || 'https://api.moonshot.ai').replace(/\/anthropic\/?$/, '').replace(/\/$/, '');
  const r = await getJson(`${base}/v1/users/me/balance`, { Authorization: `Bearer ${key}` });
  if (!r.ok) {
    return { provider: 'moonshot', source: 'api', status: 'error', error: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
  }
  const body = r.body as { code?: number; data?: Record<string, unknown> } | null;
  if (!body || body.code !== 0 || !body.data) {
    return { provider: 'moonshot', source: 'api', status: 'error', raw: r.body, error: `non-zero code in response: ${r.text.slice(0, 200)}` };
  }
  const avail = num(body.data.available_balance);
  if (avail === null) {
    return { provider: 'moonshot', source: 'api', status: 'error', raw: r.body, error: 'available_balance was not a number' };
  }
  return { provider: 'moonshot', source: 'api', status: 'ok', balanceUsd: avail, currency: 'USD', raw: r.body };
}

/**
 * fal — GET https://api.fal.ai/v1/account/billing?expand=credits
 * Docs: fal.ai/docs/platform-apis/v1/account/billing (read 2026-09-15)
 *
 * NOTE the header form: `Authorization: Key <k>`, not Bearer. The docs call for
 * an ADMIN key; a plain model key may be refused, which surfaces as a 401/403
 * with the vendor's own wording rather than a silent zero.
 */
async function probeFal(): Promise<BalanceProbe> {
  // FAL_ADMIN_KEY first, FAL_KEY only as a fallback. These are DIFFERENT
  // credentials and the distinction is load-bearing: measured 2026-09-16, the
  // model key that runs every image lane gets HTTP 403 from the billing
  // endpoint, which wants an admin key. Never replace FAL_KEY with the admin
  // key to "simplify" — the generation lanes depend on it, and swapping them
  // trades a missing balance reading for broken image generation.
  const key = (process.env.FAL_ADMIN_KEY || process.env.FAL_KEY)?.trim();
  if (!key) return { provider: 'fal', source: 'api', status: 'error', error: 'neither FAL_ADMIN_KEY nor FAL_KEY is set' };
  if (key === 'stub') return { provider: 'fal', source: 'api', status: 'error', error: 'the fal key is the offline stub' };

  const r = await getJson('https://api.fal.ai/v1/account/billing?expand=credits', { Authorization: `Key ${key}` });
  if (!r.ok) {
    const hint = r.status === 401 || r.status === 403
      ? ' (the billing endpoint wants an ADMIN fal key in FAL_ADMIN_KEY; the FAL_KEY model key cannot read it)'
      : '';
    return { provider: 'fal', source: 'api', status: 'error', error: `HTTP ${r.status}${hint}: ${r.text.slice(0, 200)}` };
  }
  const credits = (r.body as { credits?: Record<string, unknown> } | null)?.credits;
  const bal = num(credits?.current_balance);
  if (bal === null) {
    return { provider: 'fal', source: 'api', status: 'error', raw: r.body, error: 'no credits.current_balance in response (was ?expand=credits honoured?)' };
  }
  const currency = String(credits?.currency ?? 'USD').toUpperCase();
  if (currency !== 'USD') {
    return { provider: 'fal', source: 'api', status: 'error', raw: r.body, error: `balance reported in ${currency}; refusing to convert without a cited FX rate` };
  }
  return { provider: 'fal', source: 'api', status: 'ok', balanceUsd: bal, currency: 'USD', raw: r.body };
}

/**
 * Providers with NO balance endpoint. These report `unsupported` on purpose so
 * the page can say "we cannot check this one yet" instead of leaving a blank
 * that reads like agreement.
 *
 *  anthropic — the Console shows "Credits $x.xx" and nothing serves it. The
 *              Admin API would be the proper source but is unavailable to
 *              individual accounts entirely (CLAUDE.md, "Every AI call is
 *              metered" rule 13).
 *  modal     — usage-billed rather than prepaid; there is no credit balance to
 *              read, only an accruing invoice.
 */
function unsupported(provider: string, why: string): BalanceProbe {
  return { provider, source: 'api', status: 'unsupported', error: why };
}

export const BALANCE_ADAPTERS: Record<string, () => Promise<BalanceProbe>> = {
  deepseek: probeDeepseek,
  moonshot: probeMoonshot,
  fal: probeFal,
  anthropic: async () =>
    unsupported('anthropic', 'no balance endpoint exists; the Console shows credits and the Admin API is closed to individual accounts — needs a browser probe'),
  modal: async () =>
    unsupported('modal', 'usage-billed, not prepaid: there is no credit balance to read — needs a browser probe of the invoice'),
};

/**
 * Probe every provider. Settled independently: one provider being down, rate
 * limited or misconfigured must never stop the others from being checked, and
 * the failure is recorded as a row so a provider that has silently stopped
 * answering is visible rather than merely absent.
 */
export async function probeAllBalances(): Promise<BalanceProbe[]> {
  const entries = Object.entries(BALANCE_ADAPTERS);
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn()));
  return settled.map((s, i) => {
    const provider = entries[i]![0];
    if (s.status === 'fulfilled') return s.value;
    const reason = s.reason instanceof Error ? `${s.reason.name}: ${s.reason.message}` : String(s.reason);
    return { provider, source: 'api' as const, status: 'error' as const, error: reason };
  });
}
