// ============================================================================
// Meta (Facebook/Instagram) Marketing API client — OUR OWN ad account.
// ----------------------------------------------------------------------------
// This is NOT the Meta Ad Library scraper (that's competitor intelligence, via
// Apify, in worker/src/marketing/metaAdsLifecycle.ts). This client authenticates
// with a System User token and reads/writes the Wassel ad account:
//
//   Campaign  → GET/POST /act_<id>/campaigns
//   Ad Set    → GET/POST /act_<id>/adsets
//   Ad        → GET/POST /act_<id>/ads
//   Creative  → POST     /act_<id>/adcreatives
//   Insights  → GET      /<node>/insights
//
// Field reference: docs/reference/ad-platforms/meta.md (ODAX era, v25–v26).
//
// Convention (mirrors worker/src/env.ts optional secrets): loadMetaConfig()
// returns null when the token or ad-account id is absent, so every caller
// self-disables cleanly until the credentials exist — deploying this code is a
// no-op for the account until META_SYSTEM_USER_TOKEN is set.
//
// This module is the CANONICAL copy. The worker is a standalone package and
// cannot import from api/_lib; when the read-sync lane moves into the worker it
// gets a verbatim copy (same posture as worker/src/imageGen.ts). Change both.
// ============================================================================

const DEFAULT_GRAPH_VERSION = 'v21.0';

export interface MetaConfig {
  appId: string;
  appSecret: string;
  /** Long-lived System User token with ads_read + ads_management. */
  token: string;
  /** Numeric ad account id WITHOUT the act_ prefix. */
  adAccountId: string;
  /** Facebook Page id — every creative runs from a page. */
  pageId: string | null;
  /** Instagram account id for IG delivery / IG-identity creatives. */
  instagramId: string | null;
  graphVersion: string;
}

/**
 * Build the config from env. Returns null when the token or ad-account id is
 * missing, so callers can self-disable (feature is inert until credentials
 * exist). App id/secret are only needed for appsecret_proof + token debug.
 */
export function loadMetaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const token = env.META_SYSTEM_USER_TOKEN?.trim();
  const adAccountId = env.META_AD_ACCOUNT_ID?.trim();
  if (!token || !adAccountId) return null;
  return {
    appId: env.META_APP_ID?.trim() ?? '',
    appSecret: env.META_APP_SECRET?.trim() ?? '',
    token,
    adAccountId: adAccountId.replace(/^act_/, ''),
    pageId: env.META_PAGE_ID?.trim() || null,
    instagramId: env.META_INSTAGRAM_ID?.trim() || null,
    graphVersion: env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION,
  };
}

/** A Graph API error, carrying Meta's structured error payload for logging. */
export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    readonly fbtraceId: string | null,
    readonly httpStatus: number,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
  /** Transient errors worth a retry: rate limits (#4/#17/#32/#613) + 5xx. */
  get isTransient(): boolean {
    if (this.httpStatus >= 500) return true;
    return [4, 17, 32, 613, 80000, 80004].includes(this.code ?? -1);
  }
}

export class MetaMarketingClient {
  private readonly base: string;
  constructor(private readonly cfg: MetaConfig) {
    this.base = `https://graph.facebook.com/${cfg.graphVersion}`;
  }

