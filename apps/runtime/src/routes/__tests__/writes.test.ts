/**
 * POST /v1/activities/:activity_id/complete — GATE-SEC-1 security tests (VB.3).
 *
 * These are the load-bearing tests: they prove it is structurally impossible
 * to reach the grant path without an APPROVED substrate verdict.
 *
 *   (a) no JWT                              → 401 (the gate short-circuits)
 *   (b) valid JWT + verify step (APPROVED)  → grant + idempotent replay
 *   (c) THE HOLE REGRESSION: a step with no resolvable verifier → NEEDS_HUMAN
 *       → completion.complete() is NEVER called (NO grant, NO event)
 *   (d) cross-user partition isolation (G-4 / .20): two identities completing
 *       the same activity land in DISTINCT identity-scoped partitions
 *   (e) F-002: malformed body → typed 422, never a 500
 *
 * The completion handle is a SPY (records whether complete() ran + the
 * partition it received), so the tests assert the GATE behavior without a live
 * Postgres. The engine's `evaluateEligibility` is the real verdict gate.
 *
 * VB.3 · GATE-SEC-1 · 2026-05-31 · verify-badge slice.
 */

import { createHmac } from "node:crypto";

import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PartitionKey, VERIFY_ACTIVITY_ID } from "@0xhoneyjar/quests-protocol";
import {
  type ActivityCompletionHandle,
  CompletionGranted,
  type CompleteActivityInput,
} from "@0xhoneyjar/quests-engine";

import { Hyper } from "@hyper/core";
import type { Route } from "@hyper/core";

import { completeRoute } from "../writes";
import type { WriteComposition } from "../../composition";

// ---------------------------------------------------------------------------
// HS256 JWT minting (mirrors what identity-api's mintSessionJwt produces)
// ---------------------------------------------------------------------------

const SECRET = "test-secret-do-not-use-in-prod";
const ISSUER = "identity-api";

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

const mintJwt = (claims: Record<string, unknown>): string => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ iss: ISSUER, iat: now, exp: now + 3600, ...claims }),
  );
  const sig = createHmac("sha256", SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
};

// ---------------------------------------------------------------------------
// Spy completion handle — records whether complete() ran + what it received
// ---------------------------------------------------------------------------

interface SpyHandle extends ActivityCompletionHandle {
  readonly calls: CompleteActivityInput[];
}

const makeSpyCompletion = (): SpyHandle => {
  const calls: CompleteActivityInput[] = [];
  const complete: ActivityCompletionHandle["complete"] = (input) => {
    calls.push(input);
    // Return a stub CompletionGranted (the seam's success shape). The grant
    // record fields are not under test here — the GATE is.
    return Effect.succeed(
      new CompletionGranted({
        grant: {
          _tag: "RewardGranted",
          reward: input.reward,
          originating_event_id: input.event.event_id,
          granted_event_id: input.event.event_id,
          ts: "2026-05-31T12:00:00Z",
        } as unknown as CompletionGranted["grant"],
        userAddress: "0xstub",
        delta: { common: 0, rare: 0, legendary: 0 },
      }),
    );
  };
  return { complete, calls };
};

const compositionWith = (handle: ActivityCompletionHandle): WriteComposition => ({
  write: { completion: handle },
});

// ---------------------------------------------------------------------------
// App harness — build a minimal Hyper app with ONLY the write route, drive it
// via app.fetch so the requireIdentity middleware runs (the 401 gate).
// ---------------------------------------------------------------------------

const buildApp = (
  composition: WriteComposition,
  // A pinned clock proves event-id determinism (the idempotency property). The
  // default (undefined) uses the route's wall-clock default.
  timestampProvider?: () => string,
): Hyper => {
  const app = new Hyper({ name: "writes-test" });
  const r =
    timestampProvider === undefined
      ? completeRoute(composition)
      : completeRoute(composition, timestampProvider);
  app.use([r] as unknown as readonly Route[]);
  return app;
};

