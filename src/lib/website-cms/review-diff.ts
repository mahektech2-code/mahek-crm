import { mediaIdsIn } from "./media-types";

/* ---------------------------------------------------------------------------
 * WHAT CHANGED BETWEEN TWO COPIES OF A PIECE OF CONTENT — pure, and client-safe
 * so the review screen draws exactly what the server froze.
 *
 * Deliberately no hashing here: hashing needs `node:crypto`, and this file is
 * imported by a client component. `review-hash.ts` is the server half.
 *
 * What a reviewer must be able to see, and this file guarantees:
 *   - a field that was CLEARED is a change. "Fast drying" becoming "" is an
 *     edit, and a key that vanished from the data is a removal — neither is
 *     skipped as "empty";
 *   - an image that was REPLACED is a change at its field, and `mediaDelta`
 *     names the files that came and went so the screen can show both;
 *   - an item that was not live has everything in it reported as ADDED.
 *
 * Arrays are compared by position, one entry per path (`benefits[2]`). That is
 * what a form shows (the third benefit changed), and it never claims a reorder
 * is "nothing happened".
 * ------------------------------------------------------------------------- */

export type FieldChange = {
  /** Dotted path, with `[n]` for a position in a list: `specs.Appearance`, `benefits[1]`. */
  path: string;
  /** `added` — absent before; `removed` — gone from the data; `edited` — present both times and different, including cleared to empty. */
  change: "added" | "removed" | "edited";
  before: unknown;
  after: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === "object" && v !== null;

/** Structural equality: object key ORDER does not matter, array order does. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function walk(path: string, before: unknown, after: unknown, out: FieldChange[]): void {
  if (deepEqual(before, after)) return;

  const emptyContainer = (v: unknown) => isContainer(v) && Object.keys(v).length === 0;
  // A whole container appearing or disappearing is reported field by field —
  // unless it is empty, which has no fields to report and is one change.
  const appearing = before === undefined && isContainer(after) && !emptyContainer(after);
  const vanishing = after === undefined && isContainer(before) && !emptyContainer(before);

  if (isObject(before) && isObject(after)) {
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      walk(path ? `${path}.${k}` : k, before[k], after[k], out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) walk(`${path}[${i}]`, before[i], after[i], out);
    return;
  }
  if (appearing || vanishing) {
    const shape = (appearing ? after : before) as Record<string, unknown> | unknown[];
    const keys = Array.isArray(shape) ? shape.map((_, i) => i) : Object.keys(shape).sort();
    for (const k of keys) {
      const child = (shape as Record<string | number, unknown>)[k];
      const at = Array.isArray(shape) ? `${path}[${k}]` : path ? `${path}.${k}` : String(k);
      if (appearing) walk(at, undefined, child, out);
      else walk(at, child, undefined, out);
    }
    return;
  }

  out.push({
    path,
    change: before === undefined ? "added" : after === undefined ? "removed" : "edited",
    before,
    after,
  });
}

/**
 * Every field that differs, in path order. `before` may be null or undefined —
 * an item that was never live — in which case everything in `after` is added.
 */
export function diffData(before: unknown, after: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  walk("", before ?? undefined, after ?? undefined, out);
  return out;
}

/**
 * Whether a submission carries a REAL change. An item that was not live is
 * always one (publishing it is the change); a live item is one only if its
 * working copy now differs from what is live. Saving twice with the same text
 * is a new version and still not a change.
 */
export function hasRealChange(base: unknown | null, proposed: unknown): boolean {
  if (base === null || base === undefined) return true;
  return !deepEqual(base, proposed);
}

/** `add` for something that was not live, `edit` for something that was. v1 has no `remove`. */
export function actionFor(base: unknown | null): "add" | "edit" {
  return base === null || base === undefined ? "add" : "edit";
}

/* ------------------------------------------------------------------ images */

export type MediaDelta = {
  /** Uploaded files this content points at now and did not before. */
  added: string[];
  /** Files it pointed at before and no longer does — the "old image" the reviewer should see. */
  removed: string[];
  kept: string[];
};

/** Uploaded-file ids a piece of content points at (the CMS's own `/cms-media/<id>/` paths). */
export function mediaIdsOf(data: unknown): string[] {
  return data === null || data === undefined ? [] : mediaIdsIn(data).sort();
}

export function mediaDelta(beforeIds: readonly string[], afterIds: readonly string[]): MediaDelta {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  return {
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort(),
    kept: [...after].filter((id) => before.has(id)).sort(),
  };
}

/** Whether a changed value looks like an image path, so the screen draws it as a picture rather than as text. */
export function isImageValue(v: unknown): v is string {
  return typeof v === "string" && (/\/cms-media\/[A-Za-z0-9_-]{8,64}\//.test(v) || /\.(webp|png|jpe?g|gif|avif)$/i.test(v));
}
