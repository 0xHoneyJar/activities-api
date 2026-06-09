import { Schema } from "effect";

/**
 * IdentityId — opaque branded identifier for a substrate identity (FR-12).
 *
 * Pattern: `^id_[a-z0-9]{1,128}$` (per SDD §5.2 + §3.1)
 *
 * Identity is OPAQUE at the substrate boundary (architectural lock A5).
 * Chain-address resolution lives behind {@link IdentityResolverPort}.
 */
export const IdentityId = Schema.String.pipe(
  Schema.pattern(/^id_[a-z0-9]{1,128}$/),
  Schema.brand("IdentityId"),
);

export type IdentityId = Schema.Schema.Type<typeof IdentityId>;

/**
 * spineUserIdToIdentityId — map an identity-api spine `user_id` to this
 * substrate's opaque {@link IdentityId} at the integration boundary.
 *
 * The cluster identity SoR (identity-api) emits `user_id` as a bare UUID
 * (`ae0558c7-aeb2-48f0-906d-ad0a50108b19`); this substrate's IdentityId is
 * opaque and constrained to `^id_[a-z0-9]{1,128}$` (architectural lock A5).
 * The mapping is deterministic + collision-free: lowercase → strip dashes →
 * prefix `id_`. An already-conforming id passes through unchanged (forward-
 * compatible if the spine ever mints `id_`-native ids).
 *
 * THIS is the canonical convention. EVERY activities-api consumer — the read
 * path AND every grant path — MUST normalize spine ids through it, so the id a
 * badge is granted under equals the id the read path later queries. Non-TS
 * consumers replicate it verbatim (it is intentionally trivial + stable).
 *
 * The input domain is CONSTRAINED to make the mapping collision-free: either an
 * already-conforming `id_…` id (passed through) or a canonical spine UUID
 * (dash-stripped → `id_…`). These two ranges never collide — a UUID has dashes
 * / no `id_` prefix, so the stripped form can never equal a passthrough id.
 * Anything else THROWS rather than manufacturing a key from garbage (a bare
 * `player001` must NOT silently become `id_player001` and collide).
 */
const SPINE_USER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const spineUserIdToIdentityId = (spineUserId: string): IdentityId => {
  if (/^id_[a-z0-9]{1,128}$/.test(spineUserId)) {
    return Schema.decodeSync(IdentityId)(spineUserId);
  }
  if (!SPINE_USER_UUID_PATTERN.test(spineUserId)) {
    throw new Error(
      `spineUserIdToIdentityId: expected a spine UUID or an id_-conforming id; ` +
        `got "${spineUserId}". Refusing to manufacture an IdentityId from non-canonical input.`,
    );
  }
  return Schema.decodeSync(IdentityId)(
    `id_${spineUserId.replace(/-/g, "").toLowerCase()}`,
  );
};