  /**
   * appsecret_proof hardens calls against a stolen token (Meta best practice).
   * Uses Web Crypto (SubtleCrypto) so the client is runtime-agnostic — it works
   * unchanged on the Vercel EDGE runtime (marketing-os.ts), the Node API
   * runtime, and the Fly worker. node:crypto would break the Edge bundle.
   */
  private async proof(): Promise<string | null> {
    if (!this.cfg.appSecret) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(this.cfg.appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(this.cfg.token));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private async authParams(): Promise<Record<string, string>> {
    const p: Record<string, string> = { access_token: this.cfg.token };
    const proof = await this.proof();
    if (proof) p.appsecret_proof = proof;
    return p;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.base}/${path.replace(/^\//, '')}`;
    const auth = await this.authParams();
    let res: Response;
    if (method === 'GET') {
      const qs = new URLSearchParams(auth);
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      res = await fetch(`${url}?${qs.toString()}`, { method: 'GET' });
    } else {
      const body = new URLSearchParams(auth);
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new MetaApiError(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`, null, null, null, null, res.status, text);
    }
    if (!res.ok || (json as { error?: unknown }).error) {
      const e = (json as { error?: Record<string, unknown> }).error ?? {};
      throw new MetaApiError(
        String(e.message ?? `Graph ${method} ${path} failed (${res.status})`),
        typeof e.code === 'number' ? e.code : null,
        typeof e.error_subcode === 'number' ? e.error_subcode : null,
        typeof e.type === 'string' ? e.type : null,
        typeof e.fbtrace_id === 'string' ? e.fbtrace_id : null,
        res.status,
        json,
      );
    }
    return json as T;
  }

  /** GET a paginated edge, following cursors until exhausted (or maxPages). */
  private async getAll<T>(
    path: string,
    params: Record<string, unknown>,
    maxPages = 50,
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const resp = await this.request<{ data: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        'GET',
        path,
        { ...params, limit: 200, ...(after ? { after } : {}) },
      );
      if (Array.isArray(resp.data)) out.push(...resp.data);
      const next = resp.paging?.cursors?.after;
      if (!next || !resp.paging?.next) break;
      after = next;
    }
    return out;
  }

  private get act(): string {
    return `act_${this.cfg.adAccountId}`;
  }

  // ----- Health / debug -----------------------------------------------------

  /** Reads the ad account — cheapest proof the token can see the account. */
  async getAdAccount(): Promise<MetaAdAccount> {
    return this.request<MetaAdAccount>('GET', this.act, {
      fields: 'id,name,currency,account_status,timezone_name,amount_spent,business_name',
    });
  }

  // ----- READ: campaign tree ------------------------------------------------

  async listCampaigns(): Promise<MetaCampaign[]> {
    return this.getAll<MetaCampaign>(`${this.act}/campaigns`, {
      fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,buying_type,special_ad_categories,start_time,stop_time,created_time,updated_time',
    });
  }

  async listAdSets(): Promise<MetaAdSet[]> {
    return this.getAll<MetaAdSet>(`${this.act}/adsets`, {
      fields: 'id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,destination_type,promoted_object,targeting,start_time,end_time,created_time,updated_time',
    });
  }

  async listAds(): Promise<MetaAd[]> {
    return this.getAll<MetaAd>(`${this.act}/ads`, {
      fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,object_story_id},created_time,updated_time',
    });
  }

  /**
   * Saved Audiences the buyer built in Ads Manager — the Option-B source for an
   * ad set's targeting. Each carries its full `targeting` spec, which we cache
   * on the linked Wassel audience and send verbatim as the ad set targeting.
   */
  async listSavedAudiences(): Promise<MetaSavedAudience[]> {
    return this.getAll<MetaSavedAudience>(`${this.act}/saved_audiences`, {
      fields: 'id,name,targeting,approximate_count_lower_bound,approximate_count_upper_bound',
    });
  }

  /**
   * Insights for the whole account at a given level, one row per entity.
   * level: 'campaign' | 'adset' | 'ad'. date_preset defaults to lifetime.
   */
  async getInsights(level: MetaInsightLevel, datePreset = 'maximum'): Promise<MetaInsightRow[]> {
    return this.getAll<MetaInsightRow>(`${this.act}/insights`, {
      level,
      date_preset: datePreset,
      fields: 'campaign_id,adset_id,ad_id,spend,impressions,clicks,inline_link_clicks,actions,cost_per_action_type,reach,frequency',
    });
  }

  // ----- WRITE (ads_management) --------------------------------------------
  // Every write accepts validateOnly → Meta's execution_options:["validate_only"]
  // so a "check" button can dry-run without creating anything or spending.

  async createCampaign(input: Record<string, unknown>, validateOnly = false): Promise<{ id: string }> {
    return this.request('POST', `${this.act}/campaigns`, this.withValidate(input, validateOnly));
  }

  async createAdSet(input: Record<string, unknown>, validateOnly = false): Promise<{ id: string }> {
    return this.request('POST', `${this.act}/adsets`, this.withValidate(input, validateOnly));
  }

  async createAdCreative(input: Record<string, unknown>): Promise<{ id: string }> {
    return this.request('POST', `${this.act}/adcreatives`, input);
  }

  async createAd(input: Record<string, unknown>, validateOnly = false): Promise<{ id: string }> {
    return this.request('POST', `${this.act}/ads`, this.withValidate(input, validateOnly));
  }

  /** Update a node's mutable fields (status, budget, name…). id = node id. */
  async updateNode(id: string, input: Record<string, unknown>): Promise<{ success: boolean }> {
    return this.request('POST', id, input);
  }

  /** Set ACTIVE / PAUSED on any campaign/adset/ad node. */
  async setStatus(id: string, status: 'ACTIVE' | 'PAUSED'): Promise<{ success: boolean }> {
    return this.updateNode(id, { status });
  }

  /** Delete a node (campaign/adset/ad). Deleting a campaign cascades to its ad
   *  sets in Meta — used to roll back a partially-built push. */
  async deleteNode(id: string): Promise<{ success: boolean }> {
    const auth = await this.authParams();
    const qs = new URLSearchParams(auth);
    const res = await fetch(`${this.base}/${id.replace(/^\//, '')}?${qs.toString()}`, { method: 'DELETE' });
    const text = await res.text();
    let json: unknown = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* Graph returns {"success":true}; tolerate empty. */ }
    if (!res.ok || (json as { error?: unknown }).error) {
      const e = (json as { error?: Record<string, unknown> }).error ?? {};
      throw new MetaApiError(
        String(e.message ?? `Graph DELETE ${id} failed (${res.status})`),
        typeof e.code === 'number' ? e.code : null,
        typeof e.error_subcode === 'number' ? e.error_subcode : null,
        typeof e.type === 'string' ? e.type : null,
        typeof e.fbtrace_id === 'string' ? e.fbtrace_id : null,
        res.status,
        json,
      );
    }
    return { success: true };
  }

  private withValidate(input: Record<string, unknown>, validateOnly: boolean): Record<string, unknown> {
    return validateOnly ? { ...input, execution_options: ['validate_only'] } : input;
  }
}

// ----- Raw Graph response shapes (only the fields we request) ---------------

export interface MetaAdAccount {
  id: string;
  name: string;
  currency: string;
  account_status: number;
  timezone_name?: string;
  amount_spent?: string;
  business_name?: string;
}

export interface MetaCampaign {
  id: string;
  name: string;
  objective: string;
  status: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  buying_type?: string;
  special_ad_categories?: string[];
  start_time?: string;
  stop_time?: string;
  created_time?: string;
  updated_time?: string;
}

export interface MetaAdSet {
  id: string;
  name: string;
  campaign_id: string;
  status: string;
  effective_status?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  bid_amount?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  destination_type?: string;
  promoted_object?: Record<string, unknown>;
  targeting?: Record<string, unknown>;
  start_time?: string;
  end_time?: string;
  created_time?: string;
  updated_time?: string;
}

export interface MetaAd {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: string;
  effective_status?: string;
  creative?: { id: string; name?: string; object_story_id?: string };
  created_time?: string;
  updated_time?: string;
}

export interface MetaSavedAudience {
  id: string;
  name: string;
  targeting?: Record<string, unknown>;
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
}

export type MetaInsightLevel = 'campaign' | 'adset' | 'ad';

export interface MetaInsightRow {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  reach?: string;
  frequency?: string;
  actions?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
}

/** Pull lead count out of the insights `actions` array (leadgen + messaging). */
export function leadsFromActions(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions) return 0;
  const leadTypes = new Set([
    'lead',
    'leadgen_grouped',
    'onsite_conversion.lead_grouped',
    'onsite_conversion.messaging_conversation_started_7d',
    'offsite_conversion.fb_pixel_lead',
  ]);
  let n = 0;
  for (const a of actions) if (leadTypes.has(a.action_type)) n += Number(a.value) || 0;
  return n;
}
