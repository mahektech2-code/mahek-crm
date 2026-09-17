/* ---------------------------------------------------------------------------
 * THE THREE LEVELS, and the words for them.
 *
 * PURE and client-safe, like `complaint-labels`, `feedback-labels`,
 * `seat-labels` and `role-conflicts` beside it, and for exactly the reason
 * those exist: `access-control.ts` is `server-only` because it reads the
 * database, and the screens that need to NAME a level run in a browser. The
 * Admin Console's app drawer is a client component, and importing the matrix
 * into it does not fail a type check — `server-only` is a bundler guard — it
 * fails the build.
 *
 * `access-control.ts` reads this rather than keeping its own copy, so there is
 * one list and one spelling. A second copy typed into a screen is the mistake
 * this file exists to prevent, and the half that drifts is always the half
 * somebody is reading.
 *
 * A ROLE IS A LEVEL. THE APP IS THE JOB. There is no per-app role vocabulary
 * and there must not be one: associate on the CRM is the telecaller, associate
 * on Accounts is the clerk, associate on the Salesman App is the field
 * salesman — one level, three jobs, decided by the grant rather than by a word
 * typed on a screen.
 * ------------------------------------------------------------------------- */

export type Role = "associate" | "manager" | "admin";

/**
 * In order of reach, which is the order every screen should list them in: the
 * matrix in `access-control.ts` names what each of the lower two carries, and
 * `admin` holds everything everywhere and is not listed there at all.
 */
export const ROLE_LEVELS: readonly Role[] = ["associate", "manager", "admin"];

const ROLE_LABELS: Record<Role, string> = {
  associate: "Associate",
  manager: "Manager",
  admin: "Admin",
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}
