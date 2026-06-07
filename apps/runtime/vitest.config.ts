import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * apps/runtime vitest config. The root config only globs packages/*; the
 * runtime app needs the `@hyper/*` alias (the vendored hyper core lives under
 * src/hyper/) and the workspace package aliases resolved to SOURCE so route
 * tests (e.g. the defect #21.8 HTTP-status mapping, the GATE-SEC-1 write route)
 * run without a build step.
 */
export default defineConfig({
  resolve: {
    // Order matters: longer (more specific) aliases first so `/postgres`
    // resolves before the bare adapters package.
    alias: [
      { find: "@hyper/core", replacement: resolve(__dirname, "src/hyper/core/index.ts") },
      {
        find: "@0xhoneyjar/quests-protocol",
        replacement: resolve(__dirname, "../../packages/protocol/src/index.ts"),
      },
      {
        find: "@0xhoneyjar/quests-engine",
        replacement: resolve(__dirname, "../../packages/engine/src/index.ts"),
      },
      {
        find: "@0xhoneyjar/freeside-activities-adapters/postgres",
        replacement: resolve(__dirname, "../../packages/adapters/src/postgres/index.ts"),
      },
      {
        find: "@0xhoneyjar/freeside-activities-adapters",
        replacement: resolve(__dirname, "../../packages/adapters/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    // The auth middleware (apps/runtime/src/app.ts) is built EAGERLY at module
    // load from resolveAuthConfig() → process.env. The GATE-SEC-1 write-route
    // tests mint HS256 JWTs against this secret; it must be present BEFORE the
    // module graph evaluates, so it lives here rather than in a beforeEach.
    env: {
      IDENTITY_API_JWT_SECRET: "test-secret-do-not-use-in-prod",
      IDENTITY_API_ISSUER: "identity-api",
    },
  },
});
