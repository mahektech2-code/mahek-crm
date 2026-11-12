// Server operations return a Result instead of throwing across a boundary, so the UI maps errors
// without exceptions (ARCHITECTURE.md section 12).
export type ErrorCode = "invalid_request" | "not_found" | "rule_violation" | "render_failed" | "unavailable";

export type Result<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** A plain-language message that is safe to show to a user. */
      error: string;
      code: ErrorCode;
      fieldErrors?: Record<string, string>;
      /** A short reference the user can quote to support; also written to the log. */
      refId?: string;
    };

export type Failure = Extract<Result<never>, { ok: false }>;

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const fail = (code: ErrorCode, error: string, extra: { fieldErrors?: Record<string, string>; refId?: string } = {}): Failure => ({ ok: false, code, error, ...extra });

/** The HTTP status that goes with an error code. */
export const STATUS_FOR_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  rule_violation: 422,
  render_failed: 500,
  /** A source the request depends on could not be read now (for example the CRM); nothing was served from a copy. */
  unavailable: 503,
};
