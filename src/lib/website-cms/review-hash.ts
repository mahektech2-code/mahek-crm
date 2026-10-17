import { createHash } from "node:crypto";
import { stableStringify } from "./bundle";

/* ---------------------------------------------------------------------------
 * THE FINGERPRINT OF WHAT A REVIEWER SAW — the server half of the review logic.
 *
 * Approval covers exactly the content that was reviewed, so publishing compares
 * the CURRENT working copy to what was frozen at submission. A version number
 * alone is not enough (two saves can leave the same number behind an import or a
 * discard), and content alone is not enough to say WHY it moved, so both are
 * checked.
 *
 * `stableStringify` is the helper behind `revisionOf` in `bundle.ts` — object
 * keys sorted, so the same content hashes the same whatever order Postgres hands
 * the keys back in. Both sides of the comparison are read from the database, so
 * jsonb's own normalisation (number formatting, key order) applies to both.
 *
 * The full 64 characters, not `revisionOf`'s 16: that one answers "did the
 * bundle change", this one is a gate on putting something on the public site.
 * ------------------------------------------------------------------------- */

export function proposedHash(data: unknown): string {
  return createHash("sha256").update(stableStringify(data)).digest("hex");
}

export type FrozenItem = { submittedVersion: number; proposedHash: string };
export type CurrentRow = { version: number; data: unknown };

/**
 * Whether a row still holds exactly what was frozen.
 *
 *   `fresh`            same version and same content — publishable;
 *   `version_moved`    somebody saved it since (a different editor, or the same
 *                      one by another route) — the approval no longer applies;
 *   `content_changed`  the version matches but the content does not, which a
 *                      normal save cannot produce and which therefore is never
 *                      treated as fresh.
 */
export function freshness(frozen: FrozenItem, current: CurrentRow): "fresh" | "version_moved" | "content_changed" {
  if (current.version !== frozen.submittedVersion) return "version_moved";
  if (proposedHash(current.data) !== frozen.proposedHash) return "content_changed";
  return "fresh";
}
