/**
 * A tiny cookie-keeping HTTP session for server-rendered broker portals
 * (Laravel: GET login → CSRF token + session cookie → POST credentials →
 * the session cookie is the login). No browser: the Riva portal is a plain
 * form login with no captcha, so a headless browser would only add cost.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export class PortalBlockedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PortalBlockedError';
  }
}

export class HttpSession {
  private jar = new Map<string, string>();
  constructor(private readonly origin: string, private readonly timeoutMs = 45_000) {}

  private store(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const kv = c.split(';')[0] ?? '';
      const i = kv.indexOf('=');
      if (i <= 0) continue;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (/;\s*max-age=0/i.test(c) || v === '' || v === 'deleted') this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** One request; follows redirects by hand so every hop's cookies are kept. */
  async request(
    pathOrUrl: string,
    init: { method?: 'GET' | 'POST'; form?: Record<string, string>; referer?: string } = {},
  ): Promise<{ status: number; url: string; text: string }> {
    let url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.origin}${pathOrUrl}`;
    let method = init.method ?? 'GET';
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined;
    for (let hop = 0; hop < 6; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.8',
      };
      const ck = this.cookieHeader();
      if (ck) headers.Cookie = ck;
      if (init.referer) headers.Referer = init.referer;
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, redirect: 'manual', signal: ctl.signal });
      } finally {
        clearTimeout(t);
      }
      this.store(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        method = 'GET';
        body = undefined;
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      const text = await res.text();
      if ((res.status === 403 || res.status === 503) && /cloudflare|cf-chl|challenge-platform/i.test(text)) {
        throw new PortalBlockedError(`${url} answered ${res.status} with a Cloudflare challenge`);
      }
      return { status: res.status, url, text };
    }
    throw new Error(`too many redirects from ${pathOrUrl}`);
  }
}

export { UA as BROWSER_UA };
