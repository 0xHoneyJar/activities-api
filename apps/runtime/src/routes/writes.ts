/**
 * Activity-supertype WRITE route (GATE-SEC-1 · VB.3) — the completion plane.
 *
 * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────
 *
 * The live CubQuests surface auto-completes `verificationType: "manual"` with
 * NO authoritative check, then grants. The merged write engine has the grant
 * machinery (`makeActivityCompletion().complete()`) and the verdict machinery
 * (`evaluateEligibility`) but they are DECOUPLED — `complete()` grants on a
 * pre-built `ActivityCompleted` event with NO APPROVED gate in its body. A
 * naïve POST that built an event and called `complete()` would re-open the
 * exact hole at a new altitude.
 *
 * This route is the BINDING. The pipeline is strict and the `ActivityCompleted`
 * event is constructed ONLY inside the APPROVED branch:
 *
 *   1. requireIdentity middleware → 401 before the handler if no/bad JWT.
 *   2. identityOf(req) → the AUTHENTICATED identity + world (never from body).
 *   3. resolve the activity (VERIFY_ACTIVITY for this slice).
 *   4. evaluateEligibility(...) → SubstrateStepVerdict        ← THE GATE
 *   5. if verdict.status !== "APPROVED": return 200 {completed:false, verdict}
 *      — NO event, NO grant, NO completion path entered.
 *   6. ── only reachable here when APPROVED ──
 *      build the ActivityCompleted event (identity-scoped composite partition,
 *      deterministic nonce + event_id) and call completion.complete().
 *
 * THE VERIFICATION-INTEGRITY INVARIANT (the line where a non-APPROVED verdict
 * cannot grant): the `if (verdict.status !== "APPROVED") return ...` guard
 * below. `completion.complete()` is the ONLY grant call site, and it lives
 * strictly downstream of that guard — there is no other path to it.
 *
 * The verify verdict is NOT a blanket auto-approve: `evaluateEligibility`
 * routes the verify step to the named `identity-proof` grader, whose APPROVED
 * is DERIVED from the cryptographically-verified JWT that already gated the
 * request at `requireIdentity`. Every other step shape defaults to deny.
 *
 * ── F-001 (the BadgeIssuancePort stays a pure resolver) ──────────────────────
 *
 * The route owns the verdict gate. The BadgeIssuancePort is a pure artifact
 * resolver and does NOT guard the verdict (see static-uri.ts F-001 note). The
 * verify activity's reward is `None` — completion IS the badge; the static
 * artifact URI is resolved at READ time (get-badges), not minted here. The
 * minimal GATE-SEC-1 slice does NOT append a BadgeIssued event (operator
 * decision #2 — deferred); the ActivityCompleted event is the load-bearing
 * write.
 *
 * ── F-002 (Effect-channel-safe decode) ───────────────────────────────────────
 *
 * The request body is decoded through an Effect.Schema with the error mapped
 * onto the typed channel — a malformed body surfaces as 422, never a thrown
 * ParseError escaping as a 500.
 *
 * VB.3 · GATE-SEC-1 · 2026-05-31 · verify-badge slice.
 */

import { Effect, Schema } from "effect";

import {
  type Activity,
  type ActivityCompleted,
  type ActivityId,
  computeEventId,
  type EventId,
  IdentityId,
  type PartitionKey,
  type RFC3339Date,
  VERIFY_ACTIVITY,
  VERIFY_ACTIVITY_ID,
} from "@0xhoneyjar/quests-protocol";

import {
  type ActivityCompletionHandle,
  evaluateEligibility,
} from "@0xhoneyjar/quests-engine";

import { jsonResponse, ok } from "@hyper/core";
import { identityOf, requireIdentity, route } from "../app";
import type { WriteComposition } from "../composition";
import { encodeCompositePartition, runWrite } from "./_shared";

const ACTIVITY_COMPLETED_ID =
  "https://schemas.freeside.thj/activity-completed/v1.0.0";
const ACTIVITY_COMPLETED_PREIMAGE_ID =
  "https://schemas.freeside.thj/preimage/activity-completed/v1.0.0";

/**
 * CompleteRequest — the minimal verify-slice body. Carries the SUBMISSION (the
 * proof the verifier grades), NOT a verdict and NOT a reward. The caller may
 * NEVER assert its own approval or reward — those are substrate-derived.
 *
 *   - `step_id`   the step being completed (e.g. "step_verify").
 *
 * Deliberately ABSENT: `identity_id` (taken from the token), `reward`,
 * `verdict`, `status`. For the verify activity the "proof" is the JWT itself
 * (wallet ownership was proven at identity-api when the token was minted), so
 * no payload is required.
 */
const CompleteRequest = Schema.Struct({
  step_id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(140)),
});

type CompleteRequest = Schema.Schema.Type<typeof CompleteRequest>;

/**
 * Resolve the Activity for an `activity_id`. This slice serves exactly one
 * activity — the verify fixture. An unknown id resolves to `null` (the route
 * 404s). When a catalog lands, this becomes a lookup.
 */
