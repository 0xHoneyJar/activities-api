/**
 * GET /v1/identities/:identity_id/badges — S1.6 service-token read route tests.
 *
 * The load-bearing properties for the C4 read plane:
 *
 *   (a) AUTH GATE (§1.12): no / wrong / wrong-SCOPE service token → 401, and
 *       the event-store query is NEVER reached (the gate short-circuits).
 *   (b) PROJECTION (NFR-3): a valid read token over REAL fixture events runs
 *       the REAL projectEarnedBadges — BadgeIssued + ActivityCompleted collapse
 *       into the deduplicated, art-resolved EarnedBadge[].
 *   (c) PATH-PARAM SCOPING: the query is pinned to the decoded PATH identity
 *       (never widened), with a clamped limit.
 *   (d) DECODE-AT-BOUNDARY: a non-conforming identity_id path param → degraded
 *       empty, query NEVER reached (no predicate widening).
 *   (e) DEGRADED: no DB bound → degraded envelope, no crash.
 *
 * The event-store query is a SPY (records the filter + returns fixtures), so the
 * route's gate + scoping + projection are asserted without a live Postgres. The
 * projection itself is the REAL engine code (NFR-3 — local-green over the real
 * projection, not a mock).
 *
 * S1.6 · 2026-06-08 · mibera-badge-surface.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { EventFilter } from "@0xhoneyjar/quests-protocol";

import { Hyper } from "@hyper/core";
import type { Middleware, Route } from "@hyper/core";

import { makeRequireServiceToken } from "../../auth/require-service-token";
import type { ActivitiesReadSurface, Composition } from "../../composition";
import { badgesByIdentityRoute } from "../reads";

// ---------------------------------------------------------------------------
// Event-store query spy + minimal read surface
// ---------------------------------------------------------------------------

interface QuerySpy {
  readonly calls: EventFilter[];
}

const makeReadSurface = (
  events: readonly unknown[],
  spy?: QuerySpy,
): ActivitiesReadSurface =>
  ({
    eventStore: {
      port: {
        query: (filter: EventFilter) => {
          spy?.calls.push(filter);
          return Effect.succeed(events);
        },
      },
    },
    progress: {},
    reward: {},
  }) as unknown as ActivitiesReadSurface;

const compositionWith = (
  surface: ActivitiesReadSurface | null,
): Composition => ({
  surface,
  write: null,
  pool: null,
  source: surface === null ? "none" : "DATABASE_URL",
  close: async () => {},
});

// ---------------------------------------------------------------------------
// Service tokens — two DISTINCT secrets (§1.12). The read route is built with
// the read gate; the verify-write token is a different string the read gate
// must reject.
// ---------------------------------------------------------------------------

const READ_TOKEN = "test-read-token";
const VERIFY_WRITE_TOKEN = "test-verify-write-token";

const buildApp = (composition: Composition, gate?: Middleware): Hyper => {
  const readGate =
    gate ?? makeRequireServiceToken({ scope: "read", secret: READ_TOKEN });
  const app = new Hyper({ name: "reads-test" });
  app.use([
    badgesByIdentityRoute(composition, readGate),
  ] as unknown as readonly Route[]);
  return app;
};

const get = (
  app: Hyper,
  identityId: string,
  token?: string,
  query = "",
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["x-service-token"] = token;
  return app.fetch(
    new Request(`http://local/v1/identities/${identityId}/badges${query}`, {
      headers,
    }),
  );
};

// ---------------------------------------------------------------------------
// Fixture events (the same shapes the projection's own unit tests use)
// ---------------------------------------------------------------------------

const BADGE_ISSUED_ID = "https://schemas.freeside.thj/badge-issued/v1.0.0";
const ACTIVITY_COMPLETED_ID =
  "https://schemas.freeside.thj/activity-completed/v1.0.0";

const badgeIssued = (over: Record<string, unknown> = {}) => ({
  $id: BADGE_ISSUED_ID,
  event_id: "evt_b1",
  ts: "2026-06-08T00:00:00Z",
  activity_id: "act_donationraffle",
  identity_id: "id_alice",
  snapshot_id: "snap_donationraffle2026q2",
  badge_family_id: "donation-raffle",
  ...over,
});

const activityCompleted = (over: Record<string, unknown> = {}) => ({
  $id: ACTIVITY_COMPLETED_ID,
  event_id: "evt_b2",
  ts: "2026-06-08T01:00:00Z",
  activity_id: "act_verify",
  identity_id: "id_alice",
  ...over,
});

interface BadgeBody {
  readonly items: ReadonlyArray<{
    readonly badge_family_id: string;
    readonly uri: string | null;
    readonly source: string;
  }>;
  readonly total_count: number | null;
  readonly next_cursor: string | null;
  readonly completeness: { readonly status: string };
}

// ===========================================================================
// (a) AUTH GATE — §1.12 (no / wrong / wrong-scope token → 401, query unreached)
// ===========================================================================

describe("GET /identities/:id/badges — (a) service-token auth gate", () => {
  it("no service token → 401, the query is never reached", async () => {
    const spy: QuerySpy = { calls: [] };
    const app = buildApp(compositionWith(makeReadSurface([], spy)));
    const res = await get(app, "id_alice");
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("wrong service token → 401, query never reached", async () => {
    const spy: QuerySpy = { calls: [] };
    const app = buildApp(compositionWith(makeReadSurface([], spy)));
    const res = await get(app, "id_alice", "not-the-read-token");
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("§1.12 isolation: the verify-write token cannot satisfy the read gate → 401", async () => {
    const spy: QuerySpy = { calls: [] };
    // The route is built with the READ gate (READ_TOKEN). Presenting the
    // verify-write secret — a DISTINCT string — must be rejected: a leaked
    // verify-write token can never read arbitrary identities' badges.
    const app = buildApp(compositionWith(makeReadSurface([], spy)));
    const res = await get(app, "id_alice", VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("defense-in-depth: route mis-wired with a non-read gate → 401 (fail-closed), query unreached", async () => {
    const spy: QuerySpy = { calls: [] };
    // Simulate a composition-root MIS-WIRE: the read route built with the
    // VERIFY-WRITE gate. A matching verify-write token PASSES the gate (scope
    // "verify-write" authenticated), but the handler's scope check must FAIL
    // CLOSED with 401 — never a 200, even an empty one (FAGAN S1.6 finding).
    const wrongGate = makeRequireServiceToken({
      scope: "verify-write",
      secret: VERIFY_WRITE_TOKEN,
    });
    const app = buildApp(compositionWith(makeReadSurface([], spy)), wrongGate);
    const res = await get(app, "id_alice", VERIFY_WRITE_TOKEN);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("wrong_service_scope");
    expect(spy.calls).toHaveLength(0);
  });
});

// ===========================================================================
// (b) PROJECTION — NFR-3: REAL projectEarnedBadges over REAL fixtures
// ===========================================================================

describe("GET /identities/:id/badges — (b) real projection (NFR-3)", () => {
  it("valid read token → BadgeIssued + ActivityCompleted collapse into EarnedBadge[]", async () => {
    const app = buildApp(
      compositionWith(makeReadSurface([badgeIssued(), activityCompleted()])),
    );
    const res = await get(app, "id_alice", READ_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BadgeBody;
    // Two distinct families, sorted by issued_at ascending (the REAL projection).
    expect(body.items.map((b) => b.badge_family_id)).toEqual([
      "donation-raffle",
      "verify",
    ]);
    expect(body.total_count).toBe(2);
    // Art resolved from STATIC_BADGE_REGISTRY (the display payoff).
    const donation = body.items.find(
      (b) => b.badge_family_id === "donation-raffle",
    );
    expect(donation?.uri).toContain("donation-raffle");
    expect(donation?.source).toBe("badge-issued");
    const verify = body.items.find((b) => b.badge_family_id === "verify");
    expect(verify?.source).toBe("activity-completed");
  });

  it("dedups one badge per family (earliest issued_at wins)", async () => {
    const later = badgeIssued({ event_id: "later", ts: "2026-06-09T00:00:00Z" });
    const earlier = badgeIssued({
      event_id: "earlier",
      ts: "2026-06-07T00:00:00Z",
    });
    const app = buildApp(compositionWith(makeReadSurface([later, earlier])));
    const res = await get(app, "id_alice", READ_TOKEN);
    const body = (await res.json()) as BadgeBody & {
      items: ReadonlyArray<{ event_id?: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.total_count).toBe(1);
  });

  it("identity with no badge-bearing events → empty page (not degraded)", async () => {
    const app = buildApp(compositionWith(makeReadSurface([])));
    const res = await get(app, "id_alice", READ_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BadgeBody;
    expect(body.items).toHaveLength(0);
    expect(body.completeness.status).toBe("full");
  });
});

// ===========================================================================
// (c) PATH-PARAM SCOPING — query pinned to the decoded path identity + limit
// ===========================================================================

describe("GET /identities/:id/badges — (c) path-param scoping", () => {
  it("scopes the query to the PATH identity (not a body/query param)", async () => {
    const spy: QuerySpy = { calls: [] };
    const app = buildApp(compositionWith(makeReadSurface([], spy)));
    await get(app, "id_bob", READ_TOKEN);
    expect(spy.calls).toHaveLength(1);
    expect(String(spy.calls[0]?.identity_id)).toBe("id_bob");
  });

  it("clamps the limit query param (default 50; explicit honored)", async () => {
    const spyDefault: QuerySpy = { calls: [] };
    const appDefault = buildApp(
      compositionWith(makeReadSurface([], spyDefault)),
    );
    await get(appDefault, "id_alice", READ_TOKEN);
    expect(spyDefault.calls[0]?.limit).toBe(50);

    const spyExplicit: QuerySpy = { calls: [] };
    const appExplicit = buildApp(
      compositionWith(makeReadSurface([], spyExplicit)),
    );
    await get(appExplicit, "id_alice", READ_TOKEN, "?limit=5");
    expect(spyExplicit.calls[0]?.limit).toBe(5);
  });
});

// ===========================================================================
// (d) DECODE-AT-BOUNDARY — non-conforming path id → degraded, query unreached
// ===========================================================================

describe("GET /identities/:id/badges — (d) non-conforming identity_id", () => {
  const badIds: ReadonlyArray<readonly [string, string]> = [
    ["uppercase", "id_ALICE"],
    ["missing id_ prefix", "alice"],
  ];

  for (const [label, badId] of badIds) {
    it(`non-conforming path id (${label}) → degraded empty, NO query`, async () => {
      const spy: QuerySpy = { calls: [] };
      const app = buildApp(compositionWith(makeReadSurface([], spy)));
      const res = await get(app, badId, READ_TOKEN);
      expect(res.status).toBe(200);
      const body = (await res.json()) as BadgeBody;
      expect(body.items).toHaveLength(0);
      // THE INVARIANT: a non-conforming id never widens the SQL predicate.
      expect(spy.calls).toHaveLength(0);
    });
  }
});

// ===========================================================================
// (e) DEGRADED — no DB bound → degraded envelope, no crash
// ===========================================================================

describe("GET /identities/:id/badges — (e) degraded (no DB)", () => {
  it("surface null → degraded envelope, 200, empty items", async () => {
    const app = buildApp(compositionWith(null));
    const res = await get(app, "id_alice", READ_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BadgeBody;
    expect(body.items).toHaveLength(0);
    expect(body.completeness.status).toBe("degraded");
  });
});
