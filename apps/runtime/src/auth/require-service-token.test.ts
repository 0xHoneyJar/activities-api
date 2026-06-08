/**
 * require-service-token tests (S1.5/S1.6 · §1.12 least-privilege gate).
 *
 * Mirrors the require-identity posture: exact-token passthrough (+ scope stash),
 * and fail-closed on every other path — wrong token, missing header, no secret
 * configured, and cross-scope (a write token never satisfies a read gate).
 *
 * S1.5 · 2026-06-08 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";

import {
  makeRequireServiceToken,
  resolveServiceTokenConfig,
  serviceScopeOf,
  type ServiceTokenConfig,
} from "./require-service-token";

const invoke = async (
  config: ServiceTokenConfig,
  headers: Record<string, string>,
): Promise<{ req: Request; status: number; passed: boolean }> => {
  const mw = makeRequireServiceToken(config);
  const req = new Request("http://x/v1/test", { headers });
  let passed = false;
  const ret = await mw({
    ctx: {} as never,
    input: undefined,
    req,
    path: "/v1/test",
    params: {},
    next: async () => {
      passed = true;
      return new Response("ok", { status: 200 });
    },
  });
  return { req, status: (ret as Response).status, passed };
};

describe("makeRequireServiceToken (§1.12)", () => {
  it("passes through on the exact configured token + stashes the scope", async () => {
    const { req, status, passed } = await invoke(
      { scope: "read", secret: "svc-read-secret" },
      { "x-service-token": "svc-read-secret" },
    );
    expect(status).toBe(200);
    expect(passed).toBe(true);
    expect(serviceScopeOf(req)).toBe("read");
  });

  it("401 + no passthrough on a wrong token", async () => {
    const { status, passed } = await invoke(
      { scope: "read", secret: "svc-read-secret" },
      { "x-service-token": "nope" },
    );
    expect(status).toBe(401);
    expect(passed).toBe(false);
  });

  it("401 when the header is missing", async () => {
    const { status, passed } = await invoke({ scope: "read", secret: "svc-read-secret" }, {});
    expect(status).toBe(401);
    expect(passed).toBe(false);
  });

  it("fails CLOSED when no secret is configured", async () => {
    const { status, passed } = await invoke(
      { scope: "verify-write", secret: undefined },
      { "x-service-token": "anything" },
    );
    expect(status).toBe(401);
    expect(passed).toBe(false);
  });

  it("scope isolation: the verify-write token never satisfies a read gate", async () => {
    const { status, passed } = await invoke(
      { scope: "read", secret: "the-read-secret" },
      { "x-service-token": "the-verify-write-secret" },
    );
    expect(status).toBe(401);
    expect(passed).toBe(false);
  });

  it("resolveServiceTokenConfig reads the scoped env var (read vs verify-write)", () => {
    const env = { ACTIVITIES_READ_TOKEN: "r", ACTIVITIES_VERIFY_WRITE_TOKEN: "w" };
    expect(resolveServiceTokenConfig("read", env).secret).toBe("r");
    expect(resolveServiceTokenConfig("verify-write", env).secret).toBe("w");
  });
});
