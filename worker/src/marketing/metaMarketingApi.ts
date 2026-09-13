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
// WORKER COPY of api/_lib/marketing/metaMarketingApi.ts (the worker is a
// standalone package and cannot import from api/_lib — same posture as
// worker/src/imageGen.ts). Keep the shared part IDENTICAL to the API copy
// (re-copy it when the API copy changes); the ad-set / sibling-ad reads at the
// bottom exist ONLY here (the meta-ad lane, 2026-09-10).
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

  /**
   * Insights over an explicit date window (both dates inclusive, YYYY-MM-DD).
   * The perf system's monthly CPL/CTR snapshot uses this — the sync's stored
   * numbers are LIFETIME (date_preset 'maximum') and cannot answer "what did
   * this month cost", so the monthly cron pulls the month's own window.
   */
  async getInsightsRange(level: MetaInsightLevel, since: string, until: string): Promise<MetaInsightRow[]> {
    return this.getAll<MetaInsightRow>(`${this.act}/insights`, {
      level,
      time_range: JSON.stringify({ since, until }),
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

  // ----- Creative media (verified live 2026-09-10) ---------------------------
  // `adimages` accepts the bytes as base64 in the `bytes` form field — the
  // documented `url` parameter answers "(#3) Application does not have the
  // capability to make this API call" for our app, so we always download the
  // file ourselves and re-upload. `advideos` DOES accept a `file_url` (Meta
  // fetches it — a 1h signed Storage URL is enough), then processes the video
  // asynchronously; a creative can only reference it once `status.video_status`
  // is `ready` (a tiny clip took ~10s, a real reel can take minutes).

  /** Upload image bytes; returns the account-scoped image hash a creative uses. */
  async uploadImageBytes(bytes: Uint8Array, name: string): Promise<{ hash: string; width: number | null; height: number | null }> {
    const res = await this.request<{ images: Record<string, { hash: string; width?: number; height?: number }> }>(
      'POST', `${this.act}/adimages`, { bytes: base64Of(bytes), name },
    );
    const first = Object.values(res.images ?? {})[0];
    if (!first?.hash) throw new MetaApiError('adimages returned no hash', null, null, null, null, 200, res);
    return { hash: first.hash, width: first.width ?? null, height: first.height ?? null };
  }

  /** Start a video upload from a URL Meta can fetch; returns the video id. */
  async uploadVideoByUrl(fileUrl: string, name: string): Promise<{ id: string }> {
    return this.request('POST', `${this.act}/advideos`, { file_url: fileUrl, name });
  }

  /** Processing status + Meta's own generated thumbnails (the preferred one
   *  becomes the creative's `image_url`, so no thumbnail upload is needed). */
  async getVideoStatus(videoId: string): Promise<{ ready: boolean; status: string | null; thumbnailUrl: string | null }> {
    const res = await this.request<{
      status?: { video_status?: string };
      thumbnails?: { data?: Array<{ uri: string; is_preferred?: boolean }> };
    }>('GET', videoId, { fields: 'status,thumbnails{uri,is_preferred}' });
    const status = res.status?.video_status ?? null;
    const thumbs = res.thumbnails?.data ?? [];
    const preferred = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
    return { ready: status === 'ready', status, thumbnailUrl: preferred?.uri ?? null };
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

  // ----- WORKER-ONLY additions (auto Meta ad lane, 2026-09-10) ---------------

  /** The ad set's targeting (publisher platforms + positions), destination and state. */
  async getAdSet(adSetId: string): Promise<MetaAdSetDetail> {
    return this.request<MetaAdSetDetail>('GET', adSetId, {
      fields: 'id,name,status,effective_status,destination_type,optimization_goal,promoted_object,targeting,campaign_id',
    });
  }

  /** Sibling ads in the same ad set — used to copy the WhatsApp welcome message. */
  async listAdSetAds(adSetId: string, limit = 5): Promise<MetaSiblingAd[]> {
    const res = await this.request<{ data?: MetaSiblingAd[] }>('GET', `${adSetId}/ads`, {
      fields: 'id,name,status,creative{id,object_story_spec,asset_feed_spec}',
      limit,
    });
    return res.data ?? [];
  }

  /** Meta's asynchronous verdict on an ad: `effective_status` + `issues_info`
   *  (e.g. «Invalid Creative For Objective», a HARD_ERROR that never delivers). */
  async getAdIssues(adId: string): Promise<{ status: string | null; issues: string[] }> {
    const res = await this.request<{ effective_status?: string; issues_info?: Array<{ error_summary?: string; error_message?: string; error_type?: string }> }>(
      'GET', adId, { fields: 'effective_status,issues_info' },
    );
    return {
      status: res.effective_status ?? null,
      issues: (res.issues_info ?? []).map((i) => i.error_message ?? i.error_summary ?? 'unknown issue'),
    };
  }

  /** Newest ads anywhere in the account (with creatives) — the fallback source
   *  of the Click-to-WhatsApp welcome template when the ad set has no sibling. */
  async listAccountAds(limit = 60): Promise<MetaSiblingAd[]> {
    const res = await this.request<{ data?: MetaSiblingAd[] }>('GET', `${this.act}/ads`, {
      fields: 'id,name,status,created_time,creative{id,object_story_spec,asset_feed_spec}',
      limit,
    });
    return res.data ?? [];
  }

  private withValidate(input: Record<string, unknown>, validateOnly: boolean): Record<string, unknown> {
    return validateOnly ? { ...input, execution_options: ['validate_only'] } : input;
  }
}

/** Runtime-agnostic base64 (no `Buffer` on the Vercel Edge runtime). Chunked so
 *  a multi-MB image never builds one giant argument list for fromCharCode. */
export function base64Of(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
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

// ----- WORKER-ONLY shapes (auto Meta ad lane) --------------------------------

export interface MetaAdSetDetail {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  destination_type?: string;
  optimization_goal?: string;
  campaign_id?: string;
  promoted_object?: { page_id?: string } & Record<string, unknown>;
  targeting?: {
    publisher_platforms?: string[];
    facebook_positions?: string[];
    instagram_positions?: string[];
    messenger_positions?: string[];
    whatsapp_positions?: string[];
    audience_network_positions?: string[];
  } & Record<string, unknown>;
}

export interface MetaSiblingAd {
  id: string;
  name?: string;
  status?: string;
  creative?: {
    id?: string;
    object_story_spec?: {
      link_data?: { page_welcome_message?: string; message?: string };
      video_data?: { page_welcome_message?: string; message?: string };
    } & Record<string, unknown>;
    asset_feed_spec?: { additional_data?: { page_welcome_message?: string } } & Record<string, unknown>;
  };
}
