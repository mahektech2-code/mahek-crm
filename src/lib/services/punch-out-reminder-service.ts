import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "../config/store";
import { today } from "../recompute";
import { remindersDue } from "../engines/punch-out-reminders";
import { notifyUsers } from "../notify";

/**
 * Telling a salesman still punched in at the end of the day to punch out.
 *
 * Seventy per cent of punched-in days in September were closed by the nightly
 * sweep rather than by the man who worked them, with no closing photograph.
 * The handset makes the button loud from the prompt hour; this is the part
 * that reaches somebody who has put the phone in his pocket.
 *
 * IT IS AN ORDINARY NOTIFICATION. Every message the field gets from MahekOne is
 * a row in `notifications` plus a push, through `notifyUsers`, and this is no
 * different: it is on the bell in the app whether or not the push arrives, and
 * the office can see it was sent.
 *
 * WHAT THE SERVER THINKS IS OPEN IS WHAT THE PHONE LAST SAID. A man who punched
 * out in a lane with no signal is still open here until his phone syncs, so he
 * may be reminded about a day he has closed. That is the cheaper mistake —
 * one message he can ignore, against a day nobody closed — and the handset's
 * own reminder, which knows better, stays on the phone until push is working.
 *
 * Called every half hour. `punch_out_reminders` on the day is what stops a
 * pass sending what an earlier one already sent, and it is CLAIMED by the
 * update before anything is sent, so two overlapping passes cannot both send.
 */
export async function sendPunchOutReminders(): Promise<{ recordsAffected: number; detail: string }> {
  const config = await getConfig();
  const due = remindersDue({
    nowMs: Date.now(),
    promptHour: config["mbos.attendance.punchOutPromptHour"],
    secondAfterMinutes: config["mbos.attendance.punchOutSecondReminderMinutes"],
  });
  if (due === 0) return { recordsAffected: 0, detail: "before the prompt hour" };

  const day = await today();
  const claimed = (await db.execute<{ userId: string }>(sql`
    update mbos_attendance_days d
       set punch_out_reminders = ${due}::int,
           updated_at = now()
      from users u
     where u.id = d.user_id
       and u.active
       and d.day = ${day}::date
       and d.check_in_at is not null
       and d.check_out_at is null
       and d.punch_out_reminders < ${due}::int
    returning d.user_id as "userId"
  `)) as unknown as { userId: string }[];

  if (!claimed.length) return { recordsAffected: 0, detail: `reminder ${due}: nobody still punched in` };

  await notifyUsers(
    claimed.map((r) => ({
      userId: r.userId,
      kind: due === 1 ? "info" : "warn",
      title: due === 1 ? "Still punched in" : "You have not punched out yet",
      body:
        due === 1
          ? "Done for the day? Punch out so your hours stop here. Tap to take the photo."
          : "If you are done, punch out now. Otherwise the system closes your day tonight and your manager has to fix it.",
      /* Through Home's own punch-out, so the photo and the meter reading are
         asked for exactly as they are from the button. */
      mbosHref: "/home?punchOut=1",
    })),
  );

  return { recordsAffected: claimed.length, detail: `reminder ${due} sent to ${claimed.length}` };
}
