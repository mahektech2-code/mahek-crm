import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { dueTodayWindow, overdueWindow, STILL_WORKING } from "../lead-action-window";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * §8.1 — THE TWO NUMBERS THE SIDEBAR DRAWS BESIDE THE LEAD ROWS.
 *
 * Before this, a person had to OPEN the workspace to find out whether anything
 * on a lead had gone past its day. The sidebar is drawn on every screen of the
 * app and is the one thing a telecaller can see while they are doing something
 * else entirely, which is exactly what a badge is for — and the lead rows were
 * the only ten destinations in the CRM that carried none.
 *
 * **A BADGE IS A QUEUE, NEVER A POPULATION, and that is why neither of these
 * is the size of the book.** The three badges that already exist decide the
 * same way: Reminders counts what is `pending` AND due today or earlier, not
 * every reminder ever written; Complaints counts the open ones, not every
 * complaint. A number that is never zero is furniture, and furniture beside a
 * link is read exactly as often as the resize grip the microphone used to be
 * drawn at the weight of. "412 leads" would have been on that column every
 * working day of the year and would have taught everybody to stop looking at
 * the column, taking the two numbers that DO mean something with it.
 *
 * So the two are §24's two windows, which is the one question in the funnel
 * with a deadline on it: what is owed TODAY, and what has gone PAST its day.
 *
 * **THEY ARE THE SCREENS' OWN CLAUSES AND NOT A SECOND READING OF THEM.**
 * `dueTodayWindow` and `overdueWindow` are what the Due and Overdue tabs are
 * made of, what the leads list's own Today and Overdue views resolve to, and
 * what the dashboard's attention card counts — `lib/lead-action-window.ts`
 * exists precisely so a fourth reader can take them rather than write a fourth
 * copy. A badge is the half nobody checks: nobody ever presses a sidebar
 * number and counts the rows it opened, so a badge derived beside its screen
 * would be wrong for months in front of everybody.
 *
 * **ONE STATEMENT, because it is asked on every render of every CRM screen.**
 * Two conditional counts over one scan of the same scoped set, beside the
 * three counts the layout already asks for — and `managerScope` is cached for
 * the request, so the narrowing costs nothing extra here.
 *
 * SCOPED LIKE EVERY OTHER LIST. `leadsVisible` is the same narrowing the lists
 * behind these rows run through: a badge that counted past the scope would be
 * a way around it rather than a summary of it.
 *
 * IN RAW SQL, QUALIFY EVERY COLUMN OF THE OUTER TABLE. Drizzle renders a bare
 * `"id"` for `${customers.id}`, which inside a correlated subquery binds to
 * the INNER table and silently makes the condition false. Every reference
 * below is spelled `c.` for that reason, and so is every fragment it splices.
 * ------------------------------------------------------------------------- */

export type LeadSidebarCounts = {
  /** §24's first window — a next action falling today, and a park read back. */
  dueToday: number;
  /** Past its day with nobody having answered it. Drawn red. */
  overdue: number;
};

/**
 * The two, for whoever is asking.
 *
 * `day` is the business date the CALLER already resolved — never `now()` in a
 * statement, because the working day is Asia/Kolkata and a bare cast reads in
 * the session's zone, which on a server running in GMT puts a Monday promise
 * on Sunday.
 */
export async function leadSidebarCounts(day: string): Promise<LeadSidebarCounts> {
  const scope = await managerScope();

  const rows = await db.execute<{ dueToday: number; overdue: number }>(sql`
    select count(*) filter (where ${dueTodayWindow(day)})::int as "dueToday",
           count(*) filter (where ${overdueWindow(day)})::int as overdue
      from customers c
     where ${STILL_WORKING}
       ${leadsVisible(scope)}
  `);

  return {
    dueToday: Number(rows[0]?.dueToday ?? 0),
    overdue: Number(rows[0]?.overdue ?? 0),
  };
}