const post = (
  app: Hyper,
  activityId: string,
  body: unknown,
  token?: string,
): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`http://local/v1/activities/${activityId}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
};

// NOTE: IDENTITY_API_JWT_SECRET / IDENTITY_API_ISSUER are injected by the
// runtime vitest config's `test.env` (the auth middleware reads them EAGERLY at
// module load). SECRET / ISSUER above MUST match those values.

describe("POST /complete — (a) auth gate", () => {
  it("no JWT → 401 (the gate short-circuits before the handler)", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" });
    expect(res.status).toBe(401);
    // The handler never ran → no grant attempted.
    expect(spy.calls).toHaveLength(0);
  });

  it("malformed JWT → 401", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, "not.a.jwt");
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("POST /complete — (b) verify step APPROVED → grant + idempotency", () => {
  it("valid JWT + verify step → APPROVED → completion.complete() invoked once", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const token = mintJwt({ sub: "id_alice", tenant: "mibera" });
    const res = await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      completed: boolean;
      verdict: { status: string; graderConstructSlug: string };
    };
    expect(body.completed).toBe(true);
    expect(body.verdict.status).toBe("APPROVED");
    // The approval is attributed to the NAMED identity-proof grader, NOT a
    // self-assertion.
    expect(body.verdict.graderConstructSlug).toBe("identity-proof");
    // The grant ran exactly once.
    expect(spy.calls).toHaveLength(1);
    // The recipient is the AUTHENTICATED identity (the JWT sub), never the body.
    expect(String(spy.calls[0]?.recipient)).toBe("id_alice");
    // expected_tip_hash is null (fresh per-identity-per-substep partition).
    expect(spy.calls[0]?.expected_tip_hash).toBeNull();
  });

  it("idempotent replay → same event_id both times (duplicate-reject is a no-op)", async () => {
    const spy = makeSpyCompletion();
    // Pin the clock: a genuine retry of the SAME completion produces the SAME
    // preimage → the SAME event_id → the postgres seam's event_id-PK
    // duplicate-reject makes the 2nd a no-op (NOT a second grant). This is the
    // route-side half of the idempotency guarantee (the seam-side half is
    // proven in complete.integration.test.ts).
    const fixedClock = () => "2026-05-31T12:00:00Z";
    const app = buildApp(compositionWith(spy), fixedClock);
    const token = mintJwt({ sub: "id_alice", tenant: "mibera" });
    await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, token);
    await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, token);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.event.event_id).toBe(spy.calls[1]?.event.event_id);
    // The nonce is the deterministic per-completion value (the idempotency
    // anchor that distinguishes one logical completion from another).
    const ev0 = spy.calls[0]?.event as unknown as { nonce: string };
    expect(ev0.nonce).toBe("verify:id_alice:act_verify:step_verify");
    // The resource-idempotency key the seam enforces == event_id (the route
    // pins it indirectly: the seam derives it from the event).
    expect(typeof spy.calls[0]?.event.event_id).toBe("string");
  });
});

describe("POST /complete — (c) THE HOLE REGRESSION", () => {
  it("a step with no resolvable verifier → NEEDS_HUMAN → NO grant, NO event", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const token = mintJwt({ sub: "id_alice", tenant: "mibera" });
    // The verify activity declares ONLY "step_verify". An unknown step_id has
    // no verifier → the gate must NEEDS_HUMAN it and grant NOTHING.
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      { step_id: "step_unverified" },
      token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean; verdict: { status: string } };
    expect(body.completed).toBe(false);
    expect(body.verdict.status).not.toBe("APPROVED");
    expect(body.verdict.status).toBe("NEEDS_HUMAN");
    // THE INVARIANT: completion.complete() was NEVER reached.
    expect(spy.calls).toHaveLength(0);
  });
});

describe("POST /complete — (d) cross-user partition isolation (G-4 / .20)", () => {
  it("two identities, same activity → DISTINCT identity-scoped partitions", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const alice = mintJwt({ sub: "id_alice", tenant: "mibera" });
    const bob = mintJwt({ sub: "id_bob", tenant: "mibera" });
    await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, alice);
    await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, bob);
    expect(spy.calls).toHaveLength(2);
    const pkA = spy.calls[0]?.partition_key as unknown as { scope: string; value: string };
    const pkB = spy.calls[1]?.partition_key as unknown as { scope: string; value: string };
    // Identity-scoped composite — the two users NEVER share a tip.
    expect(pkA.scope).toBe("composite");
    expect(pkA.value).not.toBe(pkB.value);
    expect(pkA.value.startsWith("id_alice::")).toBe(true);
    expect(pkB.value.startsWith("id_bob::")).toBe(true);
    // Both halves are slug-shaped (single `::`).
    expect(pkA.value.split("::")).toHaveLength(2);
    // And the composite partition decodes through the REAL PartitionKey schema.
    expect(Either.isRight(Schema.decodeUnknownEither(PartitionKey)(pkA))).toBe(true);
  });

  it("OVER-LONG identity_id (>120 chars) → still a schema-valid composite (flag #1)", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    // An IdentityId can be up to 131 chars (`id_` + 128) — longer than the
    // 120-char composite half cap. The route MUST hash the identity half.
    const longId = `id_${"a".repeat(128)}`; // 131 chars
    const token = mintJwt({ sub: longId, tenant: "mibera" });
    const res = await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, token);
    expect(res.status).toBe(200);
    expect(spy.calls).toHaveLength(1);
    const pk = spy.calls[0]?.partition_key as unknown as { scope: string; value: string };
    // The composite stays schema-valid (each half ≤120, single `::`).
    expect(Either.isRight(Schema.decodeUnknownEither(PartitionKey)(pk))).toBe(true);
    // The identity half was hashed (replaced with the id_h<hash> form).
    expect(pk.value.startsWith("id_h")).toBe(true);
  });
});

describe("POST /complete — (f) FIX-1 non-conforming sub decodes-at-boundary → 422", () => {
  // The JWT `sub` is decoded through the REAL IdentityId schema
  // (^id_[a-z0-9]{1,128}$) at the route boundary. A short, structurally-wrong
  // sub MUST surface as a typed 422 on the same path as the body decode — it
  // must NEVER reach the partition/preimage/complete() path as an unchecked
  // cast. The pre-existing (e) tests only exercise the OVER-LONG hashing branch;
  // this closes the SHORT non-conforming branch.
  // NOTE: an EMPTY sub is rejected one layer earlier (the auth middleware's
  // `missing_sub` → 401), so it is NOT in this set — these are all NON-EMPTY
  // subs that pass the JWT gate and reach the handler's decode boundary.
  const nonConformingSubs: ReadonlyArray<readonly [string, string]> = [
    ["uppercase", "id_ALICE"],
    ["digit-start (no id_ prefix)", "9alice"],
    ["embedded single colon", "id_alice:bob"],
    ["embedded double colon", "id_alice::bob"],
    ["missing id_ prefix", "alice"],
  ];

  for (const [label, sub] of nonConformingSubs) {
    it(`non-conforming sub (${label}) → 422, NO grant`, async () => {
      const spy = makeSpyCompletion();
      const app = buildApp(compositionWith(spy));
      const token = mintJwt({ sub, tenant: "mibera" });
      const res = await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, token);
      // The decode boundary rejects with the typed 422 — never a 500, never 200.
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_identity");
      // THE INVARIANT: the grant path was never reached.
      expect(spy.calls).toHaveLength(0);
    });
  }
});

describe("POST /complete — (e) F-002 malformed body", () => {
  it("malformed body → typed 422, never a 500", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const token = mintJwt({ sub: "id_alice", tenant: "mibera" });
    // step_id missing → schema decode fails on the Effect channel → 422.
    const res = await post(app, VERIFY_ACTIVITY_ID, { not_step_id: 1 }, token);
    expect(res.status).toBe(422);
    expect(spy.calls).toHaveLength(0);
  });

  it("unknown activity_id → 404, no grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const token = mintJwt({ sub: "id_alice", tenant: "mibera" });
    const res = await post(app, "act_doesnotexist", { step_id: "step_verify" }, token);
    expect(res.status).toBe(404);
    expect(spy.calls).toHaveLength(0);
  });

  it("degraded (no DB) → completed:false, no crash", async () => {
    const app = buildApp({ write: null });
    const token = mintJwt({ sub: "id_alice", tenant: "mibera" });
    const res = await post(app, VERIFY_ACTIVITY_ID, { step_id: "step_verify" }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean };
    expect(body.completed).toBe(false);
  });
});
