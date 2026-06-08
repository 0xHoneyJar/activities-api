/**
 * identity-resolve — the net-new outbound client to identity-api (§1.11.1).
 *
 * GET {IDENTITY_API_URL}/v1/resolve/account/discord/:discord_user_id → { user_id }
 *
 * This is the ONLY outbound HTTP call activities-api makes. identity-api JWT
 * verify is otherwise fully OFFLINE (HS256, require-identity.ts) — there was no
 * outbound client before this. It exists for the B2 service-attested completion
 * (S1.5): the route cannot trust the caller's asserted `identity_id`, so
 * identity-api independently confirms the `discord_user_id` ↔ identity link
 * (HIGH-740). The grader treats a `null` resolve as a HARD deny.
 *
 * ── FAIL-CLOSED (scar · non-negotiable) ──────────────────────────────────────
 *
 * Returns `null` on ANY of:
 *   - no IDENTITY_API_URL configured (no correlation possible),
 *   - the discord id is not the §1.11 shape (`^[0-9]{1,32}$`),
 *   - network error / DNS / connection refused,
 *   - timeout (constant {@link RESOLVE_TIMEOUT_MS}, via AbortController),
 *   - non-200 status (incl. 404 = no link, any 4xx/5xx),
 *   - a malformed body (not `{ user_id: string }`).
 *
 * It NEVER throws (a throw would 500 the route, leaking infra state); it NEVER
 * treats an unreachable identity-api as "correlation passed". A `null` flows to
 * {@link verifyAttestationVerifier} which DENIES → NO grant.
 *
 * S1.5 · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

/** Constant resolve timeout (§1.11.1 — a bounded, non-configurable budget). */
export const RESOLVE_TIMEOUT_MS = 5_000;

/** The §1.11 discord-id shape (mirrors the VerifyAttestation schema). */
const DISCORD_ID_RE = /^[0-9]{1,32}$/;

export interface IdentityResolveConfig {
  /** identity-api base URL (IDENTITY_API_URL). Undefined/empty → fail-closed. */
  readonly baseUrl: string | undefined;
  /** Override the request timeout (tests). Default {@link RESOLVE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injectable fetch (tests). Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * resolveIdentityApiConfig — read the resolve config from env, no hardcoding.
 *   IDENTITY_API_URL — identity-api base URL (e.g. https://identity-api.…).
 */
export const resolveIdentityApiConfig = (
  env: Record<string, string | undefined> = process.env,
): IdentityResolveConfig => ({
  baseUrl: env.IDENTITY_API_URL,
});

/**
 * makeResolveDiscordIdentity — build the fail-closed resolve client. Returns a
 * function `(discordUserId) => Promise<user_id | null>`. The route injects the
 * returned function (so tests supply a deterministic fake / fetchImpl).
 */
export const makeResolveDiscordIdentity = (
  config: IdentityResolveConfig,
): ((discordUserId: string) => Promise<string | null>) => {
  const baseUrl = config.baseUrl;
  const timeoutMs = config.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;

  return async (discordUserId: string): Promise<string | null> => {
    // Fail-closed: no identity-api configured → no correlation possible.
    if (baseUrl === undefined || baseUrl.length === 0) return null;
    // Defense-in-depth: only the §1.11 digit shape reaches the URL path. The
    // grader's schema already enforces this, but the client must never
    // interpolate an unexpected shape (path-injection guard).
    if (!DISCORD_ID_RE.test(discordUserId)) return null;

    const url = `${baseUrl.replace(/\/+$/, "")}/v1/resolve/account/discord/${discordUserId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      // Any non-200 (404 = no link, 4xx, 5xx) → fail closed.
      if (res.status !== 200) return null;
      const body: unknown = await res.json().catch(() => null);
      if (typeof body !== "object" || body === null) return null;
      const userId = (body as { user_id?: unknown }).user_id;
      return typeof userId === "string" && userId.length > 0 ? userId : null;
    } catch {
      // Network error / DNS / timeout / abort / parse fault → fail closed.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
};