const resolveActivity = (activityId: string): Activity | null =>
  activityId === VERIFY_ACTIVITY_ID ? VERIFY_ACTIVITY : null;

/**
 * The identity-scoped composite-partition codec is the LOAD-BEARING cross-plane
 * contract — it lives in `_shared.ts` so BOTH the write route (here) and the
 * read plane (reads.ts) consume the SAME join/hash logic (no duplication). See
 * `encodeCompositePartition` for the encoding spec + operator decision #1.
 */

/**
 * completeRoute — POST /v1/activities/:activity_id/complete
 *
 * Behind `requireIdentity`. Identity- and world-scoped, idempotent,
 * identity-scoped composite partition. The verdict gate is the load-bearing
 * security boundary (see file header).
 */
export const completeRoute = (
  composition: WriteComposition,
  /**
   * Injectable clock for the completion event's `ts`. Default: wall clock.
   *
   * The completion event_id is `computeEventId(preimage)`, and the preimage
   * includes `ts` — so a STABLE `ts` is what makes a genuine retry reproduce
   * the SAME event_id (→ the seam's event_id-PK duplicate-reject is a no-op,
   * not a second grant). The verify activity is one-and-done + time-insensitive;
   * a deployment that wants strict event-id idempotency across retries can pin a
   * deterministic clock here (e.g. one keyed off the logical completion). Tests
   * pin it to assert the determinism property.
   */
  timestampProvider: () => string = () => new Date().toISOString(),
) =>
  route
    .post("/v1/activities/:activity_id/complete")
    .use(requireIdentity)
    .meta({
      name: "complete-activity",
      tags: ["activities"],
      mcp: {
        description:
          "Completes an activity step for the authenticated identity. The grant " +
          "is reachable ONLY through an APPROVED substrate verdict (GATE-SEC-1).",
      },
    })
    .handle(async (ctx: { req: Request; params: unknown; body: unknown }) => {
      const req = ctx.req;
      // Path params arrive as a string map (the router fills `:activity_id`);
      // HandlerCtx types `params` as `unknown`, so narrow at the boundary.
      const params = (ctx.params ?? {}) as Record<string, string>;

      // Degraded: no DB / completion handle wired → mirror the read plane's
      // degraded-envelope discipline (never crash the process).
      const write = composition.write;
      if (write === null) {
        return ok({
          completed: false,
          reason: "cubquest-db not bound; completion unavailable",
          completeness: {
            status: "degraded" as const,
            reason: "cubquest-db not bound; completion unavailable",
            fallback_source: "none (cubquest-db not bound)",
          },
        });
      }

      // (1) AUTHENTICATED identity — never from the body (same discipline as
      // reads.ts). requireIdentity should already have 401'd a missing token.
      const identity = identityOf(req);
      if (identity === undefined) {
        return ok({
          completed: false,
          reason: "unauthenticated",
          completeness: { status: "degraded" as const },
        });
      }

      // (2) Resolve the activity from the path param.
      const activityId = params.activity_id ?? "";
      const activity = resolveActivity(activityId);
      if (activity === null) {
        return jsonResponse(404, {
          error: "activity_not_found",
          detail: `no activity "${activityId}"`,
          completeness: { status: "full" as const },
        });
      }

      // (3) F-002: decode the body on the Effect channel (typed 422, never 500).
      // Hyper has already parsed the JSON request body into `ctx.body` (the
      // request stream is consumed by the framework before the handler runs, so
      // we read the pre-parsed value, NOT `req.json()`). `ctx.body` is untyped,
      // so we re-decode through the sealed schema — defense-in-depth.
      const bodyResult = await Effect.runPromiseExit(
        Schema.decodeUnknown(CompleteRequest)(ctx.body ?? {}),
      );
      if (bodyResult._tag !== "Success") {
        return jsonResponse(422, {
          error: "invalid_body",
          detail: "body must be { step_id: string }",
          completeness: { status: "full" as const },
        });
      }
      const body: CompleteRequest = bodyResult.value;

      // (3b) FIX-1 — DECODE-AT-BOUNDARY (not cast). The JWT `sub` reaches us as
      // an opaque string on `identity.identity_id`; decode it through the REAL
      // IdentityId schema (^id_[a-z0-9]{1,128}$) HERE, before it can flow into
      // the grant path. A non-conforming sub (uppercase, digit-start, embedded
      // `:`/`::`, over-long, …) surfaces as a typed 422 on the SAME path the
      // body decode uses — it NEVER reaches buildCompositePartition / the
      // preimage / completion.complete() as an unchecked `as unknown as`.
      const identityIdResult = await Effect.runPromiseExit(
        Schema.decodeUnknown(IdentityId)(identity.identity_id),
      );
      if (identityIdResult._tag !== "Success") {
        return jsonResponse(422, {
          error: "invalid_identity",
          detail: "authenticated subject is not a conforming IdentityId",
          completeness: { status: "full" as const },
        });
      }
      const identityId: IdentityId = identityIdResult.value;

      // Authoritative correlation ids — route-stamped from the verified identity
      // + completion target. NEVER body-supplied (a caller cannot attribute its
      // verdict to another submission). Deterministic so a retry reproduces them.
      const submissionId = `${identityId}:${activityId}:${body.step_id}`;
      const traceId = `verify:${submissionId}`;

      // (4) THE GATE. evaluateEligibility routes the verify step to the named
      // identity-proof grader; every other step defaults to deny. This Effect
      // has NO side effects — it only adjudicates eligibility.
      const verdict = await Effect.runPromise(
        evaluateEligibility({
          activity,
          stepId: body.step_id,
          identity: {
            identity_id: identityId,
            world: identity.world,
          },
          submissionId,
          traceId,
        }),
      );

      // ── (5) THE VERIFICATION-INTEGRITY INVARIANT ──────────────────────────
      //
      // A non-APPROVED verdict returns HERE — before any ActivityCompleted
      // event is constructed and before completion.complete() is reachable.
      // This is the single line that makes it structurally impossible to reach
      // the grant path without an APPROVED SubstrateStepVerdict.
      if (verdict.status !== "APPROVED") {
        return ok({
          completed: false,
          verdict,
          completeness: { status: "full" as const },
        });
      }

      // ── (6) APPROVED — and ONLY now — construct the completion event. ──────
      //
      // Identity-scoped composite partition (G-4 / .20). Fresh per-identity-
      // per-substep partition → expected_tip_hash is null (first event); a
      // replay hits the event_id PK duplicate-reject and grants nothing twice.
      const periodKeyStr =
        activity.period_key === null ? null : String(activity.period_key);
      // FIX-1 — the composite partition is DECODED through the real PartitionKey
      // schema inside the shared codec (encodeCompositePartition → it never
      // returns an unchecked `as unknown as PartitionKey`). Defense-in-depth: a
      // decode failure of the assembled composite surfaces as a typed 422 on the
      // same path as the body decode — a non-conforming partition NEVER reaches
      // completion.complete().
      let partitionKey: PartitionKey;
      try {
        partitionKey = await encodeCompositePartition(
          identityId,
          activityId,
          body.step_id,
          periodKeyStr,
        );
      } catch {
        return jsonResponse(422, {
          error: "invalid_partition",
          detail: "could not encode a conforming composite partition key",
          completeness: { status: "full" as const },
        });
      }

      const ts = timestampProvider() as unknown as RFC3339Date;
      // Deterministic nonce per logical completion — a genuine retry reproduces
      // the SAME event_id (→ idempotent duplicate-reject), while two distinct
      // completions differ. `activity-completed` is a MUTATING event so the
      // nonce is mandatory (compute-event-id.ts · atomic-completion seam).
      const nonce = `verify:${identityId}:${activityId}:${body.step_id}`;

      // Build the preimage (event minus event_id), compute the canonical hash,
      // then attach it. The seam re-verifies via computeEventId by default.
      // identity_id is the SCHEMA-DECODED IdentityId (Fix 1) — not a cast.
      const preimage = {
        $id: ACTIVITY_COMPLETED_ID,
        preimage_schema_id: ACTIVITY_COMPLETED_PREIMAGE_ID,
        ts,
        source_event_hash: null,
        nonce,
        schema_version: "1.0.0" as const,
        activity_id: activityId as unknown as ActivityId,
        identity_id: identityId,
        period_key: activity.period_key,
        step_completions: [],
        reward_state_id: null,
      };

      const completionEffect = Effect.gen(function* () {
        const eventId = (yield* computeEventId(
          preimage as unknown as Record<string, unknown> & {
            readonly $id: string;
            readonly nonce: string | null;
          },
        )) as unknown as EventId;

        const event = {
          ...preimage,
          event_id: eventId,
        } as unknown as ActivityCompleted;

        // completion.complete() is the ONLY grant call site — strictly
        // downstream of the APPROVED guard above. The verify activity's reward
        // is None → the seam appends the event + records a (zero-delta) grant
        // atomically and idempotently.
        return yield* write.completion.complete({
          event,
          reward: activity.reward,
          // FIX-1 — schema-decoded IdentityId (not a cast).
          recipient: identityId,
          partition_key: partitionKey,
          expected_tip_hash: null,
          sourceType: "verify_completion",
          sourceId: activityId,
          sourceMetadata: {
            step_id: body.step_id,
            world: identity.world,
            grader_construct_slug: verdict.graderConstructSlug,
            verdict_trace_id: verdict.traceId,
          },
        });
      });

      return runWrite(completionEffect, (outcome) => ({
        completed: true,
        outcome,
        verdict,
        completeness: { status: "full" as const },
      }));
    });

/** Re-export for the composition's typed surface. */
export type { ActivityCompletionHandle };
