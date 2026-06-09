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
  FIRST_LIGHT_ACTIVITY,
  FIRST_LIGHT_ACTIVITY_ID,
  VERIFY_ACTIVITY,
  VERIFY_ACTIVITY_ID,
} from "@0xhoneyjar/quests-protocol";

import {
  type ActivityCompletionHandle,
  attestationIdempotencyKey,
  evaluateEligibility,
  firstLightAdminVerifier,
  isFirstLightStep,
  isVerifyStep,
  VerifyAttestation,
  verifyAttestationVerifier,
} from "@0xhoneyjar/quests-engine";

import { jsonResponse, ok, type Middleware } from "@hyper/core";
import { identityOf, requireIdentity, route } from "../app";
import { serviceScopeOf } from "../auth/require-service-token";
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
 * buildCompletionEffect — the SINGLE grant-assembly + chokepoint (GATE-SEC-1).
 *
 * BOTH the user-JWT path ({@link completeRoute}) and the B2 service-attested
 * path ({@link completeAttestedRoute}) reach `completion.complete()` ONLY
 * through here — there is exactly ONE complete() call site, strictly downstream
 * of each route's APPROVED guard. It builds the identity-scoped
 * `ActivityCompleted` event (deterministic nonce + canonical event_id) and
 * grants atomically + idempotently.
 *
 * `identityId` is ALWAYS the schema-decoded IdentityId — each route decodes its
 * own authority (the JWT sub / the identity-api-resolved id) at the boundary
 * before calling this, never an unchecked cast. The seam re-verifies the
 * event_id (verifyEventId default).
 */
const buildCompletionEffect = (
  completion: ActivityCompletionHandle,
  args: {
    readonly activity: Activity;
    readonly activityId: string;
    readonly identityId: IdentityId;
    readonly partitionKey: PartitionKey;
    readonly ts: RFC3339Date;
    readonly nonce: string;
    readonly sourceType: string;
    readonly sourceMetadata: Record<string, unknown>;
  },
) =>
  Effect.gen(function* () {
    const preimage = {
      $id: ACTIVITY_COMPLETED_ID,
      preimage_schema_id: ACTIVITY_COMPLETED_PREIMAGE_ID,
      ts: args.ts,
      source_event_hash: null,
      nonce: args.nonce,
      schema_version: "1.0.0" as const,
      activity_id: args.activityId as unknown as ActivityId,
      identity_id: args.identityId,
      period_key: args.activity.period_key,
      step_completions: [],
      reward_state_id: null,
    };

    const eventId = (yield* computeEventId(
      preimage as unknown as Record<string, unknown> & {
        readonly $id: string;
        readonly nonce: string | null;
      },
    )) as unknown as EventId;

    const event = { ...preimage, event_id: eventId } as unknown as ActivityCompleted;

    // The ONLY grant call site — strictly downstream of each route's APPROVED
    // guard. The seam appends the event + records the grant atomically and
    // idempotently (event_id-PK + partition CAS reject replays).
    return yield* completion.complete({
      event,
      reward: args.activity.reward,
      recipient: args.identityId,
      partition_key: args.partitionKey,
      expected_tip_hash: null,
      sourceType: args.sourceType,
      sourceId: args.activityId,
      sourceMetadata: args.sourceMetadata,
    });
  });

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

      // Build + grant via the SINGLE chokepoint (buildCompletionEffect). The
      // deterministic nonce makes a genuine retry reproduce the SAME event_id
      // (→ idempotent duplicate-reject). identityId is the SCHEMA-DECODED sub.
      const completionEffect = buildCompletionEffect(write.completion, {
        activity,
        activityId,
        identityId,
        partitionKey,
        ts: timestampProvider() as unknown as RFC3339Date,
        nonce: `verify:${identityId}:${activityId}:${body.step_id}`,
        sourceType: "verify_completion",
        sourceMetadata: {
          step_id: body.step_id,
          world: identity.world,
          grader_construct_slug: verdict.graderConstructSlug,
          verdict_trace_id: verdict.traceId,
        },
      });

      return runWrite(completionEffect, (outcome) => ({
        completed: true,
        outcome,
        verdict,
        completeness: { status: "full" as const },
      }));
    });

