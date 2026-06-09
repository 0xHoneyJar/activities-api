/**
 * FIRST_LIGHT_ACTIVITY fixture — proves the act_firstlight activity is a valid
 * Activity (decode-at-load) and has the shape the admin-grant path relies on.
 *
 * First Light · 2026-06-08 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { Activity } from "../Activity.js";
import {
  FIRST_LIGHT_ACTIVITY_ID,
  __FIRST_LIGHT_ACTIVITY_INPUT_FOR_TEST as RAW,
} from "./first-light-activity.js";

describe("FIRST_LIGHT_ACTIVITY fixture", () => {
  it("decodes through the sealed Activity schema (valid Activity)", () => {
    const decoded = Schema.decodeUnknownSync(Activity)(RAW);
    expect(decoded.id).toBe(FIRST_LIGHT_ACTIVITY_ID);
  });

  it("is a one-time Quest with reward None (completion IS the badge)", () => {
    expect(RAW.kind._tag).toBe("Quest");
    expect(RAW.period_key).toBeNull();
    expect(RAW.reward._tag).toBe("None");
  });

  it("has a single first-light ManualCurator step (the admin grader's anchor)", () => {
    expect(RAW.steps).toHaveLength(1);
    expect(RAW.steps[0].verification._tag).toBe("ManualCurator");
    expect(RAW.steps[0].verification.curator_id).toBe("first-light");
  });
});
