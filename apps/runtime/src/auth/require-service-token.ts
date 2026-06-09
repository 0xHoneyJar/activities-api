/**
 * require-service-token.ts — the service-to-service auth gate (S1.5/S1.6 · §1.12).
 *
 * A Hyper middleware (sibling to {@link makeRequireIdentity}) that gates a route
 * on a per-consumer scoped `X-Service-Token`, with the SAME fail-closed posture:
 *   1. no secret configured for the scope → 401 (never serve);
 *   2. missing / empty header → 401;
 *   3. token mismatch (constant-time) → 401;
 *   4. only on an exact match → `next()`.
 *
 * ── LEAST PRIVILEGE (§1.12 · IMP-011) ────────────────────────────────────────
 *
 * There is NO shared write-capable token. Two distinct secrets, one per
 * consumer, each gated by a SEPARATELY-constructed middleware that knows ONLY
 * its own secret — so a route built with the read gate can never be satisfied by
 * the verify-write token and vice-versa:
 *
 *   | scope          | env                            | holder              | grants                    |
 *   | read           | ACTIVITIES_READ_TOKEN          | mibera-dimensions   | GET …/identities/:id/badges |
 *   | verify-write   | ACTIVITIES_VERIFY_WRITE_TOKEN  | freeside-characters | POST …/complete (act_verify) |
 *
 * A leaked read token cannot write; a leaked verify-write token cannot read
 * arbitrary identities' streams (the C3 route is family-allowlisted +
 * correlation-gated, §1.11).
 *
 * ── CONSTANT-TIME COMPARE ────────────────────────────────────────────────────
 *
 * Tokens are compared via `timingSafeEqual` over SHA-256 digests of both sides.
 * Hashing to a fixed 32 bytes means the compare never throws on a length
 * mismatch and the comparison time does not vary with how many leading bytes
 * match — closing the timing side-channel (mirrors the constant-time posture of
 * the HS256 HMAC verify the JWT gate relies on).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { Middleware } from "@hyper/core";

/**
 * The least-privilege service-token scopes (§1.12). Each is a SEPARATELY-built
 * gate that knows only its own secret — a token for one scope can never satisfy
 * another. `admin-grant` is the most privileged (operator hand-picks badge
 * recipients); it is held only by the operator, never a consumer building.
 */
export type ServiceTokenScope = "read" | "verify-write" | "admin-grant";

const SERVICE_TOKEN_HEADER = "x-service-token";

/** Request-scoped record that a service token of a given scope authenticated. */
const SERVICE_AUTH = new WeakMap<Request, ServiceTokenScope>();

/** Read the scope a prior `requireServiceToken` run authenticated, if any. */
export const serviceScopeOf = (req: Request): ServiceTokenScope | undefined =>
  SERVICE_AUTH.get(req);

export interface ServiceTokenConfig {
  readonly scope: ServiceTokenScope;
  /** The expected token for this scope. Undefined/empty → the gate fails closed. */
  readonly secret: string | undefined;
}

/**
 * resolveServiceTokenConfig — read the scoped secret from env, no hardcoding.
 *   read         → ACTIVITIES_READ_TOKEN
 *   verify-write → ACTIVITIES_VERIFY_WRITE_TOKEN
 *   admin-grant  → ACTIVITIES_ADMIN_GRANT_TOKEN
 */
const SCOPE_ENV: Readonly<Record<ServiceTokenScope, string>> = {
  read: "ACTIVITIES_READ_TOKEN",
  "verify-write": "ACTIVITIES_VERIFY_WRITE_TOKEN",
  "admin-grant": "ACTIVITIES_ADMIN_GRANT_TOKEN",
};

export const resolveServiceTokenConfig = (
  scope: ServiceTokenScope,
  env: Record<string, string | undefined> = process.env,
): ServiceTokenConfig => ({
  scope,
  secret: env[SCOPE_ENV[scope]],
});

const unauthorized401 = (code: string): Response =>
  new Response(JSON.stringify({ error: "unauthorized", code }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Constant-time equality over fixed-length digests (never throws, no length leak). */
const constantTimeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(sha256(a), sha256(b));

/**
 * makeRequireServiceToken — build the service-token gate for one scope.
 *
 * Exposed as a factory (like {@link makeRequireIdentity}) so the composition
 * root supplies the resolved secret and tests inject a deterministic one. The
 * scope is closed over — the returned middleware accepts ONLY this scope's token.
 */
export const makeRequireServiceToken = (config: ServiceTokenConfig): Middleware => {
  return async ({ req, next }) => {
    // Fail CLOSED: an unconfigured secret refuses everything rather than
    // serving a service route unauthenticated.
    if (config.secret === undefined || config.secret.length === 0) {
      return unauthorized401("no_service_token_configured");
    }
    const provided = req.headers.get(SERVICE_TOKEN_HEADER);
    if (provided === null || provided.length === 0) {
      return unauthorized401("missing_service_token");
    }
    if (!constantTimeEqual(provided, config.secret)) {
      return unauthorized401("invalid_service_token");
    }
    SERVICE_AUTH.set(req, config.scope);
    return next();
  };
};
