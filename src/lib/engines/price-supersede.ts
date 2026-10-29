/* ---------------------------------------------------------------------------
 * THE SMALL RULES ABOUT WHICH PRICE-LIST WRITES A LIST'S STATE ALLOWS.
 *
 * Pure, so each is pinned by a test without a database, and the action and
 * any screen that wants the sentence read one answer.
 * ------------------------------------------------------------------------- */

/**
 * What an old list is once a successor has dated it out to `effectiveTo`.
 * Still `published` while that day has not passed — it is what shops are
 * priced from until the new version starts — and `superseded` after.
 */
export function supersededStatusOn(effectiveTo: string, day: string): "published" | "superseded" {
  return effectiveTo < day ? "superseded" : "published";
}

/** A price on a list is set on a draft and nowhere else. Null means allowed. */
export function draftOnlyRefusal(status: string, what: string): string | null {
  if (status === "draft") return null;
  return `This list is ${status}. ${what} would change what a customer is charged without a record of it — open a new version in the editor instead.`;
}

/** Only a list in force can be withdrawn; a draft is deleted, a superseded list has already ended. */
export function withdrawRefusal(status: string): string | null {
  if (status === "published") return null;
  if (status === "draft") return "A draft prices nobody. Delete it instead of withdrawing it.";
  if (status === "superseded") return "That list has already been replaced by a newer version, so it prices nobody to withdraw.";
  if (status === "withdrawn") return "That list has already been withdrawn.";
  return `That list is ${status}, so there is nothing to withdraw.`;
}

/** A new version is made from a draft or a list in force — never from one that has ended. */
export function newVersionRefusal(status: string): string | null {
  if (status === "superseded") return "That list has already been replaced. Make the new version from the version in force.";
  if (status === "withdrawn") return "That list was withdrawn. Make a new list, or a new version of the one in force.";
  return null;
}

/** A scope's window cannot end before it starts. Both are ISO dates or null. */
export function scopeDatesProblem(validFrom: string | null | undefined, validTo: string | null | undefined): string | null {
  if (validFrom && validTo && validTo < validFrom) return "It cannot stop applying before it starts.";
  return null;
}
