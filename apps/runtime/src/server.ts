/**
 * server.ts — the activities-api Hyper runtime entry (SDD §5 · FR-A1 · G-1).
 *
 * A THIN Hyper (hyperjs.ai) HTTP skin over the activities Effect engine. Hyper
 * is the cluster-proven runtime (identity-api runs Hyper-over-Effect); OQ-2 is
 * resolved in Hyper's favor. There is no Hyper↔Effect friction: Hyper handlers
 * return values (the framework coerces them to Responses), and the route
 * handlers `Effect.runPromise` the engine's port Effects behind that boundary
 * (see routes/_shared.ts::runRead). The engine stays fully Effect-native.
 *
 * Serves the READ plane first:
 *   GET /health                    — liveness (canonical, binds 0.0.0.0)
 *   GET /.well-known/beacon.json   — the rendered BeaconV3 building identity
 *   GET /v1/activities             — get-active-activities
 *   GET /v1/progress               — get-progress
 *   GET /v1/badges                 — get-badges
 *   GET /v1/raffle-entries         — get-raffle-entries
 *   GET /v1/kinds                  — list-kinds
 *   GET /openapi.json              — generated OpenAPI 3.1 (one decl → spec)
 *
 * MCP is a GENERATED artifact (app.toMCPManifest()), NOT a separate server.
 *
 * Composition root: wires a `pg.Pool` from TENANT_CUBQUEST_DATABASE_URL (or
 * DATABASE_URL) — NOT hardcoded. The pool is optional at boot so /health +
 * /beacon answer before cubquest-db is bound (T-A5 deploy ordering).
 *
 * Listener: `hostname: "0.0.0.0"` is MANDATORY (CASCADE-GOTCHA — Hyper's
 * .listen() defaults to localhost off-prod, which defeats container
 * healthchecks). NEVER remove. Railway does NOT auto-inject PORT for Dockerfile
 * services — we read process.env.PORT explicitly.
 */

import { Hyper, type Route } from "@hyper/core";
import { hyperLog } from "@hyper/log";
import { openapiPlugin, openapiHandlers } from "@hyper/openapi";

import { route } from "./app";
import { buildComposition } from "./composition";
import { checkCapabilities } from "./beacon";
import {
  makeRequireServiceToken,
  resolveServiceTokenConfig,
} from "./auth/require-service-token";
import {
  makeResolveDiscordIdentity,
  resolveIdentityApiConfig,
} from "./clients/identity-resolve";

import { makeHealthRoute } from "./routes/health";
import { beaconRoute } from "./routes/beacon";
import {
  activitiesRoute,
  badgesByIdentityRoute,
  badgesRoute,
  kindsRoute,
  progressRoute,
  raffleRoute,
} from "./routes/reads";
import {
  completeAttestedRoute,
  completeRoute,
  parseWorldAllowlist,
} from "./routes/writes";

// ---------------------------------------------------------------------------
// Composition root — resolve the DB binding from env (NO hardcoding).
// ---------------------------------------------------------------------------
const composition = buildComposition();

// ---------------------------------------------------------------------------
// Service-token gates (§1.12) — built ONCE from env. The `read` gate (held by
// mibera-dimensions) accepts ONLY ACTIVITIES_READ_TOKEN; the `verify-write`
// gate (held by freeside-characters) ONLY ACTIVITIES_VERIFY_WRITE_TOKEN. Neither
// satisfies the other. Fail-closed if a secret is unset (the route 401s).
// ---------------------------------------------------------------------------
const readGate = makeRequireServiceToken(resolveServiceTokenConfig("read"));
const verifyWriteGate = makeRequireServiceToken(
  resolveServiceTokenConfig("verify-write"),
);

// The net-new outbound identity-api resolve client (B2 correlation, §1.11.1) +
// the §1.11.2 world allowlist. Both fail-closed: no IDENTITY_API_URL → resolve
// returns null (grader denies); empty allowlist → every world denied.
const resolveDiscordIdentity = makeResolveDiscordIdentity(
  resolveIdentityApiConfig(),
);
const worldAllowlist = parseWorldAllowlist(process.env.ACTIVITIES_WORLD_ALLOWLIST);

// ---------------------------------------------------------------------------
// Boot-time beacon capability assertion (G-2 / IMP-011). Observable, not fatal
// — a beacon drift logs a warning rather than killing liveness.
// ---------------------------------------------------------------------------
const capCheck = checkCapabilities();
if (!capCheck.ok) {
  console.warn(
    `[activities-api] beacon capability drift — missing: ${capCheck.missing.join(", ")}`,
  );
} else {
  console.log(
    `[activities-api] beacon resolves ${capCheck.resolved.length} capabilities: ${capCheck.resolved.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// App composition.
// ---------------------------------------------------------------------------
export const app = new Hyper({ name: "activities-api" })
  .use(hyperLog({ service: "activities-api" }))
  .use(openapiPlugin())
  .use([
    makeHealthRoute(composition),
    beaconRoute,
    kindsRoute,
    activitiesRoute(composition),
    progressRoute(composition),
    badgesRoute(composition),
    // Service-token read route (§1.12) — cross-identity badge read for the
    // mibera-dimensions surface, behind the `read` gate (never the self path).
    badgesByIdentityRoute(composition, readGate),
    raffleRoute(composition),
    // WRITE plane (GATE-SEC-1 · VB.3) — the completion route, behind
    // requireIdentity. The grant path is reachable ONLY through an APPROVED
    // substrate verdict (see routes/writes.ts header).
    completeRoute(composition),
    // B2 service-attested completion (S1.5) — verify-write service token +
    // identity-api correlation + verify-attestation grader → same chokepoint.
    completeAttestedRoute(composition, {
      verifyWriteGate,
      resolveDiscordIdentity,
      worldAllowlist,
    }),
  ] as unknown as readonly Route[]);

// ---------------------------------------------------------------------------
// OpenAPI — mounted AFTER routes so the manifest includes the full graph.
// One route declaration drives both the handler AND this spec (FR-A1: one decl
// → handler + OpenAPI). MCP is the same projection via app.toMCPManifest().
// ---------------------------------------------------------------------------
const openapi = openapiHandlers(app as never, {
  title: "activities-api",
  version: "0.1.0",
});

const openapiSpec = route
  .get("/openapi.json")
  .handle(({ req }: { req: Request }) => openapi.spec(req));

app.use([openapiSpec] as unknown as readonly Route[]);

// ---------------------------------------------------------------------------
// Listen. hostname "0.0.0.0" is mandatory (see header). PORT read explicitly
// (Railway Dockerfile services do not auto-inject it). banner:true so the
// "listening on http://0.0.0.0:PORT" line prints even under NODE_ENV=production.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  app.listen({ port, hostname: "0.0.0.0", banner: true });
  // Explicit, env-agnostic confirmation line (acceptance criterion).
  console.log(`listening on http://0.0.0.0:${port}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[activities-api] ${sig} — draining + closing pool`);
    await composition.close();
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

export default app;
