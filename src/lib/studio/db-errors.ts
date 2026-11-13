/* ---------------------------------------------------------------------------
 * Telling a database refusal from a fault, without ever showing the database's
 * own words to a person.
 *
 * Drizzle wraps the driver's error and keeps the original on `cause`, so the
 * PostgreSQL error code can be one or two levels down. A unique violation is
 * 23505: it is how two people doing the same thing at the same moment find out
 * they did, and it is an ordinary answer ("somebody got there first"), never an
 * error message.
 * ------------------------------------------------------------------------- */

const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(e: unknown): boolean {
  let x: unknown = e;
  for (let depth = 0; depth < 5 && x && typeof x === "object"; depth++) {
    if ((x as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}
