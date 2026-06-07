/**
 * verify Activity fixture test (VB.1).
 *
 * Proves the hand-authored `verify` Activity DATA decodes through the real
 * sealed `Activity` schema and carries the load-bearing contract:
 *   - Quest kind → one-time (period_key: null · NOT Mission/ISOWeek/weekly)
 *   - exactly one step (the /verify confirmation)
 *   - reward None → "completion IS the badge" (artifact via BadgeIssuancePort,
 *     never carried in a reward _tag)
 *   - stable ActivityId inside the `^act_[a-z0-9]{1,128}$` pattern
 *
 * Mirrors the decode-through-real-schema idiom of `../activity.test.ts`.
 *
 * VB.1 · 2026-05-31 · verify-badge slice.
 */

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActivityId } from "../../branded/ActivityId.js";
import { Activity } from "../Activity.js";
import {
  VERIFY_ACTIVITY,
  VERIFY_ACTIVITY_ID,
  // F-003: the raw pre-decode shape is package-private (NOT re-exported from any
  // barrel). The companion test reaches it via the relative fixture path only.
  __VERIFY_ACTIVITY_INPUT_FOR_TEST,
} from "./verify-activity.js";

describe("verify Activity fixture (VB.1 · authored as data)", () => {
  it("decodes through the real Activity schema", () => {
    const result = Schema.decodeUnknownEither(Activity)(__VERIFY_ACTIVITY_INPUT_FOR_TEST);
    expect(Either.isRight(result)).toBe(true);
  });

  it("exposes a pre-decoded, branded VERIFY_ACTIVITY value", () => {
    // VERIFY_ACTIVITY is decoded at module-load; re-encode/re-decode is stable.
    const reencoded = Schema.encodeSync(Activity)(VERIFY_ACTIVITY);
    const redecoded = Schema.decodeUnknownSync(Activity)(reencoded);
    expect(redecoded.id).toBe(VERIFY_ACTIVITY_ID);
  });

  it("is a Quest kind → one-time (period_key: null), NOT a Mission/weekly", () => {
    expect(VERIFY_ACTIVITY.kind._tag).toBe("Quest");
    // The outer period_key is null (one-time) and the kind's own period_key is
    // null too — Mission would force an ISOWeek (weekly) here.
    expect(VERIFY_ACTIVITY.period_key).toBeNull();
    expect(VERIFY_ACTIVITY.kind).toMatchObject({ _tag: "Quest", period_key: null });
  });

  it("rewards None → completion IS the badge (artifact NOT in the reward _tag)", () => {
    expect(VERIFY_ACTIVITY.reward._tag).toBe("None");
    // No BadgeMint / External reward — the artifact is the BadgeIssuancePort's
    // job (VB.2 static adapter), not the reward's.
    expect(VERIFY_ACTIVITY.reward._tag).not.toBe("BadgeMint");
    expect(VERIFY_ACTIVITY.reward._tag).not.toBe("External");
  });

  it("has exactly one step (the /verify confirmation)", () => {
    expect(VERIFY_ACTIVITY.steps).toHaveLength(1);
    const [step] = VERIFY_ACTIVITY.steps;
    expect(step?.required).toBe(true);
    expect(step?.order).toBe(0);
    expect(step?.verification._tag).toBe("ManualCurator");
  });

  it("carries a stable ActivityId inside the ^act_[a-z0-9]{1,128}$ pattern", () => {
    expect(VERIFY_ACTIVITY_ID).toBe("act_verify");
    const decoded = Schema.decodeUnknownEither(ActivityId)(VERIFY_ACTIVITY_ID);
    expect(Either.isRight(decoded)).toBe(true);
  });
});
