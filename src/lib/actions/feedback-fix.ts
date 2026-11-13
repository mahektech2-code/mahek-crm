"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { feedback } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/access-control";
import { canTriageFeedback } from "@/lib/services/feedback-access";
import { FIX_NEEDS, type FixNeed } from "@/lib/feedback-fix";
import {
  createIssue,
  diagnoseFeedback,
  getFix,
  requestAiFix,
  setNeed,
  syncFeedbackFixes,
  type FixView,
} from "@/lib/services/feedback-fix-service";
import { ADMIN } from "@/lib/admin-routes";
import { err as fail, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * The console's "Fix it" card. Reading a report, saying what it needs and
 * sending it to GitHub are triage's — the same people who answer it. Asking
 * Claude to write the fix is a PLATFORM ADMINISTRATOR's alone, checked here
 * and not only by hiding the button: it spends money and opens a pull request
 * on the codebase.
 * ------------------------------------------------------------------------- */

async function triager() {
  const user = await requireUser();
  if (!(await canTriageFeedback(user))) return null;
  return user;
}

/** Always the report a "same problem" points at. */
async function rootIdOf(id: string): Promise<string | null> {
  const [r] = await db
    .select({ id: feedback.id, dup: feedback.duplicateOfId })
    .from(feedback)
    .where(eq(feedback.id, id))
    .limit(1);
  return r ? (r.dup ?? r.id) : null;
}

function refresh() {
  try {
    revalidatePath(ADMIN.feedback(), "layout");
  } catch {
    /* outside a request */
  }
}

export async function checkWhatItNeeds(id: string): Promise<Result<FixView>> {
  const user = await triager();
  if (!user) return fail("Only somebody who answers feedback can do that.", "not_permitted");
  const root = await rootIdOf(id);
  if (!root) return fail("That report is no longer here.", "not_found");
  const r = await diagnoseFeedback(root, user.id);
  if (!r.ok) return fail(r.error);
  refresh();
  return ok(r.fix, "Read.");
}

export async function chooseWhatItNeeds(id: string, need: FixNeed): Promise<Result<FixView | null>> {
  const user = await triager();
  if (!user) return fail("Only somebody who answers feedback can do that.", "not_permitted");
  if (!FIX_NEEDS.includes(need)) return fail("Not one of the choices.");
  const root = await rootIdOf(id);
  if (!root) return fail("That report is no longer here.", "not_found");
  const fix = await getFix(root);
  if (fix?.issueNumber && need !== "code_change") {
    return fail(`It is already GitHub issue #${fix.issueNumber}. Close the issue there first.`);
  }
  await setNeed(root, need, user.id);
  refresh();
  return ok(await getFix(root), "Saved.");
}

export async function sendToDeveloper(id: string): Promise<Result<{ number: number; url: string }>> {
  const user = await triager();
  if (!user) return fail("Only somebody who answers feedback can do that.", "not_permitted");
  const root = await rootIdOf(id);
  if (!root) return fail("That report is no longer here.", "not_found");
  const r = await createIssue(root, user.id);
  if (!r.ok) return fail(r.error);
  refresh();
  return ok({ number: r.number, url: r.url }, `Sent as GitHub issue #${r.number}.`);
}

export async function askClaudeToFix(id: string): Promise<Result<{ issueNumber: number }>> {
  const user = await requireUser();
  if (!(await isPlatformAdmin(user))) {
    return fail("Only a platform administrator can ask Claude to write a fix.", "not_permitted");
  }
  const root = await rootIdOf(id);
  if (!root) return fail("That report is no longer here.", "not_found");
  const r = await requestAiFix(root, user.id);
  if (!r.ok) return fail(r.error);
  refresh();
  return ok(
    { issueNumber: r.issueNumber },
    `Claude has been asked on issue #${r.issueNumber}. Its pull request needs a person to review and merge it.`,
  );
}

/** "Check now" — the hourly pass, run on demand. */
export async function checkFixesNow(): Promise<Result<null>> {
  const user = await triager();
  if (!user) return fail("Only somebody who answers feedback can do that.", "not_permitted");
  const r = await syncFeedbackFixes();
  refresh();
  return ok(
    null,
    r.closed
      ? `${r.closed} report${r.closed === 1 ? "" : "s"} closed — the fix is live.`
      : r.errors
        ? "GitHub did not answer for some of them. Try again shortly."
        : "Checked. Nothing new is live yet.",
  );
}
