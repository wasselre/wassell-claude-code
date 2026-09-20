/**
 * Does a campaign belong to a period?
 *
 * The Overview used to sum every active campaign's budget and spend with no
 * date filter at all, so a freshly-opened September carried August's C-026
 * (4,852 SAR, ended 31 Aug) and every legacy campaign's budget — 16,001 SAR of
 * "this period's" money, most of it from other periods.
 *
 * The rule is plain interval overlap on a half-open period `[from, to)`:
 * a campaign is in it when it starts before the period ends and has not already
 * ended when the period starts. An open-ended campaign (`ends_on` null) is
 * still running, so it qualifies.
 *
 * A campaign with NO start date is a separate case and deliberately NOT here:
 * it cannot be placed in time at all, so it must not contribute to a dated
 * figure. `undatedCampaigns` finds those, and the card reports how many were
 * left out — excluded, never silently dropped.
 */

/** Just the two dates the rule needs. `YYYY-MM-DD`, as the view stores them. */
export interface CampaignWindow {
  starts_on: string | null;
  ends_on: string | null;
}

/**
 * @param from inclusive first day of the period, `YYYY-MM-DD`
 * @param to   EXCLUSIVE day after the period, `YYYY-MM-DD`
 */
export function campaignInPeriod(c: CampaignWindow, from: string, to: string): boolean {
  if (c.starts_on === null) return false;
  if (c.starts_on >= to) return false;              // starts after the period
  return c.ends_on === null || c.ends_on >= from;   // still open, or ended inside
}

/** Active campaigns that carry no start date, so no period can claim them. */
export function undatedCampaigns<T extends CampaignWindow>(rows: T[]): T[] {
  return rows.filter((c) => c.starts_on === null);
}
