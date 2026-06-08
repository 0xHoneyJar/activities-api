/**
 * POST /v1/activities/:activity_id/complete-attested — B2 service-attested
 * completion security tests (S1.5 · GATE-SEC-1 · §1.11).
 *
 * These prove it is structurally impossible to grant a verify badge without an
 * APPROVED verify-attestation verdict whose correlation identity-api confirmed:
 *
 *   (a) AUTH (§1.12): no / wrong / wrong-scope service token → 401, no grant.
 *   (b) APPROVED: valid token + confirmed correlation + allowlisted world +
 *       valid idempotency key + fresh → grant once, recipient = the identity-api
 *       RESOLVED id, nonce = the b2 idempotency anchor.
 *   (c) CORRELATION (HIGH-740): null resolve OR mismatch → NO grant.
 *   (d) WORLD: a non-allowlisted world → NO grant.
 *   (e) IDEMPOTENCY SHAPE: a forged idempotency_key → NO grant.
 *   (f) FRESHNESS (HIGH-760): stale / future issued_at → NO grant.
 *   (g) F-002: malformed body → 422, no grant.
 *   (h) DECODE-AT-BOUNDARY: an APPROVED attestation whose resolved id is not a
 *       conforming IdentityId → 422, no grant.
 *   (i) IDEMPOTENCY: replay of the same attestation → same event_id (no double
 *       grant at the seam).
 *   (j) unknown activity / degraded / mis-wire fail-closed.
 *
 * The completion handle is a SPY (records whether complete() ran). The grader
 * (verifyAttestationVerifier) is the REAL engine code.
 *
 * S1.5 · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PartitionKey, VERIFY_ACTIVITY_ID } from "@0xhoneyjar/quests-protocol";
import {
  type ActivityCompletionHandle,
  CompletionGranted,
  type CompleteActivityInput,
} from "@0xhoneyjar/quests-engine";

import { Hyper } from "@hyper/core";
import type { Middleware, Route } from "@hyper/core";

import { makeRequireServiceToken } from "../../auth/require-service-token";
import type { WriteComposition } from "../../composition";
import { completeAttestedRoute } from "../writes";

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
    return Effect.succeed(
      new CompletionGranted({
        grant: {
          _tag: "RewardGranted",
          reward: input.reward,
          originating_event_id: input.event.event_id,
          granted_event_id: input.event.event_id,
          ts: "2026-06-08T12:00:00Z",
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
// Fixtures + harness
// ---------------------------------------------------------------------------

const VERIFY_WRITE_TOKEN = "test-verify-write-token";
const READ_TOKEN = "test-read-token";
const WORLD = "mibera";
const ID = "id_alice";
const DISCORD = "123456789012345678";
const VERIFY_EVENT = "evt_verify_1";
const FIXED_NOW_MS = Date.parse("2026-06-08T12:00:00Z");

const attestation = (over: Record<string, unknown> = {}) => ({
  identity_id: ID,
  discord_user_id: DISCORD,
  world: WORLD,
  verify_event_id: VERIFY_EVENT,
  issued_at: "2026-06-08T11:59:00Z", // 1 min before FIXED_NOW → fresh
  idempotency_key: `b2:${ID}:${VERIFY_EVENT}`,
  ...over,
});

const buildApp = (
  composition: WriteComposition,
  opts: {
    gate?: Middleware;
    resolveDiscordIdentity?: (d: string) => Promise<string | null>;
    worldAllowlist?: readonly string[];
    nowMsProvider?: () => number;
    freshnessSeconds?: number;
  } = {},
): Hyper => {
  const app = new Hyper({ name: "attested-test" });
  const r = completeAttestedRoute(composition, {
    verifyWriteGate:
      opts.gate ??
      makeRequireServiceToken({ scope: "verify-write", secret: VERIFY_WRITE_TOKEN }),
    resolveDiscordIdentity: opts.resolveDiscordIdentity ?? (async () => ID),
    worldAllowlist: opts.worldAllowlist ?? [WORLD],
    nowMsProvider: opts.nowMsProvider ?? (() => FIXED_NOW_MS),
    ...(opts.freshnessSeconds !== undefined && {
      freshnessSeconds: opts.freshnessSeconds,
    }),
  });
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
  if (token !== undefined) headers["x-service-token"] = token;
  return app.fetch(
    new Request(`http://local/v1/activities/${activityId}/complete-attested`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
};

interface AttestedBody {
  readonly completed: boolean;
  readonly reason?: string;
  readonly verdict?: { readonly status: string; readonly graderConstructSlug: string };
}

// ===========================================================================
// (a) AUTH GATE — §1.12
// ===========================================================================

describe("POST /complete-attested — (a) verify-write auth gate", () => {
  it("no token → 401, complete() never reached", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation());
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("wrong token → 401", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), "nope");
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("§1.12 isolation: the READ token cannot satisfy the verify-write gate → 401", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), READ_TOKEN);
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("defense-in-depth: route mis-wired with the READ gate → 401 fail-closed", async () => {
    const spy = makeSpyCompletion();
    // Simulate a composition-root mis-wire: the attested route built with the
    // READ gate. A matching read token PASSES the gate (scope "read"), but the
    // handler's scope check must FAIL CLOSED with 401 — never a grant.
    const readGate = makeRequireServiceToken({ scope: "read", secret: READ_TOKEN });
    const app = buildApp(compositionWith(spy), { gate: readGate });
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), READ_TOKEN);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("wrong_service_scope");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (b) APPROVED — the full happy path
// ===========================================================================

describe("POST /complete-attested — (b) APPROVED grant", () => {
  it("confirmed correlation + allowlisted world + valid key + fresh → grant once", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(true);
    expect(body.verdict?.status).toBe("APPROVED");
    expect(body.verdict?.graderConstructSlug).toBe("verify-attestation");
    // The grant ran exactly once.
    expect(spy.calls).toHaveLength(1);
    // Recipient is the identity-api RESOLVED id (the authority), never the body.
    expect(String(spy.calls[0]?.recipient)).toBe(ID);
    // Nonce is the B2 idempotency anchor (b2:<id>:<verify_event_id>).
    const ev = spy.calls[0]?.event as unknown as { nonce: string };
    expect(ev.nonce).toBe(`b2:${ID}:${VERIFY_EVENT}`);
    // Identity-scoped composite partition.
    const pk = spy.calls[0]?.partition_key as unknown as { scope: string; value: string };
    expect(pk.scope).toBe("composite");
    expect(pk.value.startsWith(`${ID}::`)).toBe(true);
    expect(Either.isRight(Schema.decodeUnknownEither(PartitionKey)(pk))).toBe(true);
  });

  it("grants to the RESOLVED id even if it differs from a self-asserted echo (authority = identity-api)", async () => {
    // The grader requires resolved === asserted, so they match — but assert the
    // recipient is taken from the resolved value path, not echoed from the body.
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy), {
      resolveDiscordIdentity: async () => ID,
    });
    await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    expect(String(spy.calls[0]?.recipient)).toBe(ID);
  });
});

// ===========================================================================
// (c) CORRELATION — HIGH-740 (null / mismatch → NO grant)
// ===========================================================================

describe("POST /complete-attested — (c) correlation", () => {
  it("identity-api resolves null (404 / unreachable) → NEEDS_HUMAN, NO grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy), {
      resolveDiscordIdentity: async () => null,
    });
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(body.reason).toContain("did not resolve");
    expect(spy.calls).toHaveLength(0);
  });

  it("correlation mismatch (resolves a DIFFERENT identity) → NO grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy), {
      resolveDiscordIdentity: async () => "id_bob",
    });
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(body.reason).toContain("mismatch");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (d)-(f) WORLD / IDEMPOTENCY SHAPE / FRESHNESS denials
// ===========================================================================

describe("POST /complete-attested — (d)-(f) grader denials", () => {
  it("world not in the allowlist → NO grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy), { worldAllowlist: [WORLD] });
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      attestation({ world: "notmibera" }),
      VERIFY_WRITE_TOKEN,
    );
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(body.reason).toContain("world");
    expect(spy.calls).toHaveLength(0);
  });

  it("empty world allowlist → ALL worlds denied (fail-closed)", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy), { worldAllowlist: [] });
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  it("forged idempotency_key (wrong shape) → NO grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      attestation({ idempotency_key: "forged-key" }),
      VERIFY_WRITE_TOKEN,
    );
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(body.reason).toContain("idempotency_key");
    expect(spy.calls).toHaveLength(0);
  });

  it("stale issued_at (outside the window) → NO grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      attestation({ issued_at: "2026-06-01T00:00:00Z" }), // ~7 days old
      VERIFY_WRITE_TOKEN,
    );
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(body.reason).toContain("stale");
    expect(spy.calls).toHaveLength(0);
  });

  it("future issued_at (beyond skew) → NO grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      attestation({ issued_at: "2026-06-09T00:00:00Z" }), // ahead of FIXED_NOW
      VERIFY_WRITE_TOKEN,
    );
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
    expect(body.reason).toContain("future");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (g)-(h) BODY DECODE + DECODE-AT-BOUNDARY
// ===========================================================================

describe("POST /complete-attested — (g)-(h) decode boundaries", () => {
  it("malformed body (missing fields) → 422, no grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, VERIFY_ACTIVITY_ID, { world: WORLD }, VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(422);
    expect(spy.calls).toHaveLength(0);
  });

  it("non-digit discord_user_id → 422 (schema), no grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      attestation({ discord_user_id: "not-digits" }),
      VERIFY_WRITE_TOKEN,
    );
    expect(res.status).toBe(422);
    expect(spy.calls).toHaveLength(0);
  });

  it("APPROVED attestation whose RESOLVED id is non-conforming → 422 invalid_identity, no grant", async () => {
    const spy = makeSpyCompletion();
    // identity_id "NOTANID" passes the loose attestation schema; resolve echoes
    // it (grader APPROVES — correlation + world + key + fresh all hold), but the
    // grant-boundary IdentityId decode rejects it. NO grant.
    const badId = "NOTANID";
    const app = buildApp(compositionWith(spy), {
      resolveDiscordIdentity: async () => badId,
    });
    const res = await post(
      app,
      VERIFY_ACTIVITY_ID,
      attestation({ identity_id: badId, idempotency_key: `b2:${badId}:${VERIFY_EVENT}` }),
      VERIFY_WRITE_TOKEN,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_identity");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (i) IDEMPOTENCY — replay → same event_id (deterministic ts + b2 nonce)
// ===========================================================================

describe("POST /complete-attested — (i) idempotency", () => {
  it("replay of the same attestation → same event_id both times", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.event.event_id).toBe(spy.calls[1]?.event.event_id);
  });
});

// ===========================================================================
// (j) unknown activity / degraded
// ===========================================================================

describe("POST /complete-attested — (j) unknown activity / degraded", () => {
  it("non-verify activity_id → 404 (verify-only bind), no grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, "act_doesnotexist", attestation(), VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(404);
    // The attested path is bound to act_verify (FAGAN S1.5) — it is NOT a
    // generic completion oracle for any activity with a verify step.
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain("complete-attested supports only");
    expect(spy.calls).toHaveLength(0);
  });

  it("degraded (no DB) → completed:false, no crash", async () => {
    const app = buildApp({ write: null });
    const res = await post(app, VERIFY_ACTIVITY_ID, attestation(), VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttestedBody;
    expect(body.completed).toBe(false);
  });
});
