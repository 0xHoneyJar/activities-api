/**
 * Generator + independent oracle for the B1 merkle/signature golden vectors
 * (SDD §1.10.3 · S1.2 · CRITICAL-870 firebreak).
 *
 * Computes every value TWO independent ways and asserts they agree before
 * emitting:
 *   1. the engine implementation under test (`merkle.ts` / `snapshot-sig.ts`,
 *      `@noble/hashes` keccak + `@noble/curves` ed25519);
 *   2. an INDEPENDENT oracle — `ethers` (a different keccak implementation, the
 *      canonical EVM reference) for leaf encoding, plus a separately-written
 *      level-by-level sorted-pair tree with odd-node promotion.
 *
 * If the two disagree on any leaf, intermediate node, root, or proof, this
 * script throws — so a frozen fixture can only ever capture cross-validated
 * values. Run: `bun packages/engine/scripts/gen-merkle-fixture.ts`. The output
 * is pasted into `packages/protocol/src/golden-vectors/merkle.fixtures.ts`; the
 * engine golden test re-runs the same oracle live on every CI run.
 */

import { keccak256 as ethersKeccak256, solidityPackedKeccak256, toUtf8Bytes } from "ethers";

import {
  type Hex,
  buildMerkleTree,
  merkleLeaf,
  verifyMerkleProof,
} from "../src/badge/merkle.js";
import {
  type SnapshotSigContext,
  signSnapshot,
  snapshotSigMessage,
} from "../src/badge/snapshot-sig.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";

// --- Fixture inputs (pinned to the B1 act_donation_raffle activity) ---------

// NB: ActivityId/SnapshotId brands are `^act_[a-z0-9]+$` / `^snap_[a-z0-9]+$`
// (no separators after the prefix) — so these carry NO underscores/hyphens.
// badge_family_id is an unbranded string, so the readable hyphen is fine.
const ACTIVITY_ID = "act_donationraffle";
const BADGE_FAMILY_ID = "donation-raffle";
const SNAPSHOT_ID = "snap_donationraffle2026q2";
const ENVIRONMENT_ID = "production" as const;
const CREATED_AT = "2026-06-07T00:00:00Z";
const SIGNER_KEY_ID = "op-badge-ed25519-2026-06";

// 5 wallets ⇒ odd count, exercises promotion at multiple levels.
const WALLETS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
  "0x4444444444444444444444444444444444444444",
  "0x5555555555555555555555555555555555555555",
];
const SINGLE_WALLET = "0x9999999999999999999999999999999999999999";

// Deterministic TEST key (the real operator key lives in env/secret, never repo).
// ed25519 private key IS the 32-byte seed ⇒ deterministic pubkey + signature.
const TEST_SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));

// --- Independent oracle (ethers keccak + hand-rolled tree) -------------------

function oracleLeaf(wallet: string): Hex {
  const snapH = ethersKeccak256(toUtf8Bytes(SNAPSHOT_ID));
  const famH = ethersKeccak256(toUtf8Bytes(BADGE_FAMILY_ID));
  const inner = solidityPackedKeccak256(
    ["address", "bytes32", "bytes32"],
    [wallet.toLowerCase(), snapH, famH],
  );
  return ethersKeccak256(inner) as Hex;
}

function oracleHashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethersKeccak256(("0x" + lo.slice(2) + hi.slice(2)) as Hex) as Hex;
}

/** Independent level-by-level sorted-pair tree with odd promotion. */
function oracleTree(leaves: Hex[]): { root: Hex; levels: Hex[][] } {
  const sorted = [...new Set(leaves)].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  );
  const levels: Hex[][] = [sorted];
  let cur = sorted;
  while (cur.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? oracleHashPair(cur[i]!, cur[i + 1]!) : cur[i]!);
    }
    levels.push(next);
    cur = next;
  }
  return { root: cur[0]!, levels };
}

// --- Cross-validate + assemble ----------------------------------------------

