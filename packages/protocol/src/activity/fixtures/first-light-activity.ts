/**
 * The `first-light` Activity — authored as DATA (mirrors VERIFY_ACTIVITY · VB.1).
 *
 * First Light is the BM-fam working-group founding badge (category: contribution,
 * first of its kind). Unlike `verify` (self-proven via JWT) it is granted by an
 * OPERATOR — admin-attested, hand-picked founding cohort. This fixture gives the
 * admin-grant path a valid {@link Activity} to complete (the identity-scoped
 * partition + reward None + the admin-graded step), exactly as VERIFY_ACTIVITY
 * does for the verify path.
 *
 *   - kind   = Quest          → one-time (period_key: null)
 *   - steps  = one ManualCurator step (curator_id "first-light" — the
 *              first-light-admin grader owns it; default-deny elsewhere)
 *   - reward = None           → "completion IS the badge"; art resolved at read
 *              time from STATIC_BADGE_REGISTRY["first-light"] (sovereign CDN)
 *
 * F-003 (GATE-SEC-1): only the decoded, branded {@link FIRST_LIGHT_ACTIVITY} is
 * exported across the package barrel — the raw pre-decode shape stays
 * package-private (the `__…ForTest` name + non-re-export from the barrels keeps
 * it reachable ONLY by the companion fixture test).
 *
 * First Light · 2026-06-08 · mibera-badge-surface.
 */

import { Schema } from "effect";

import { Activity } from "../Activity.js";

const ACTIVITY_SCHEMA_ID = "https://schemas.freeside.thj/activity/v1.0.0" as const;
const ACTIVITY_COMPLETED_SCHEMA_ID =
  "https://schemas.freeside.thj/activity-completed/v1.0.0";

/** Stable ActivityId (honors `^act_[a-z0-9]{1,128}$` — no separators). */
export const FIRST_LIGHT_ACTIVITY_ID = "act_firstlight";

const __FIRST_LIGHT_ACTIVITY_INPUT_FOR_TEST = {
  id: FIRST_LIGHT_ACTIVITY_ID,
  // Quest = one-time (period_key: null). Founding is a single dated moment.
  kind: { _tag: "Quest", period_key: null },
  period_key: null,
  steps: [
    {
      step_id: "step_firstlight",
      description:
        "Operator-attested founding-cohort grant (admin-graded; one-time, sealed cohort).",
      verification: { _tag: "ManualCurator", curator_id: "first-light" },
      required: true,
      order: 0,
    },
  ],
  // None = completion IS the badge. Art via the BadgeIssuancePort static adapter.
  reward: { _tag: "None" },
  reward_state_id: null,
  completion_event_schema: ACTIVITY_COMPLETED_SCHEMA_ID,
  // Cross-world fixture; the grant is identity-scoped, world stamped per-grant.
  world: null,
  schema_version: "1.0.0",
  lifecycle_state: "DEFINED",
  $id: ACTIVITY_SCHEMA_ID,
} as const;

/**
 * The decoded, branded first-light Activity. Decoding at module-load proves the
 * fixture is a valid Activity (throws at import if the shape drifts). Consumers
 * import this typed value.
 */
export const FIRST_LIGHT_ACTIVITY: Activity = Schema.decodeUnknownSync(Activity)(
  __FIRST_LIGHT_ACTIVITY_INPUT_FOR_TEST,
);

/** Package-private raw shape — companion fixture test ONLY (F-003). Do NOT barrel. */
export { __FIRST_LIGHT_ACTIVITY_INPUT_FOR_TEST };
