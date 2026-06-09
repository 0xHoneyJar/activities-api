/**
 * POST /v1/activities/:activity_id/complete-admin — First Light admin-grant
 * security tests (GATE-SEC-1 · operator-attested founding grant).
 *
 *   (a) AUTH (§1.12): no / wrong / wrong-scope token → 401, complete() unreached.
 *   (b) APPROVED: admin token + valid identity_id → grant once, recipient = the
 *       decoded identity_id, nonce = firstlight:<id>, weight in metadata.
 *   (c) DECODE-AT-BOUNDARY: non-conforming recipient identity_id → 422, no grant.
 *   (d) BODY: missing identity_id / out-of-range weight → 422, no grant.
 *   (e) BIND: a non-first-light activity → 404 (not a generic admin oracle).
 *   (f) idempotency: re-grant same identity → same identity-scoped partition +
 *       expected_tip_hash=null, so the seam rejects the 2nd append (no double grant).
 *
 * The completion handle is a SPY; the grader (firstLightAdminVerifier) is real.
 *
 * First Light · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PartitionKey, FIRST_LIGHT_ACTIVITY_ID } from "@0xhoneyjar/quests-protocol";
import {
  type ActivityCompletionHandle,
  CompletionGranted,
  type CompleteActivityInput,
} from "@0xhoneyjar/quests-engine";

import { Hyper } from "@hyper/core";
import type { Middleware, Route } from "@hyper/core";

import { makeRequireServiceToken } from "../../auth/require-service-token";
import type { WriteComposition } from "../../composition";
import { completeAdminRoute } from "../writes";

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

const ADMIN_TOKEN = "test-admin-grant-token";
const READ_TOKEN = "test-read-token";
const VERIFY_WRITE_TOKEN = "test-verify-write-token";
const ID = "id_alice";

const buildApp = (composition: WriteComposition, gate?: Middleware): Hyper => {
  const app = new Hyper({ name: "admin-test" });
  const adminGate =
    gate ?? makeRequireServiceToken({ scope: "admin-grant", secret: ADMIN_TOKEN });
  app.use([
    completeAdminRoute(composition, { adminGate }),
  ] as unknown as readonly Route[]);
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
    new Request(`http://local/v1/activities/${activityId}/complete-admin`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
};

interface AdminBody {
  readonly completed: boolean;
  readonly reason?: string;
  readonly verdict?: { readonly status: string; readonly graderConstructSlug: string };
}

// ===========================================================================
// (a) AUTH GATE — §1.12
// ===========================================================================

describe("POST /complete-admin — (a) admin-grant auth gate", () => {
  it("no token → 401, complete() unreached", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID });
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("wrong token → 401", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID }, "nope");
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("§1.12: read + verify-write tokens cannot satisfy the admin gate → 401", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    for (const tok of [READ_TOKEN, VERIFY_WRITE_TOKEN]) {
      const res = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID }, tok);
      expect(res.status).toBe(401);
    }
    expect(spy.calls).toHaveLength(0);
  });

  it("defense-in-depth: route mis-wired with a non-admin gate → 401 fail-closed", async () => {
    const spy = makeSpyCompletion();
    const readGate = makeRequireServiceToken({ scope: "read", secret: READ_TOKEN });
    const app = buildApp(compositionWith(spy), readGate);
    const res = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID }, READ_TOKEN);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("wrong_service_scope");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (b) APPROVED grant
// ===========================================================================

describe("POST /complete-admin — (b) APPROVED grant", () => {
  it("admin token + valid identity_id + weight → grant once, recipient + nonce + metadata correct", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(
      app,
      FIRST_LIGHT_ACTIVITY_ID,
      { identity_id: ID, weight: 2 },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminBody;
    expect(body.completed).toBe(true);
    expect(body.verdict?.status).toBe("APPROVED");
    expect(body.verdict?.graderConstructSlug).toBe("first-light-admin");
    expect(spy.calls).toHaveLength(1);
    expect(String(spy.calls[0]?.recipient)).toBe(ID);
    const ev = spy.calls[0]?.event as unknown as { nonce: string };
    expect(ev.nonce).toBe(`firstlight:${ID}`);
    // weight rides as metadata (founding=2), not power
    const meta = spy.calls[0]?.sourceMetadata as { weight?: number; cohort?: string };
    expect(meta.weight).toBe(2);
    expect(meta.cohort).toBe("bm-fam-working-group");
    // identity-scoped composite partition
    const pk = spy.calls[0]?.partition_key as unknown as { scope: string; value: string };
    expect(pk.value.startsWith(`${ID}::`)).toBe(true);
    expect(Either.isRight(Schema.decodeUnknownEither(PartitionKey)(pk))).toBe(true);
  });

  it("weight defaults to 1 (supporting) when omitted", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: "id_bob" }, ADMIN_TOKEN);
    const meta = spy.calls[0]?.sourceMetadata as { weight?: number };
    expect(meta.weight).toBe(1);
  });
});

// ===========================================================================
// (c)-(e) decode boundary / body / activity bind
// ===========================================================================

describe("POST /complete-admin — (c)-(e) boundaries", () => {
  it("non-conforming recipient identity_id → 422 invalid_identity, no grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    for (const bad of ["id_ALICE", "NOTANID", "alice"]) {
      const res = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: bad }, ADMIN_TOKEN);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_identity");
    }
    expect(spy.calls).toHaveLength(0);
  });

  it("malformed body (missing identity_id / bad weight) → 422, no grant", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const r1 = await post(app, FIRST_LIGHT_ACTIVITY_ID, { weight: 1 }, ADMIN_TOKEN);
    expect(r1.status).toBe(422);
    const r2 = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID, weight: 3 }, ADMIN_TOKEN);
    expect(r2.status).toBe(422);
    expect(spy.calls).toHaveLength(0);
  });

  it("non-first-light activity → 404 (verify-only bind, not a generic admin oracle)", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    const res = await post(app, "act_verify", { identity_id: ID }, ADMIN_TOKEN);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain("complete-admin supports only");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (f) idempotency + degraded
// ===========================================================================

describe("POST /complete-admin — (f) idempotency / degraded", () => {
  it("re-grant same identity → same partition + expected_tip_hash null (seam CAS rejects the 2nd → no double grant)", async () => {
    const spy = makeSpyCompletion();
    const app = buildApp(compositionWith(spy));
    await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID }, ADMIN_TOKEN);
    await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID }, ADMIN_TOKEN);
    expect(spy.calls).toHaveLength(2);
    // Idempotency anchor is the identity-scoped PARTITION (not event_id): the
    // ts is wall-clock = the real grant time, so event_ids differ by design.
    // Same identity → same partition + expected_tip_hash null → the postgres
    // seam CAS-rejects the 2nd append (no double grant; seam-side proven in
    // complete.integration.test.ts).
    const pk0 = spy.calls[0]?.partition_key as unknown as { value: string };
    const pk1 = spy.calls[1]?.partition_key as unknown as { value: string };
    expect(pk0.value).toBe(pk1.value);
    expect(spy.calls[0]?.expected_tip_hash).toBeNull();
  });

  it("degraded (no DB) → completed:false, no crash", async () => {
    const app = buildApp({ write: null });
    const res = await post(app, FIRST_LIGHT_ACTIVITY_ID, { identity_id: ID }, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminBody;
    expect(body.completed).toBe(false);
  });
});
