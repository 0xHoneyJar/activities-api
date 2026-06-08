/**
 * badge-projection tests (S1.6 · C4).
 *
 * Proves the event→EarnedBadge[] projection: BadgeIssued (B1) + ActivityCompleted
 * (B2/verify) contribute; non-badge completions and unknown events do not; art
 * resolves from the registry; one badge per family (earliest wins); stable sort.
 *
 * S1.6 · 2026-06-08 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";

import { type EarnedBadge, projectEarnedBadges } from "../badge-projection.js";

const BADGE_ISSUED_ID = "https://schemas.freeside.thj/badge-issued/v1.0.0";
const ACTIVITY_COMPLETED_ID = "https://schemas.freeside.thj/activity-completed/v1.0.0";

const badgeIssued = (over: Record<string, unknown> = {}) => ({
  $id: BADGE_ISSUED_ID,
  event_id: "evt_b1",
  ts: "2026-06-08T00:00:00Z",
  activity_id: "act_donationraffle",
  identity_id: "id_x",
  snapshot_id: "snap_donationraffle2026q2",
  badge_family_id: "donation-raffle",
  ...over,
});

const activityCompleted = (over: Record<string, unknown> = {}) => ({
  $id: ACTIVITY_COMPLETED_ID,
  event_id: "evt_b2",
  ts: "2026-06-08T01:00:00Z",
  activity_id: "act_verify",
  identity_id: "id_x",
  ...over,
});

const byFamily = (badges: EarnedBadge[]) =>
  Object.fromEntries(badges.map((b) => [b.badge_family_id, b]));

describe("projectEarnedBadges (S1.6)", () => {
  it("projects a BadgeIssued event (B1 merkle) with family + snapshot + art", () => {
    const [b] = projectEarnedBadges([badgeIssued()]);
    expect(b?.badge_family_id).toBe("donation-raffle");
    expect(b?.source).toBe("badge-issued");
    expect(b?.snapshot_id).toBe("snap_donationraffle2026q2");
    expect(b?.uri).toContain("donation-raffle"); // resolved from STATIC_BADGE_REGISTRY
  });

  it("projects an ActivityCompleted for a badge activity (verify) via the family map", () => {
    const [b] = projectEarnedBadges([activityCompleted()]);
    expect(b?.badge_family_id).toBe("verify");
    expect(b?.source).toBe("activity-completed");
    expect(b?.snapshot_id).toBeNull();
    expect(b?.uri).toContain("verify");
  });

  it("skips an ActivityCompleted for a NON-badge activity", () => {
    expect(projectEarnedBadges([activityCompleted({ activity_id: "act_notabadge" })])).toEqual([]);
  });

  it("skips unknown events and non-objects (never throws on a bad shape)", () => {
    expect(projectEarnedBadges([{ $id: "https://schemas.freeside.thj/raffle-drawn/v1.0.0" }])).toEqual([]);
    expect(projectEarnedBadges([null, 42, "x", undefined])).toEqual([]);
  });

  it("null uri for a BadgeIssued family with no registry row (still earned)", () => {
    const [b] = projectEarnedBadges([badgeIssued({ badge_family_id: "unregistered-family" })]);
    expect(b?.badge_family_id).toBe("unregistered-family");
    expect(b?.uri).toBeNull();
  });

  it("dedups one badge per family (earliest issued_at wins)", () => {
    const later = badgeIssued({ event_id: "later", ts: "2026-06-09T00:00:00Z" });
    const earlier = badgeIssued({ event_id: "earlier", ts: "2026-06-07T00:00:00Z" });
    const out = projectEarnedBadges([later, earlier]);
    expect(out).toHaveLength(1);
    expect(out[0]?.event_id).toBe("earlier");
  });

  it("returns multiple distinct families, sorted by issued_at ascending", () => {
    const out = projectEarnedBadges([
      activityCompleted({ ts: "2026-06-08T05:00:00Z" }), // verify, later
      badgeIssued({ ts: "2026-06-08T01:00:00Z" }), // donation-raffle, earlier
    ]);
    expect(out.map((b) => b.badge_family_id)).toEqual(["donation-raffle", "verify"]);
    const m = byFamily(out);
    expect(m["donation-raffle"]).toBeDefined();
    expect(m["verify"]).toBeDefined();
  });
});
