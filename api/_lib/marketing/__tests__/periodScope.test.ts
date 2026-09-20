/**
 * A period's money comes from the period's campaigns.
 *
 * Reported live on 2026-09-20: "Why is it saying we spent 6,000? It should
 * still be zero right now." The Overview summed every active campaign with no
 * date filter, so September's card carried C-026 — a campaign that ran
 * 15–31 August and spent 4,852 SAR — plus 16,001 SAR of budgets from campaigns
 * belonging to other periods.
 *
 * Measured against production the same day: scoping September (1 Sep → 1 Oct)
 * took the spend from 5,699.30 to 846.68 (C-041's real September spend) and
 * the budget from 16,001 to 10,001, and excluded 3 undated campaigns.
 */
import { describe, expect, it } from 'vitest';
import { campaignInPeriod, undatedCampaigns } from '../periodScope';

// The Overview's September: [1 Sep, 1 Oct).
const FROM = '2026-09-01';
const TO = '2026-10-01';

describe('campaignInPeriod', () => {
  it('keeps a campaign that runs entirely inside the period', () => {
    // C-041 — تل الربوة, 6–12 Sep. Its 846.68 SAR is genuine September spend.
    expect(campaignInPeriod({ starts_on: '2026-09-06', ends_on: '2026-09-12' }, FROM, TO)).toBe(true);
  });

  it('drops the campaign that ended before the period — the 4,852 SAR bug', () => {
    // C-026 — حملة مينا 52, 15–31 Aug.
    expect(campaignInPeriod({ starts_on: '2026-08-15', ends_on: '2026-08-31' }, FROM, TO)).toBe(false);
  });

  it('keeps a campaign that straddles the period end', () => {
    // September's own campaigns: 22 Sep → 31 Oct. They are running in
    // September even though they finish in October.
    expect(campaignInPeriod({ starts_on: '2026-09-22', ends_on: '2026-10-31' }, FROM, TO)).toBe(true);
  });

  it('keeps a campaign that started before the period and is still running', () => {
    expect(campaignInPeriod({ starts_on: '2026-07-01', ends_on: '2026-12-31' }, FROM, TO)).toBe(true);
  });

  it('keeps an open-ended campaign that has started', () => {
    expect(campaignInPeriod({ starts_on: '2026-09-10', ends_on: null }, FROM, TO)).toBe(true);
    expect(campaignInPeriod({ starts_on: '2026-01-01', ends_on: null }, FROM, TO)).toBe(true);
  });

  it('drops a campaign that starts after the period', () => {
    expect(campaignInPeriod({ starts_on: '2026-10-01', ends_on: null }, FROM, TO)).toBe(false);
    expect(campaignInPeriod({ starts_on: '2026-11-05', ends_on: '2026-11-30' }, FROM, TO)).toBe(false);
  });

  it('gets the boundaries right — `to` is exclusive, `from` is inclusive', () => {
    // Starts on the last day of the period: in.
    expect(campaignInPeriod({ starts_on: '2026-09-30', ends_on: null }, FROM, TO)).toBe(true);
    // Starts on the first day AFTER: out.
    expect(campaignInPeriod({ starts_on: '2026-10-01', ends_on: '2026-10-31' }, FROM, TO)).toBe(false);
    // Ends on the period's first day: still overlaps by one day, so in.
    expect(campaignInPeriod({ starts_on: '2026-08-01', ends_on: '2026-09-01' }, FROM, TO)).toBe(true);
    // Ends the day before: out.
    expect(campaignInPeriod({ starts_on: '2026-08-01', ends_on: '2026-08-31' }, FROM, TO)).toBe(false);
  });

  it('never claims a campaign with no start date', () => {
    expect(campaignInPeriod({ starts_on: null, ends_on: null }, FROM, TO)).toBe(false);
    // Even with an end date inside the period — a window needs both edges.
    expect(campaignInPeriod({ starts_on: null, ends_on: '2026-09-15' }, FROM, TO)).toBe(false);
  });
});

describe('undatedCampaigns', () => {
  it('collects exactly what campaignInPeriod refuses to place, so it can be reported', () => {
    const rows = [
      { ref: 'C-028', starts_on: null, ends_on: null },
      { ref: 'C-041', starts_on: '2026-09-06', ends_on: '2026-09-12' },
      { ref: 'C-042', starts_on: null, ends_on: null },
      { ref: 'meta-sync', starts_on: null, ends_on: null },
    ];
    // Production on 2026-09-20 had exactly these three.
    expect(undatedCampaigns(rows).map((c) => c.ref)).toEqual(['C-028', 'C-042', 'meta-sync']);
    // And every one of them is refused by the period rule — the two agree, so
    // nothing can fall between them and vanish from both.
    for (const c of undatedCampaigns(rows)) {
      expect(campaignInPeriod(c, FROM, TO)).toBe(false);
    }
  });
});
