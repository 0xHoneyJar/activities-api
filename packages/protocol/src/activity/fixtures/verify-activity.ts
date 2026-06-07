/**
 * The `verify` Activity — authored as DATA (VB.1).
 *
 * ── WHY A FIXTURE, NOT A CATALOG ─────────────────────────────────────────────
 *
 * activities-api is purely EVENT-SOURCED. The read plane
 * (`apps/runtime/src/routes/reads.ts`) lists ActivityCompleted *events* for an
 * identity (`/v1/activities`) and the static kind discriminants (`/v1/kinds`) —
 * there is NO activity-catalog / authoring / registry surface, and inventing
 * one is explicitly out of scope for this slice. So the `verify` activity is
 * defined here as a typed CONSTANT with a stable id, in the same idiom the
 * protocol already uses for frozen typed fixtures (`../../golden-vectors/`).
 *
 * It is a valid {@link Activity} value:
 *   - kind   = Quest          → one-time (period_key: null · NOT Mission/ISOWeek)
 *   - steps  = one ManualCurator step (the /verify confirmation)
 *   - reward = None            → "completion IS the badge"; the artifact is
 *              delivered by the engine's BadgeIssuancePort (the VB.2 static
 *              adapter resolves `badge_spec.family_id "verify"` → the CDN URI),
 *              NOT by a reward _tag.
 *
 * The companion test (`./verify-activity.test.ts`) decodes this constant through
 * the real `Activity` schema, so the fixture can never silently drift out of
 * the sealed shape.
 *
 * VB.1 · 2026-05-31 · verify-badge slice.
 */

import { Schema } from "effect";

import { Activity } from "../Activity.js";

/**
 * The substrate-fixed schema $id every Activity value carries (sealed literal).
 */
const ACTIVITY_SCHEMA_ID = "https://schemas.freeside.thj/activity/v1.0.0" as const;

/**
 * The completion-event schema the verify Activity emits on completion. Reuses
 * the canonical ActivityCompleted event schema $id — the same one the read
 * plane (`reads.ts`) and golden vectors reference.
 */
const ACTIVITY_COMPLETED_SCHEMA_ID = "https://schemas.freeside.thj/activity-completed/v1.0.0";

/**
 * Stable ActivityId for the verify activity. Content-addressable derivation
 * (SDD §5.6) is the eventual home; here the id is a stable hand-authored slug
 * inside the `^act_[a-z0-9]{1,128}$` pattern.
 */
export const VERIFY_ACTIVITY_ID = "act_verify";

/**
 * Raw (pre-decode) verify Activity value. Kept as a plain object so the
 * companion test can feed it through `Schema.decodeUnknownSync(Activity)` and
 * prove it satisfies the sealed schema — the decoded, branded value is
 * {@link VERIFY_ACTIVITY} below.
 *
 * F-003 (GATE-SEC-1 hardening): this raw shape is NOT exported across the
 * package boundary. Only the decoded, branded {@link VERIFY_ACTIVITY} is
 * importable — so no caller can construct a completion off the *unvalidated*
 * pre-decode object (which could carry a drifted reward/step). The `__…ForTest`
 * name + non-re-export from the package barrels keeps it reachable ONLY by the
 * companion test inside this same package.
 */
const __VERIFY_ACTIVITY_INPUT_FOR_TEST = {
  id: VERIFY_ACTIVITY_ID,
  // Quest = one-time (period_key: null). Mission would require an ISOWeek
  // period_key (weekly) — deliberately NOT used: verify is one-and-done.
  kind: { _tag: "Quest", period_key: null },
  period_key: null,
  steps: [
    {
      step_id: "step_verify",
      description: "Confirm wallet ownership via the identity-api /verify flow (one-time).",
      verification: { _tag: "ManualCurator", curator_id: "verify" },
      required: true,
      order: 0,
    },
  ],
  // None = completion IS the badge. The artifact is issued by the engine's
  // BadgeIssuancePort (VB.2 static adapter), NOT carried in the reward.
  reward: { _tag: "None" },
  reward_state_id: null,
  completion_event_schema: ACTIVITY_COMPLETED_SCHEMA_ID,
  // Cross-world: verify is not bound to a single world.
  world: null,
  schema_version: "1.0.0",
  lifecycle_state: "DEFINED",
  $id: ACTIVITY_SCHEMA_ID,
} as const;

/**
 * The decoded, branded verify Activity. Decoding at module-load proves the
 * fixture is a valid Activity value (it throws at import time if the shape
 * ever drifts out of the sealed schema). Consumers import this typed value.
 */
export const VERIFY_ACTIVITY: Activity = Schema.decodeUnknownSync(Activity)(
  __VERIFY_ACTIVITY_INPUT_FOR_TEST,
);

/**
 * Package-private re-export of the raw pre-decode shape, for the companion
 * fixture test ONLY (F-003). The `__…ForTest` prefix + the fact that this is
 * NOT re-exported from `activity/index.ts` or the package `index.ts` keeps the
 * unvalidated shape out of every external caller's reach. Do NOT add this to a
 * barrel — that would re-open the F-003 surface.
 */
export { __VERIFY_ACTIVITY_INPUT_FOR_TEST };
