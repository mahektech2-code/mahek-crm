/* ---------------------------------------------------------------------------
 * §6.1 One success and error shape for every operation, including field-level
 * validation errors so a form can mark the offending input rather than showing
 * a banner and leaving the user hunting.
 * ------------------------------------------------------------------------- */

export type FieldError = { field: string; message: string };

export type Ok<T> = {
  ok: true;
  data: T;
  message?: string;
  /** Non-blocking notes, e.g. a configuration inconsistency after a write. */
  warnings?: string[];
};

export type Err = {
  ok: false;
  error: string;
  code?: ErrorCode;
  fieldErrors?: FieldError[];
  /** What a screen needs to answer the refusal itself — a duplicate order's comparison, for one. */
  detail?: unknown;
};

export type Result<T = undefined> = Ok<T> | Err;

export type ErrorCode =
  | "validation"
  | "not_permitted"
  | "not_found"
  | "conflict"
  | "rule_violation"
  | "duplicate";

export function ok<T>(data: T, message?: string, warnings?: string[]): Ok<T> {
  return { ok: true, data, message, warnings };
}

export function okVoid(message?: string): Ok<undefined> {
  return { ok: true, data: undefined, message };
}

export function err(
  error: string,
  code: ErrorCode = "validation",
  fieldErrors?: FieldError[],
): Err {
  return { ok: false, error, code, fieldErrors };
}

export function fieldErr(field: string, message: string): Err {
  return { ok: false, error: message, code: "validation", fieldErrors: [{ field, message }] };
}

/** Turns a thrown NotPermittedError into the shared error shape. */
export function fromThrown(e: unknown): Err {
  if (e && typeof e === "object" && "name" in e && e.name === "NotPermittedError") {
    return { ok: false, error: (e as Error).message, code: "not_permitted" };
  }
  const dead = deadLeadRefusalFrom(e);
  if (dead) return { ok: false, error: dead, code: "rule_violation" };
  const message = e instanceof Error ? e.message : "Something went wrong.";
  return { ok: false, error: message, code: "validation" };
}

/*
 * A DEAD LEAD'S TRIGGERS ANSWER IN WORDS, EVERYWHERE AT ONCE.
 *
 * The database (migration 0189) refuses every write to a permanently Dead lead
 * with a custom SQLSTATE, and Drizzle wraps that in a "Failed query: …" error
 * whose own message is the SQL and its parameters. Mapping the code here means
 * the ~hundred server actions that already catch with `fromThrown` give the
 * person the sentence instead — without a guard having to be remembered in each
 * one. Kept inline (the codes are repeated from `lib/lead-dead.ts`) so this
 * file stays free of imports.
 */
const DEAD_SENTENCES: Record<string, string> = {
  DL001:
    "This lead is permanently Dead and read-only. It can be viewed, but nothing on it can be changed, reassigned, reopened, converted or added to.",
  DL002:
    "A request to mark this lead Dead is waiting on its manager, so it cannot be reversed until that is decided.",
  DL003: "That Dead request cannot be made or changed.",
};

export function deadLeadRefusalFrom(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 4; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && DEAD_SENTENCES[code]) return DEAD_SENTENCES[code];
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}