/**
 * parseWorldAllowlist — parse the §1.11.2 world allowlist from the comma-
 * separated `ACTIVITIES_WORLD_ALLOWLIST` env (e.g. "mibera"). Trims + drops
 * empties. An unset/empty env → `[]` → EVERY world is denied (fail-closed): a
 * misconfigured allowlist refuses ALL attested grants rather than allowing any.
 */
export const parseWorldAllowlist = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * completeAttestedRoute — POST /v1/activities/:activity_id/complete-attested
 *
 * The B2 service-attested completion entry (S1.5 · §1.11). freeside-characters
 * (C6) grants the verify badge AFTER a Discord verify but holds NO user JWT, so
 * it cannot use the user-JWT path ({@link completeRoute}). Instead it POSTs a
 * context-bound attestation under the verify-write service token; THIS route
 * adjudicates it via the {@link verifyAttestationVerifier} grader and — ONLY on
 * APPROVED — reaches the same grant chokepoint ({@link buildCompletionEffect}).
 *
 * ── SECURITY (scar · GATE-SEC-1) ─────────────────────────────────────────────
 *   - `verifyWriteGate` accepts ONLY ACTIVITIES_VERIFY_WRITE_TOKEN (§1.12).
 *   - The caller's asserted `identity_id` is NEVER trusted alone: identity-api
 *     independently confirms discord_user_id ↔ identity (HIGH-740); the route
 *     performs that resolve I/O (fail-closed → null) and the grader DENIES a
 *     null/mismatch. The grant recipient is the identity-api-RESOLVED id,
 *     decoded through the real IdentityId boundary.
 *   - No body-supplied authority: submissionId/traceId are route-stamped; the
 *     completion `ts` is derived from the attestation's issued_at and the nonce
 *     is the server-verified idempotency key (b2:<id>:<event>), so a B2 replay
 *     reproduces the same event_id (idempotent).
 *   - DENY (correlation/world/freshness/idempotency/step) → 200 completed:false,
 *     NO event, NO grant.
 */
