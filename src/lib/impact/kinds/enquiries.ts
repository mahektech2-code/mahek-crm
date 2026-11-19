import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { enquiries, enquiryActivity, reminders } from "@/db/schema";
import { listUserApps } from "@/lib/access";
import { requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { readSubmissionFields, effectiveSubmission } from "@/lib/enquiry-submission";
import { stamp } from "@/lib/format";
import type { ImpactSource } from "../registry";
import { present, word } from "./crm-common";
import { reminderDismissImpact } from "./crm-customers";

/* ---------------------------------------------------------------------------
 * WHAT GOES WHEN THE ENQUIRY DESK TAKES SOMETHING AWAY.
 *
 * Three acts, all small, and each said before it happens: an enquiry marked
 * as spam leaves the list and every count; a note's words go; a follow-up
 * leaves somebody's Call Log. None of them deletes a row — spam is a stage,
 * a deleted note leaves its place in the story, a cancelled follow-up stays
 * on the record as dismissed — and each report says so.
 *
 * Every one asks the Website Enquiries grant, which is the whole of
 * `requireEnquiriesAccess`'s question; the follow-up also asks
 * `reminder.close`, as `dismissReminder` does.
 * ------------------------------------------------------------------------- */

async function requireEnquiries(): Promise<void> {
  const user = await requireUser();
  if (!(await listUserApps(user.id)).includes("enquiries")) {
    throw Object.assign(new Error("Only somebody with Website Enquiries access can do that."), { name: "NotPermittedError" });
  }
}

/* ================================================ an enquiry marked as spam */

export const enquirySpamImpact: ImpactSource = {
  authorize: requireEnquiries,

  async report(enquiryId) {
    const [e] = await db
      .select({
        raw: enquiries.rawSubmission,
        corrections: enquiries.corrections,
        stage: enquiries.stage,
        customerId: enquiries.customerId,
        assignedToId: enquiries.assignedToId,
        notes: sql<number>`(select count(*)::int from enquiry_activity a where a.enquiry_id = ${enquiries.id} and a.kind in ('note','note_edited'))`,
      })
      .from(enquiries)
      .where(eq(enquiries.id, enquiryId));
    if (!e) return null;
    const name = readSubmissionFields(effectiveSubmission(e.raw, e.corrections)).name;

    return {
      title: name ?? "this enquiry",
      verb: "Mark as spam",
      confirmWord: word(name, "spam"),
      items: present([
        {
          app: "Enquiries",
          label: "enquiry on the list and in the counts",
          effect: "changed",
          count: e.stage === "spam" ? 0 : 1,
          note: `It leaves All, its stage tab, the totals${e.assignedToId ? "" : " and the Unassigned banner"}, and shows only under Spam. Moving it to any other stage brings it back.`,
        },
        {
          app: "Enquiries",
          label: Number(e.notes) === 1 ? "note on it" : "notes on it",
          effect: "kept",
          count: Number(e.notes),
          note: "The activity stays as it is, with this marking added.",
        },
        {
          app: "Enquiries",
          label: "submission itself",
          effect: "kept",
          count: 1,
          note: "Nothing is deleted. A deleted enquiry would come straight back when the website sends it again; a spam one is recognised.",
        },
      ]),
      blockers: e.customerId
        ? ["A customer is linked to this enquiry, so it is not spam. Close it instead."]
        : e.stage === "spam"
          ? ["It is already marked as spam."]
          : [],
    };
  },
};

/* ======================================================= a note deleted */

export const enquiryNoteImpact: ImpactSource = {
  authorize: requireEnquiries,

  async report(activityId) {
    const [n] = await db
      .select({ kind: enquiryActivity.kind, note: enquiryActivity.note, at: enquiryActivity.at })
      .from(enquiryActivity)
      .where(eq(enquiryActivity.id, activityId));
    if (!n) return null;
    const live = n.kind === "note" || n.kind === "note_edited";
    const text = n.note ?? "";
    return {
      title: `your note of ${stamp(n.at.toISOString())}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: present([
        {
          app: "Enquiries",
          label: "note's words",
          effect: "deleted",
          count: live ? 1 : 0,
          examples: [text.length > 80 ? `${text.slice(0, 80)}…` : text],
          note: "The activity keeps a line saying a note was written here and deleted, by you.",
        },
      ]),
      blockers: live ? [] : ["That note has already been deleted."],
    };
  },
};

/* ================================================ a follow-up cancelled */

/**
 * The CRM's own reminder report — what leaves the Call Log, what was being
 * held for it — asked through the Enquiries grant rather than the CRM book,
 * which a desk that holds only Enquiries does not have.
 */
export const enquiryReminderImpact: ImpactSource = {
  authorize: async (reminderId) => {
    await requireEnquiries();
    await requireCapability("reminder.close");
    const [r] = await db
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.id, reminderId), sql`${reminders.enquiryId} is not null`));
    if (!r) throw Object.assign(new Error("That follow-up is not on an enquiry."), { name: "NotPermittedError" });
  },
  report: (reminderId) => reminderDismissImpact.report(reminderId),
};
