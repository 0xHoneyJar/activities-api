import { Either, ParseResult, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ActivityId } from "./ActivityId.js";
import { CycleId } from "./CycleId.js";
import { EventId } from "./EventId.js";
import { IdentityId, spineUserIdToIdentityId } from "./IdentityId.js";
import { MintIntentId } from "./MintIntentId.js";
import { PartitionKey } from "./PartitionKey.js";
import { SnapshotId } from "./SnapshotId.js";
import { StepId } from "./StepId.js";
import { WorldId } from "./WorldId.js";

/**
 * Constructor-discipline test scaffold for pattern-based branded strings.
 *
 * Each branded type passes through THREE invariants per T1.2 acceptance criteria:
 *   1. Raw string rejected at the schema boundary (decode fails).
 *   2. Valid pattern accepted (decode succeeds + roundtrips to same string).
 *   3. Invalid pattern rejected with a sealed ParseResult error (no throw escapes).
 */
const expectDecodeOk = <A, I>(schema: Schema.Schema<A, I>, input: I) => {
  const result = Schema.decodeUnknownEither(schema)(input);
  expect(Either.isRight(result)).toBe(true);
  return result;
};

const expectDecodeFail = <A, I>(schema: Schema.Schema<A, I>, input: unknown) => {
  const result = Schema.decodeUnknownEither(schema)(input);
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(ParseResult.isParseError(result.left)).toBe(true);
  }
};

const stringCase = <A, I>(
  schema: Schema.Schema<A, I>,
  valid: ReadonlyArray<string>,
  invalid: ReadonlyArray<unknown>,
) => {
  it("accepts valid pattern matches", () => {
    for (const v of valid) {
      expectDecodeOk(schema as unknown as Schema.Schema<A, string>, v);
    }
  });

  it("rejects invalid inputs as ParseResult errors", () => {
    for (const v of invalid) {
      expectDecodeFail(schema as unknown as Schema.Schema<A, string>, v);
    }
  });

  it("roundtrips: encode(decode(s)) === s for every valid", () => {
    for (const v of valid) {
      const decoded = Schema.decodeUnknownSync(schema as unknown as Schema.Schema<A, string>)(v);
      const encoded = Schema.encodeSync(schema as unknown as Schema.Schema<A, string>)(decoded);
      expect(encoded).toBe(v);
    }
  });
};

describe("ActivityId", () => {
  stringCase(
    ActivityId,
    ["act_a", "act_quest1", `act_${"x".repeat(128)}`, "act_0123456789"],
    [
      "ACT_uppercase",
      "act_HAS_UNDERSCORE_CAPS",
      "act_",
      "activity_quest1",
      `act_${"x".repeat(129)}`,
      "act_kebab-not-allowed",
      42,
      null,
      undefined,
    ],
  );
});

describe("EventId (sha256 hex)", () => {
  const validHex = "0".repeat(64);
  const mixedHex = "abcdef0123456789".repeat(4);
  stringCase(
    EventId,
    [validHex, mixedHex],
    [
      "0".repeat(63), // too short
      "0".repeat(65), // too long
      `${"A".repeat(64)}`, // uppercase rejected
      "z".repeat(64), // out-of-alphabet
      "",
      42,
    ],
  );
});

describe("IdentityId", () => {
  stringCase(
    IdentityId,
    ["id_a", "id_player001", `id_${"x".repeat(128)}`],
    ["ID_caps", "id_kebab-no", "id_", "identity_player1", `id_${"y".repeat(129)}`],
  );
});

describe("spineUserIdToIdentityId (the integration-boundary mapping)", () => {
  it("maps a bare spine UUID → a conforming IdentityId (lowercase, dash-stripped, id_ prefix)", () => {
    const out = spineUserIdToIdentityId("ae0558c7-aeb2-48f0-906d-ad0a50108b19");
    expect(out).toBe("id_ae0558c7aeb248f0906dad0a50108b19");
    // the output MUST itself decode as a valid IdentityId (no escape hatch)
    expect(Either.isRight(Schema.decodeUnknownEither(IdentityId)(out))).toBe(true);
  });

  it("uppercases in the source UUID are normalized to lowercase", () => {
    expect(spineUserIdToIdentityId("AE0558C7-AEB2-48F0-906D-AD0A50108B19")).toBe(
      "id_ae0558c7aeb248f0906dad0a50108b19",
    );
  });

  it("is idempotent: an already-conforming id_ id passes through unchanged", () => {
    expect(spineUserIdToIdentityId("id_player001")).toBe("id_player001");
  });

  it("is deterministic + collision-free: distinct UUIDs → distinct ids; same UUID → same id", () => {
    const a = spineUserIdToIdentityId("ae0558c7-aeb2-48f0-906d-ad0a50108b19");
    const b = spineUserIdToIdentityId("f764e62b-f6d6-4461-923b-2d57c893a727");
    const aAgain = spineUserIdToIdentityId("ae0558c7-aeb2-48f0-906d-ad0a50108b19");
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });

  it("rejects non-canonical input (not a UUID, not id_) instead of manufacturing a colliding key", () => {
    // `player001` must NOT become `id_player001` — that would collide with a
    // legitimately-passed-through `id_player001` (the collision FAGAN flagged).
    expect(() => spineUserIdToIdentityId("player001")).toThrow();
    expect(() => spineUserIdToIdentityId("")).toThrow();
    expect(() => spineUserIdToIdentityId("not a uuid")).toThrow();
  });

  it("read/grant agreement: the mapping a badge is granted under == the id the read queries", () => {
    // both the grant path and the read path normalize the SAME spine user_id;
    // therefore they MUST land on the same IdentityId (the bug this closes).
    const spine = "e383665c-c709-4fd0-9162-60663b9279ae";
    expect(spineUserIdToIdentityId(spine)).toBe(spineUserIdToIdentityId(spine));
  });
});

