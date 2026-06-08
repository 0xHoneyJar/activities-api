/**
 * Activity → badge-family map + registry-row consistency (S1.3).
 *
 * The map bridges an event-sourced `activity_id` to the STATIC_BADGE_REGISTRY
 * key its badge resolves under. The load-bearing invariant: every mapped family
 * MUST have a registry row — otherwise an activity would map to a family the
 * BadgeIssuancePort cannot resolve (a silent no-artifact grant).
 *
 * S1.3 · 2026-06-08 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_BADGE_FAMILY,
  STATIC_BADGE_REGISTRY,
  badgeFamilyForActivity,
  resolveStaticBadge,
} from "../static-uri.js";

describe("activity → badge-family map (S1.3)", () => {
  it("resolves the B1 donation-raffle activity to its family", () => {
    expect(badgeFamilyForActivity("act_donationraffle")).toBe("donation-raffle");
  });

  it("resolves the verify activity to its family", () => {
    expect(badgeFamilyForActivity("act_verify")).toBe("verify");
  });

  it("returns null for an unmapped activity (no silent default)", () => {
    expect(badgeFamilyForActivity("act_unknown")).toBeNull();
  });

  it("INVARIANT: every mapped family has a STATIC_BADGE_REGISTRY row", () => {
    for (const family of Object.values(ACTIVITY_BADGE_FAMILY)) {
      expect(STATIC_BADGE_REGISTRY[family]).toBeDefined();
    }
  });

  it("the donation-raffle family resolves to a real BadgeArtifact", () => {
    const artifact = resolveStaticBadge("donation-raffle", "2026-06-08T00:00:00Z");
    expect(artifact).not.toBeNull();
    expect(artifact?.uri).toContain("donation-raffle");
  });
});
