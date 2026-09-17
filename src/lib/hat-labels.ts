import type { AppId } from "./apps";

/* ---------------------------------------------------------------------------
 * WHAT A PERSON IS CALLED IN THE APP THEY ARE STANDING IN.
 *
 * AGENTS.md states the model in five words — A ROLE IS A LEVEL, THE APP IS THE
 * JOB — and every header in the product was contradicting it in one of three
 * ways.
 *
 * Most of them printed `users.role`, which is the WIDEST level held anywhere,
 * rebuilt by `setAccess`. That is the right answer to "what may this person
 * DO", because capabilities are the union of the hats; it is the wrong answer
 * to "who is this person HERE". Vikram is an admin on the account and an
 * `associate` on Accounts — a clerk, deliberately, because the ledger desk's
 * decisions are the Accounts MANAGER's — and the Accounts header told him he
 * was an admin. A header that overstates somebody's standing on the one screen
 * where standing decides what the buttons do is worse than a header with no
 * designation at all.
 *
 * The Sales Dashboard did something different and worse: it printed a title
 * derived from the SCOPE — "National sales manager" — which is not a level, is
 * not stored anywhere, and reads as a job title the company does not issue. An
 * associate granted the Sales Dashboard was greeted as a national manager.
 *
 * And Reports and the Founder Dashboard printed nothing at all, which at least
 * had the merit of not being wrong.
 *
 * PURE AND CLIENT-SAFE, like `seat-labels` and `complaint-labels` beside it:
 * these headers are client components and the resolver that reads the grant is
 * `server-only`, so the two halves can only share a module that imports
 * neither. A second copy typed into a screen is how two apps come to call one
 * person two things.
 * ------------------------------------------------------------------------- */

export type Level = "associate" | "manager" | "admin";

/**
 * The word itself, and it is the LEVEL rather than the job.
 *
 * A `Record` rather than a ternary chain, for the reason `seat-labels` carries:
 * a chain's last arm silently absorbs a fourth value, and this one is rendered
 * on every screen in the product. A fourth level cannot be added without
 * completing this.
 */
export const LEVEL_LABELS: Record<Level, string> = {
  associate: "Associate",
  manager: "Manager",
  admin: "Admin",
};

export function levelLabel(level: string | null | undefined): string {
  return LEVEL_LABELS[(level ?? "") as Level] ?? "No role";
}

/**
 * WHAT THE LEVEL AMOUNTS TO IN THIS APP, for the hover.
 *
 * The level is the truth and the job is what it means where you are standing —
 * "associate on the CRM is the telecaller, associate on Accounts is the clerk,
 * associate on the Salesman App is the field salesman: one level, three jobs,
 * decided by the grant rather than by a word." That sentence is AGENTS.md's
 * own, and it is exactly what a reader of a one-word designation cannot work
 * out for themselves.
 *
 * It is a hover rather than a second line because the header is 44px and the
 * level is the part that has to be readable at a glance. Not every pair has a
 * job name, and where there is none the sentence says the level and the app
 * and stops — inventing one would put a title on somebody that the company
 * does not issue, which is the mistake this whole file exists to undo.
 */
const JOBS: Partial<Record<AppId, Partial<Record<Level, string>>>> = {
  /* The JOB, which is the whole point of this map: "associate on the CRM is
     the telecaller" is AGENTS.md's own sentence. It is never compared against
     `users.role` and never reaches SQL. role-name-ok */
  crm: { associate: "telecaller", manager: "telecalling manager" },
  accounts: { associate: "ledger clerk", manager: "the ledger desk" },
  field: { associate: "field salesman", manager: "field sales manager" },
  sales: { manager: "sales manager" },
  hrms: { associate: "reads the employee master", manager: "maintains the roster" },
};

export function hatSentence(level: string | null | undefined, app: AppId, appName: string): string {
  const word = levelLabel(level);
  if (word === "No role") {
    return `No level recorded on ${appName}. What you may do falls back to your account.`;
  }
  const job = JOBS[app]?.[level as Level];
  return job
    ? `${word} on ${appName} — ${job}. The level is per app: you may hold a different one elsewhere.`
    : `${word} on ${appName}. The level is per app: you may hold a different one elsewhere.`;
}