export const completeAttestedRoute = (
  composition: WriteComposition,
  deps: {
    readonly verifyWriteGate: Middleware;
    readonly resolveDiscordIdentity: (
      discordUserId: string,
    ) => Promise<string | null>;
    readonly worldAllowlist: readonly string[];
    /** Injectable freshness clock (epoch ms). Default: wall clock (grader). */
    readonly nowMsProvider?: () => number;
    /** Override the freshness window in seconds (tests). Default: grader's 24h. */
    readonly freshnessSeconds?: number;
  },
) =>
  route
    .post("/v1/activities/:activity_id/complete-attested")
    .use(deps.verifyWriteGate)
    .meta({
      name: "complete-activity-attested",
      tags: ["activities"],
      mcp: {
        description:
          "Service-attested completion of the verify activity (verify-write " +
          "service token). The grant is reachable ONLY through an APPROVED " +
          "verify-attestation verdict with an identity-api-confirmed correlation.",
      },
    })
    .handle(async (ctx: { req: Request; params: unknown; body: unknown }) => {
      const req = ctx.req;

      // Defense-in-depth (scar): fail CLOSED if the verify-write scope was not
      // authenticated. Unreachable in correct wiring (the gate 401s first);
      // catches a composition-root mis-wire (wrong-scope gate) with a 401.
      if (serviceScopeOf(req) !== "verify-write") {
        return jsonResponse(401, {
          error: "unauthorized",
          code: "wrong_service_scope",
        });
      }

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

      const params = (ctx.params ?? {}) as Record<string, string>;
      const activityId = params.activity_id ?? "";
      // SCOPE (scar · FAGAN S1.5): the attested path is the B2 VERIFY badge
      // ONLY. Bind it EXPLICITLY to act_verify — independent of the shared
      // resolveActivity (whose comment foretells a catalog lookup). Without this
      // bind, once resolveActivity resolves more activities, a Discord-verify
      // attestation could complete ANY activity that merely contains a verify
      // step (an attestation-as-completion-oracle). The attestation proves only
      // Discord verification; it must never grant a non-verify activity.
      if (activityId !== VERIFY_ACTIVITY_ID) {
        return jsonResponse(404, {
          error: "activity_not_found",
          detail: `complete-attested supports only "${VERIFY_ACTIVITY_ID}"`,
          completeness: { status: "full" as const },
        });
      }
      const activity = resolveActivity(activityId);
      if (activity === null) {
        return jsonResponse(404, {
          error: "activity_not_found",
          detail: `no activity "${activityId}"`,
          completeness: { status: "full" as const },
        });
      }

      // The verify step — the ONLY step the attestation grader owns. (The
      // grader re-checks isVerifyStep; this resolves the step VALUE to grade.)
      const step = activity.steps.find((s) => isVerifyStep(s));
      if (step === undefined) {
        return jsonResponse(404, {
          error: "no_verify_step",
          detail: `activity "${activityId}" has no verify step`,
          completeness: { status: "full" as const },
        });
      }

      // F-002: decode the attestation body on the Effect channel (typed 422).
      const bodyResult = await Effect.runPromiseExit(
        Schema.decodeUnknown(VerifyAttestation)(ctx.body ?? {}),
      );
      if (bodyResult._tag !== "Success") {
        return jsonResponse(422, {
          error: "invalid_body",
          detail: "body must be a valid VerifyAttestation (§1.11)",
          completeness: { status: "full" as const },
        });
      }
      const attestation = bodyResult.value;

      // CORRELATION (HIGH-740) — the net-new outbound call. Fail-closed: any
      // error / 404 / malformed → null → the grader DENIES. The route NEVER
      // trusts the caller's identity_id without this independent confirmation.
      const resolvedIdentityId = await deps.resolveDiscordIdentity(
        attestation.discord_user_id,
      );

      // Route-stamped, deterministic ids — NEVER body-supplied authority.
      const submissionId = attestationIdempotencyKey(attestation);
      const traceId = `b2-attest:${submissionId}`;

      // ── THE GATE ──────────────────────────────────────────────────────────
      // The attestation grader. A deny is a sealed VerifyAttestationError →
      // mapped to completed:false (NO grant). Success → an APPROVED verdict.
      const graded = await Effect.runPromise(
        verifyAttestationVerifier({
          attestation,
          resolvedIdentityId,
          step,
          worldAllowlist: deps.worldAllowlist,
          submissionId,
          traceId,
          ...(deps.nowMsProvider !== undefined && {
            nowMsProvider: deps.nowMsProvider,
          }),
          ...(deps.freshnessSeconds !== undefined && {
            freshnessSeconds: deps.freshnessSeconds,
          }),
        }).pipe(
          Effect.map((verdict) => ({ approved: true as const, verdict })),
          Effect.catchAll((err) =>
            Effect.succeed({ approved: false as const, reason: err.reason }),
          ),
        ),
      );

      // ── THE VERIFICATION-INTEGRITY INVARIANT ────────────────────────────
      // A deny returns HERE — before any event is constructed and before
      // buildCompletionEffect (the grant chokepoint) is reachable.
      if (!graded.approved) {
        return ok({
          completed: false,
          reason: graded.reason,
          completeness: { status: "full" as const },
        });
      }
      const verdict = graded.verdict;

      // ── APPROVED — and ONLY now. ────────────────────────────────────────
      // GRANT to the identity-api-RESOLVED id (the authority), decoded through
      // the real IdentityId boundary (not a cast). resolvedIdentityId is
      // non-null here (the grader denies a null/mismatch), but the decode
      // defends against a resolved value that is not a conforming IdentityId.
      const identityIdResult = await Effect.runPromiseExit(
        Schema.decodeUnknown(IdentityId)(resolvedIdentityId ?? ""),
      );
      if (identityIdResult._tag !== "Success") {
        return jsonResponse(422, {
          error: "invalid_identity",
          detail: "identity-api resolved a non-conforming IdentityId",
          completeness: { status: "full" as const },
        });
      }
      const identityId: IdentityId = identityIdResult.value;

      const periodKeyStr =
        activity.period_key === null ? null : String(activity.period_key);
      let partitionKey: PartitionKey;
      try {
        partitionKey = await encodeCompositePartition(
          identityId,
          activityId,
          step.step_id,
          periodKeyStr,
        );
      } catch {
        return jsonResponse(422, {
          error: "invalid_partition",
          detail: "could not encode a conforming composite partition key",
          completeness: { status: "full" as const },
        });
      }

      // Deterministic completion ts from the attestation's issued_at → a B2
      // replay reproduces the SAME event_id (idempotent). issued_at is
      // parseable here (the grader denied a non-parseable one); guard anyway.
      const issuedMs = Date.parse(attestation.issued_at);
      if (!Number.isFinite(issuedMs)) {
        return jsonResponse(422, {
          error: "invalid_issued_at",
          detail: "attestation issued_at is not a parseable timestamp",
          completeness: { status: "full" as const },
        });
      }
      const ts = new Date(issuedMs).toISOString() as unknown as RFC3339Date;

      const completionEffect = buildCompletionEffect(write.completion, {
        activity,
        activityId,
        identityId,
        partitionKey,
        ts,
        // B2 idempotency anchor (§5.2.1): the server-verified idempotency key.
        nonce: attestation.idempotency_key,
        sourceType: "verify_attestation",
        sourceMetadata: {
          step_id: step.step_id,
          world: attestation.world,
          discord_user_id: attestation.discord_user_id,
          verify_event_id: attestation.verify_event_id,
          grader_construct_slug: verdict.graderConstructSlug,
          verdict_trace_id: verdict.traceId,
        },
      });

      return runWrite(completionEffect, (outcome) => ({
        completed: true,
        outcome,
        verdict,
        completeness: { status: "full" as const },
      }));
    });

