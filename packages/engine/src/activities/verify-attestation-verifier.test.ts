/**
 * verify-attestation-verifier tests (S1.5 · GATE-SEC-1 · §1.11).
 *
 * Happy path + every §1.11 failure class (each MUST deny — NO APPROVED is ever
 * invented): wrong step · no correlation · correlation mismatch · world not
 * allowlisted · malformed idempotency key · malformed/future/stale issued_at.
 *
 * S1.5 · 2026-06-08 · mibera-badge-surface.
 */

import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

import { B1_DONATION_RAFFLE_ACTIVITY, VERIFY_ACTIVITY } from "@0xhoneyjar/quests-protocol";

import {
  VERIFY_ATTESTATION_GRADER_SLUG,
  type VerifyAttestation,
  verifyAttestationVerifier,
} from "./verify-attestation-verifier.js";

const verifyStep = VERIFY_ACTIVITY.steps[0]!; // ManualCurator { curator_id: "verify" }
const merkleStep = B1_DONATION_RAFFLE_ACTIVITY.steps[0]!; // an unowned (MerkleProof) step

const ISSUED = "2026-06-08T00:00:00Z";
const NOW_MS = Date.parse("2026-06-08T00:01:00Z"); // 1 minute later

const att: VerifyAttestation = {
  identity_id: "id_abc123",
  discord_user_id: "1234567890",
  world: "mibera",
  verify_event_id: "ve_xyz789",
  issued_at: ISSUED,
  idempotency_key: "b2:id_abc123:ve_xyz789",
};

const run = (overrides: Partial<Parameters<typeof verifyAttestationVerifier>[0]>) =>
  Effect.runSync(
    Effect.either(
      verifyAttestationVerifier({
        attestation: att,
        resolvedIdentityId: att.identity_id,
        step: verifyStep,
        worldAllowlist: ["mibera"],
        nowMsProvider: () => NOW_MS,
        submissionId: "sub_1",
        traceId: "trace_1",
        gradedAtProvider: () => ISSUED,
        ...overrides,
      }),
    ),
  );

describe("verifyAttestationVerifier — happy path", () => {
  it("APPROVES a correlated, fresh, allowlisted verify attestation", () => {
    const result = run({});
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.status).toBe("APPROVED");
      expect(result.right.graderConstructSlug).toBe(VERIFY_ATTESTATION_GRADER_SLUG);
    }
  });
});

describe("verifyAttestationVerifier — failure classes (MUST deny)", () => {
  const denies = (
    label: string,
    overrides: Partial<Parameters<typeof verifyAttestationVerifier>[0]>,
  ) =>
    it(label, () => {
      expect(Either.isLeft(run(overrides))).toBe(true);
    });

  denies("wrong step (a non-verify MerkleProof step)", { step: merkleStep });
  denies("no correlation (identity-api 404 → null)", { resolvedIdentityId: null });
  denies("correlation mismatch (resolves to a different identity)", {
    resolvedIdentityId: "id_someoneelse",
  });
  denies("world not in the allowlist", { worldAllowlist: ["someotherworld"] });
  denies("malformed idempotency_key (does not match b2:<id>:<event>)", {
    attestation: { ...att, idempotency_key: "b2:wrong:key" },
  });
  denies("malformed issued_at", {
    attestation: { ...att, issued_at: "not-a-date" },
  });
  denies("issued_at in the future (beyond skew tolerance)", {
    attestation: { ...att, issued_at: "2026-06-09T00:00:00Z" },
  });
  denies("issued_at stale (beyond the freshness window)", {
    attestation: { ...att, issued_at: "2026-06-01T00:00:00Z" },
    freshnessSeconds: 3600,
  });

  // Anti-replay fail-open guard (FAGAN S1.5): a non-finite window/clock must
  // deny, not let the NaN comparison silently approve a stale attestation.
  denies("non-finite freshness window (NaN) does not fail open", {
    freshnessSeconds: Number.NaN,
  });
  denies("non-positive freshness window does not fail open", {
    freshnessSeconds: 0,
  });
  denies("non-finite clock does not fail open", {
    nowMsProvider: () => Number.NaN,
  });
});
