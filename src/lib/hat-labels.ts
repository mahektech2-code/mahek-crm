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
 * to "who is this person HERE". Somebody who manages the CRM and holds Accounts
 * as an `associate` — a clerk, deliberately, because the ledger desk's
 * decisions are the Accounts MANAGER's — was greeted on the Accounts header as
 * a manager. A header that overstates somebody's standing on the one screen
 * where standing decides what the buttons do is worse than a header with no
 * designation at all.
 *
 * Vikram is the one exception and the header has to say so rather than hide
 * it. He is ADMIN ON THE ADMIN CONSOLE, which is what a platform administrator
 * is, and a platform administrator holds every capability in every app
 * whatever his grant there reads — so his Accounts header says "Associate" and
 * he can still approve an order. That is the model working, not the label
 * lying: the label answers "what was he given here", and the platform hat is
 * a separate answer that the Admin Console's own header carries. An Accounts
 * associate grant on anybody ELSE now really is associate-only — admin of
 * another app stopped reaching into Accounts the day `can()` began reading an
 * admin hat against its own app.
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
  crm: { associate: "telecaller", manager: "telecalling manager", admin: "CRM administrator" },
  /* A JOB on every level. Manager used to read "the ledger desk", which is a
     place: "Manager on Accounts — the ledger desk" told a reader where the
     person sits and not what they are. */
  accounts: { associate: "accounts clerk", manager: "accounts manager", admin: "Accounts administrator" },
  field: { associate: "field salesman", manager: "field sales manager", admin: "Salesman App administrator" },
  sales: { associate: "reads the field team's day", manager: "sales manager", admin: "Sales Dashboard administrator" },
  reports: { associate: "reads the owner's figures", manager: "reads the owner's figures for a team", admin: "Reports administrator" },
  founder: { associate: "works the founder's desks", manager: "founder", admin: "Command Centre administrator" },
  enquiries: { associate: "works website enquiries", manager: "runs the enquiries desk", admin: "Enquiries administrator" },
  /* The level is only the floor: the job inside Hire is its own role row. */
  hire: { associate: "interviews candidates", manager: "hiring manager", admin: "Hire administrator" },
  /* HRMS is the one app EVERYBODY holds for themselves — checking in, asking
     for leave, reading a payslip — so its associate is a description of that
     rather than a job. The old words ("reads the employee master", "maintains
     the roster") described the employees screen, which most associates are
     narrowed away from and the roster is the sheet's, not anybody's here. */
  hrms: {
    associate: "checks in, asks for leave and reads their own pay",
    manager: "runs the team's attendance and leave",
    admin: "HRMS administrator, holding every power",
  },
  /* What an ERP user may DO is its powers, not its level, so the level's job
     is only how much of the plant they run. */
  erp: { associate: "works the ERP screens they were given", manager: "ERP manager", admin: "ERP administrator, holding every power" },
  /* Admin on the Admin Console is not "the console's administrator" — it is
     the platform administrator, who holds everything everywhere. Manager there
     changes settings; associate reads them. */
  admin: { associate: "reads the console", manager: "changes the settings", admin: "platform administrator" },
};

export function hatSentence(level: string | null | undefined, app: AppId, appName: string): string {
  const word = levelLabel(level);
  if (word === "No role") {
    /* It used to say this fell back to the account's own level. It does not
       any more: a grant with no level is an associate's, and the account level
       is derived from the grants rather than standing behind them. */
    return `No level recorded on ${appName}. A grant with no level is read as an associate's.`;
  }
  /* The one hat that is NOT per app, so the usual closing sentence would be
     false on exactly the header where it matters most. */
  if (app === "admin" && level === "admin") {
    return `${word} on ${appName} — platform administrator. This holds every capability in every app, whatever the level on each one reads.`;
  }
  const job = JOBS[app]?.[level as Level];
  return job
    ? `${word} on ${appName} — ${job}. The level is per app: you may hold a different one elsewhere.`
    : `${word} on ${appName}. The level is per app: you may hold a different one elsewhere.`;
}