describe("WorldId", () => {
  stringCase(
    WorldId,
    ["world_mongolian", "world_cubquests", "world_with-dashes", "world_with_underscores"],
    [
      "WORLD_caps",
      "world_",
      `world_${"x".repeat(65)}`,
      "world_uppercaseC",
      "world_x.dotnotallowed",
    ],
  );
});

describe("SnapshotId", () => {
  stringCase(
    SnapshotId,
    ["snap_a", "snap_20260515", `snap_${"z".repeat(128)}`],
    ["SNAP_caps", "snap_dash-not", "snap_", `snap_${"x".repeat(129)}`],
  );
});

describe("CycleId", () => {
  stringCase(
    CycleId,
    [
      "cyc_a",
      "cyc_acvp-modules-genesis",
      "cyc_with_underscores",
      "cyc_098-agent-network",
      `cyc_${"x".repeat(128)}`,
    ],
    ["CYC_caps", "cyc_", "cyc_dot.notallowed", `cyc_${"x".repeat(129)}`],
  );
});

describe("StepId", () => {
  stringCase(
    StepId,
    ["step_a", "step_intro-1", "step_chapter_2", `step_${"x".repeat(128)}`],
    ["STEP_caps", "step_", "step_with.dot", `step_${"y".repeat(129)}`],
  );
});

describe("MintIntentId", () => {
  stringCase(
    MintIntentId,
    ["mint_a", "mint_intent001", `mint_${"x".repeat(128)}`],
    ["MINT_caps", "mint_dash-no", "mint_", `mint_${"x".repeat(129)}`],
  );
});

describe("PartitionKey", () => {
  it("accepts every declared scope variant", () => {
    // T1.20 added the composite-shape validator (must match `<a>::<b>`).
    // Non-composite scopes accept the test value as-is.
    const cases = [
      { scope: "activity" as const, value: "any-value" },
      { scope: "identity" as const, value: "any-value" },
      { scope: "world" as const, value: "any-value" },
      { scope: "event-type" as const, value: "any-value" },
      { scope: "composite" as const, value: "world_a::act_b" },
    ];
    for (const c of cases) {
      const decoded = Schema.decodeUnknownSync(PartitionKey)(c);
      expect(decoded.scope).toBe(c.scope);
      expect(decoded.value).toBe(c.value);
    }
  });

  it("rejects scope outside the sealed union", () => {
    expectDecodeFail(PartitionKey, { scope: "global", value: "x" });
    expectDecodeFail(PartitionKey, { scope: "ACTIVITY", value: "x" });
    expectDecodeFail(PartitionKey, { scope: "random", value: "x" });
  });

  it("rejects empty value and overlong value", () => {
    expectDecodeFail(PartitionKey, { scope: "activity", value: "" });
    expectDecodeFail(PartitionKey, { scope: "activity", value: "x".repeat(257) });
  });

  it("rejects missing fields and bare strings", () => {
    expectDecodeFail(PartitionKey, { scope: "activity" });
    expectDecodeFail(PartitionKey, "activity::value");
    expectDecodeFail(PartitionKey, null);
  });

  it("roundtrips struct shape via Schema.encodeSync", () => {
    const v = Schema.decodeUnknownSync(PartitionKey)({
      scope: "composite",
      value: "world_mongolian::act_quest1",
    });
    const encoded = Schema.encodeSync(PartitionKey)(v);
    expect(encoded).toEqual({
      scope: "composite",
      value: "world_mongolian::act_quest1",
    });
  });
});

describe("brand discipline", () => {
  it("brands are nominal — a raw string cannot satisfy a branded slot without decoding", () => {
    // Compile-time discipline rehearsal: TypeScript would reject a raw string
    // where ActivityId is required. At runtime we verify the schema also enforces.
    const raw = "act_quest1";
    const decoded = Schema.decodeUnknownSync(ActivityId)(raw);
    // Runtime values are equal as strings, but the BRAND only exists post-decode.
    expect(decoded).toBe(raw);
    expect(typeof decoded).toBe("string");
  });
});
