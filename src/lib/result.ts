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
  const message = e instanceof Error ? e.message : "Something went wrong.";
  return { ok: false, error: message, code: "validation" };
}