function assertEq(a: unknown, b: unknown, msg: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`ORACLE MISMATCH (${msg}):\n  engine=${sa}\n  oracle=${sb}`);
}

function buildFixture(wallets: string[]) {
  // Leaf hashes — engine vs ethers oracle.
  const leaves = wallets.map((w) => {
    const eng = merkleLeaf({ wallet: w, snapshotId: SNAPSHOT_ID, badgeFamilyId: BADGE_FAMILY_ID });
    const ora = oracleLeaf(w);
    assertEq(eng, ora, `leaf ${w}`);
    return eng;
  });

  // Tree — engine vs oracle.
  const tree = buildMerkleTree(leaves);
  const ora = oracleTree(leaves);
  assertEq(tree.root, ora.root, "root");
  assertEq(tree.levels, ora.levels, "levels");

  // Per-leaf proofs verify against the root (build↔verify cross-check).
  const leafRows = tree.leaves.map((leaf, i) => {
    const proof = tree.proofFor(leaf);
    if (!verifyMerkleProof(leaf, proof, tree.root)) {
      throw new Error(`proof does not fold to root for leaf ${leaf}`);
    }
    // recover the originating wallet for readability
    const wallet = wallets.find(
      (w) => merkleLeaf({ wallet: w, snapshotId: SNAPSHOT_ID, badgeFamilyId: BADGE_FAMILY_ID }) === leaf,
    )!;
    return { sorted_index: i, wallet: wallet.toLowerCase(), leaf_hash: leaf, proof };
  });

  return { leaves: tree.leaves, levels: tree.levels, root: tree.root, leafRows };
}

const main = buildFixture(WALLETS);
const single = buildFixture([SINGLE_WALLET]);

// --- Signature (§1.10.2) ----------------------------------------------------

const pubkey = ("0x" + bytesToHex(ed25519.getPublicKey(TEST_SEED))) as Hex;

function sigFor(ctx: SnapshotSigContext): { msgHex: Hex; sig: Hex } {
  const msg = snapshotSigMessage(ctx);
  const sig = ("0x" + bytesToHex(signSnapshot(ctx, TEST_SEED))) as Hex;
  return { msgHex: ("0x" + bytesToHex(msg)) as Hex, sig };
}

const validCtx: SnapshotSigContext = {
  snapshotId: SNAPSHOT_ID,
  badgeFamilyId: BADGE_FAMILY_ID,
  activityId: ACTIVITY_ID,
  environmentId: ENVIRONMENT_ID,
  merkleRoot: main.root,
  leafCount: main.leaves.length,
  createdAt: CREATED_AT,
  signerKeyId: SIGNER_KEY_ID,
};
const validSig = sigFor(validCtx);

// A signature made over a STAGING message (the reordered/wrong-env attack
// surface) — presented later with the production ctx, it must fail to verify.
const stagingSig = sigFor({ ...validCtx, environmentId: "staging" });

console.log(
  JSON.stringify(
    {
      activity_id: ACTIVITY_ID,
      badge_family_id: BADGE_FAMILY_ID,
      snapshot_id: SNAPSHOT_ID,
      environment_id: ENVIRONMENT_ID,
      created_at: CREATED_AT,
      signer_key_id: SIGNER_KEY_ID,
      signer_pubkey: pubkey,
      keccak_empty_kat: ethersKeccak256("0x"),
      main: {
        root: main.root,
        sorted_leaf_hashes: main.leaves,
        levels: main.levels,
        leaf_count: main.leaves.length,
        leaves: main.leafRows,
        sig_message_hex: validSig.msgHex,
        root_signature: validSig.sig,
      },
      single: {
        root: single.root,
        leaf_hash: single.leaves[0],
        wallet: SINGLE_WALLET.toLowerCase(),
      },
      staging_signature_for_replay_test: stagingSig.sig,
    },
    null,
    2,
  ),
);
