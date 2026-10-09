/* ---------------------------------------------------------------------------
 * Input checks for the Website app's mock forms.
 *
 * PURE, like `seat-labels` and `role-levels`: no React, no database, so the
 * rules can be tested without either and the screens that draw their errors
 * (all client components) share one spelling of each message.
 *
 * Every check returns the message to show, or `undefined` when the value is
 * fine. The optional ones (`emailError`, `phoneError`, `urlError`,
 * `gaIdError`) accept a blank value — a field nobody has filled in is not a
 * wrong one; pair them with `required()` where it must be filled.
 *
 * The rules are deliberately the loosest that still catch a typo: they are
 * checked against the values the app already carries (`mock-data.ts`) so a
 * form never rejects its own seed data.
 * ------------------------------------------------------------------------- */

export type Errors<K extends string = string> = Partial<Record<K, string>>;

/** True when any field carries a message. */
export function hasErrors(errors: Errors): boolean {
  return Object.values(errors).some((m) => !!m);
}

/** A blank or whitespace-only value is not an answer. */
export function required(value: string, label: string): string | undefined {
  return value.trim() === "" ? `${label} is required.` : undefined;
}

/** Lower-case words joined by single hyphens — the shape a URL segment takes. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A slug must be present, URL-shaped, and not already used by another record
 * of the same kind. `taken` is the OTHER records' slugs — pass the list
 * without the record being edited, or it would collide with itself.
 */
export function slugError(slug: string, taken: readonly string[], noun = "record"): string | undefined {
  const value = slug.trim();
  if (value === "") return "Slug is required.";
  if (!SLUG.test(value)) {
    return "Use lower-case letters, numbers and single hyphens only, e.g. universal-thinner.";
  }
  if (taken.some((t) => t.trim().toLowerCase() === value)) {
    return `Another ${noun} already uses this slug.`;
  }
  return undefined;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailError(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  return EMAIL.test(v) ? undefined : "Enter an email address like name@example.com.";
}

/**
 * A phone number as people write one: an optional leading +, then 7–15 digits
 * with spaces, hyphens, dots or brackets between them. "+91 98765 43210" and
 * "022-1234 5678" pass; "call us" does not.
 */
export function phoneError(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  if (!/^\+?[\d\s\-().]+$/.test(v)) return "Enter a phone number using digits, spaces and an optional leading +.";
  const digits = v.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? undefined : "A phone number has between 7 and 15 digits.";
}

/** An absolute web address, http or https. */
export function urlError(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  try {
    const u = new URL(v);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) return undefined;
  } catch {
    /* fall through to the message */
  }
  return "Enter a full web address starting with https://, e.g. https://example.com.";
}

/** A GA4 measurement ID: G- and then letters or digits, e.g. G-ABCDE12345. */
export function gaIdError(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  return /^G-[A-Z0-9]{6,14}$/.test(v) ? undefined : "A Google Analytics ID looks like G-ABCDE12345.";
}

/**
 * A menu link: a path on the public site (/products), a full web address, or
 * a mailto:/tel: link. Never anything with a space in it.
 */
export function linkError(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return "Link is required.";
  if (/\s/.test(v)) return "A link cannot contain spaces.";
  if (v.startsWith("/")) return undefined;
  if (/^(mailto|tel):\S+$/i.test(v)) return undefined;
  return urlError(v) === undefined ? undefined : "Use a path like /products, or a full address starting with https://.";
}
