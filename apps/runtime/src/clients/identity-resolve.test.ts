/**
 * identity-resolve — fail-closed outbound client tests (S1.5 · §1.11.1).
 *
 * The load-bearing property is FAIL-CLOSED: the client returns `null` (→ grader
 * denies → NO grant) on EVERY error path, and NEVER throws into the route. These
 * tests exercise each path with an injected fetch.
 *
 * S1.5 · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";

import { makeResolveDiscordIdentity } from "./identity-resolve";

const DISCORD = "123456789012345678";

const jsonRes = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const spyFetch = (impl: (url: string) => Promise<Response>) => {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return impl(String(input));
  }) as unknown as typeof fetch;
  return { fn, calls };
};

describe("makeResolveDiscordIdentity — fail-closed", () => {
  it("no baseUrl → null, and NEVER hits the network", async () => {
    const { fn, calls } = spyFetch(async () => jsonRes(200, { user_id: "id_x" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: undefined, fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("empty baseUrl → null, no network", async () => {
    const { fn, calls } = spyFetch(async () => jsonRes(200, { user_id: "id_x" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("non-digit / over-long discord id → null, no network (path-injection guard)", async () => {
    const { fn, calls } = spyFetch(async () => jsonRes(200, { user_id: "id_x" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    for (const bad of ["abc", "12a", "", "1/2", "../etc", "1".repeat(33)]) {
      expect(await resolve(bad)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("200 { user_id } → the user_id", async () => {
    const { fn } = spyFetch(async () => jsonRes(200, { user_id: "id_alice" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBe("id_alice");
  });

  it("builds the exact resolve URL (trailing slash trimmed)", async () => {
    const { fn, calls } = spyFetch(async () => jsonRes(200, { user_id: "id_alice" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local/", fetchImpl: fn });
    await resolve(DISCORD);
    expect(calls[0]).toBe(`http://id.local/v1/resolve/account/discord/${DISCORD}`);
  });

  it("200 with no user_id → null", async () => {
    const { fn } = spyFetch(async () => jsonRes(200, { not_user_id: "x" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
  });

  it("200 with empty / non-string user_id → null", async () => {
    const resolveEmpty = makeResolveDiscordIdentity({
      baseUrl: "http://id.local",
      fetchImpl: spyFetch(async () => jsonRes(200, { user_id: "" })).fn,
    });
    expect(await resolveEmpty(DISCORD)).toBeNull();
    const resolveNum = makeResolveDiscordIdentity({
      baseUrl: "http://id.local",
      fetchImpl: spyFetch(async () => jsonRes(200, { user_id: 42 })).fn,
    });
    expect(await resolveNum(DISCORD)).toBeNull();
  });

  it("200 non-object body → null", async () => {
    const { fn } = spyFetch(async () => jsonRes(200, 42));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
  });

  it("200 unparseable body → null (json() throws, caught)", async () => {
    const { fn } = spyFetch(
      async () => new Response("not json", { status: 200 }),
    );
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
  });

  it("404 (no link) → null", async () => {
    const { fn } = spyFetch(async () => jsonRes(404, { code: "not_found" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
  });

  it("500 → null", async () => {
    const { fn } = spyFetch(async () => jsonRes(500, { error: "boom" }));
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    expect(await resolve(DISCORD)).toBeNull();
  });

  it("network error / timeout (fetch throws) → null, never propagates", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    await expect(resolve(DISCORD)).resolves.toBeNull();
  });

  it("abort (DOMException) → null", async () => {
    const fn = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const resolve = makeResolveDiscordIdentity({ baseUrl: "http://id.local", fetchImpl: fn });
    await expect(resolve(DISCORD)).resolves.toBeNull();
  });
});