/**
 * AdminGrantRequest — the First Light admin-grant body. The operator hand-picks
 * the recipient (`identity_id`) + their founding weight. `weight` (1=supporting,
 * 2=founding) is RECORDED as metadata, never power (Gygax × Arcade decision).
 * `cohort` lets the reusable family date each founding moment.
 */
const AdminGrantRequest = Schema.Struct({
  identity_id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  weight: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 2))),
  cohort: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  ),
});

/**
 * completeAdminRoute — POST /v1/activities/:activity_id/complete-admin
 *
 * The operator-attested First Light grant (mirrors {@link completeAttestedRoute}
 * but operator-authority, no self-proof/correlation). The OPERATOR hand-picks
 * the founding cohort; the `admin-grant` service token (§1.12) IS the authority.
 * Bound to `act_firstlight`. Grants an ActivityCompleted (read-plane-surfaced).
 *
 * ── SECURITY (scar · GATE-SEC-1) ─────────────────────────────────────────────
 *   - `adminGate` accepts ONLY ACTIVITIES_ADMIN_GRANT_TOKEN (operator-held; the
 *     most privileged scope — neither read nor verify-write can satisfy it).
 *   - the recipient `identity_id` is operator-supplied (the operator IS the
 *     authority for WHO) but decoded through the real IdentityId boundary before
 *     the grant — a non-conforming id → 422, never reaches complete().
 *   - the grant reaches complete() ONLY through the firstLightAdminVerifier
 *     APPROVED guard + the single buildCompletionEffect chokepoint.
 *   - weight is metadata only (founding=2 / supporting=1) — never power/score.
 *   - idempotent: nonce = `firstlight:<identityId>` → one First Light per
 *     identity (a re-grant hits the partition CAS / event_id-PK → no double grant).
 */
export const completeAdminRoute = (
  composition: WriteComposition,
  deps: { readonly adminGate: Middleware },
) =>
  route
    .post("/v1/activities/:activity_id/complete-admin")
    .use(deps.adminGate)
    .meta({
      name: "complete-activity-admin",
      tags: ["activities"],
      mcp: {
        description:
          "Operator-attested First Light grant (admin-grant service token). The " +
          "grant is reachable ONLY through an APPROVED first-light-admin verdict.",
      },
    })
    .handle(async (ctx: { req: Request; params: unknown; body: unknown }) => {
      const req = ctx.req;

      // Defense-in-depth (scar): fail CLOSED if the admin-grant scope was not
      // authenticated (catches a composition-root mis-wire with a wrong gate).
      if (serviceScopeOf(req) !== "admin-grant") {
        return jsonResponse(401, {
          error: "unauthorized",
          code: "wrong_service_scope",
        });
      }

      const params = (ctx.params ?? {}) as Record<string, string>;
      const activityId = params.activity_id ?? "";
      // SCOPE (scar · FAGAN CRITICAL): the admin grant is First Light ONLY. Bind
      // here + resolve FIRST_LIGHT_ACTIVITY DIRECTLY — it is deliberately NOT in
      // the shared `resolveActivity`, so the lower-privilege JWT (completeRoute)
      // and verify-write (completeAttestedRoute) paths can NEVER resolve (let
      // alone grant) act_firstlight. Checked BEFORE the degraded-DB branch so a
      // wrong activity_id fails closed (404) regardless of persistence state.
      if (activityId !== FIRST_LIGHT_ACTIVITY_ID) {
        return jsonResponse(404, {
          error: "activity_not_found",
          detail: `complete-admin supports only "${FIRST_LIGHT_ACTIVITY_ID}"`,
          completeness: { status: "full" as const },
        });
      }
      const activity = FIRST_LIGHT_ACTIVITY;

      const step = activity.steps.find((s) => isFirstLightStep(s));
      if (step === undefined) {
        return jsonResponse(404, {
          error: "no_firstlight_step",
          detail: `activity "${activityId}" has no first-light step`,
          completeness: { status: "full" as const },
        });
      }

      // F-002: decode the body on the Effect channel (typed 422).
      const bodyResult = await Effect.runPromiseExit(
        Schema.decodeUnknown(AdminGrantRequest)(ctx.body ?? {}),
      );
      if (bodyResult._tag !== "Success") {
        return jsonResponse(422, {
          error: "invalid_body",
          detail: "body must be { identity_id: string, weight?: 1|2, cohort?: string }",
          completeness: { status: "full" as const },
        });
      }
      const grant = bodyResult.value;
      const weight = grant.weight ?? 1;
      const cohort = grant.cohort ?? "bm-fam-working-group";

      // DECODE-AT-BOUNDARY: the operator-supplied recipient through the real
      // IdentityId schema (validate, not trust-widen). A non-conforming id → 422,
      // never reaches the grant path.
      const identityIdResult = await Effect.runPromiseExit(
        Schema.decodeUnknown(IdentityId)(grant.identity_id),
      );
      if (identityIdResult._tag !== "Success") {
        return jsonResponse(422, {
          error: "invalid_identity",
          detail: "recipient identity_id is not a conforming IdentityId",
          completeness: { status: "full" as const },
        });
      }
      const identityId: IdentityId = identityIdResult.value;

      // Degraded AFTER validation (scar · FAGAN): a malformed request (wrong
      // activity / body / identity) 422s/404s regardless of DB state; only a
      // VALID request during a DB outage gets a degraded completed:false. No
      // grant is reachable here (the write surface is null).
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

      // Route-stamped ids (deterministic; never body-supplied authority).
      const submissionId = `firstlight:${identityId}`;
      const traceId = `admin-grant:${submissionId}`;

      // ── THE GATE ──────────────────────────────────────────────────────────
      // The admin grader. A deny (non-first-light step / schema drift) → sealed
      // FirstLightAdminError → completed:false (NO grant). Success → APPROVED.
      const graded = await Effect.runPromise(
        firstLightAdminVerifier({
          step,
          recipientId: identityId,
          weight,
          submissionId,
          traceId,
        }).pipe(
          Effect.map((verdict) => ({ approved: true as const, verdict })),
          Effect.catchAll((err) =>
            Effect.succeed({ approved: false as const, reason: err.reason }),
          ),
        ),
      );

      if (!graded.approved) {
        return ok({
          completed: false,
          reason: graded.reason,
          completeness: { status: "full" as const },
        });
      }
      const verdict = graded.verdict;

      // ── APPROVED — and ONLY now. ────────────────────────────────────────
      const periodKeyStr =
        activity.period_key === null ? null : String(activity.period_key);
      let partitionKey: PartitionKey;
      try {
        partitionKey = await encodeCompositePartition(
          identityId,
          activityId,
          step.step_id,
          periodKeyStr,
        );
      } catch {
        return jsonResponse(422, {
          error: "invalid_partition",
          detail: "could not encode a conforming composite partition key",
          completeness: { status: "full" as const },
        });
      }

      const completionEffect = buildCompletionEffect(write.completion, {
        activity,
        activityId,
        identityId,
        partitionKey,
        ts: new Date().toISOString() as unknown as RFC3339Date,
        // One First Light per identity → deterministic nonce → idempotent re-grant.
        nonce: `firstlight:${identityId}`,
        sourceType: "first_light_admin_grant",
        sourceMetadata: {
          step_id: step.step_id,
          weight, // metadata only — founding=2 / supporting=1, NOT power
          cohort,
          grader_construct_slug: verdict.graderConstructSlug,
          verdict_trace_id: verdict.traceId,
        },
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
