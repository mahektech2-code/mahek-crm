"use client";

import { cx } from "@/components/ui/primitives";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { daysBetween, shortDate } from "@/lib/format";
import type { LeadRecord } from "@/lib/services/lead-console-service";

/* ---------------------------------------------------------------------------
 * §24 — AN ACTIVE LEAD MAY NOT SIT WITH NOTHING OWED BY ANYBODY.
 *
 * Four answers and not a date: the action, the day, the PERSON, and what that
 * person is expected to come back with. A date alone is what this had for
 * years, and a date alone is how a lead sits for six weeks with everybody
 * assuming somebody else is holding it.
 *
 * IT IS A FULL-WIDTH STRIP RATHER THAN A PANEL IN THE RAIL, and that is the
 * change §8.5 item 5 actually asks for. In the rail it sat third, under the
 * gate and under the twelve-rung ladder, which is a scroll on a laptop — so
 * the one line that says what happens next was below the fold on the screen
 * somebody opened to find out what happens next. The gate answers "may this
 * lead move"; this answers "is anybody moving it", and the second question is
 * the one §24 exists for.
 *
 * NOTHING HERE IS DERIVED ON THE CLOCK. `nowMs` is read once on the server and
 * handed down — the React Compiler rules are on, and a value that changes
 * between renders makes an elapsed count jump about.
 * ------------------------------------------------------------------------- */

/**
 * Which of the three things this lead is: on track, past its day, or owing
 * nobody anything.
 *
 * The tone follows the STATUS and not the mood of the sentence, which is the
 * same discipline `roleAction` keeps one file over. `missing` is the danger
 * case deliberately: a lead nobody has committed to is the failure §24 is
 * written against, and drawing it warn beside an overdue action would say the
 * two are the same size of problem. They are not — an overdue action has
 * somebody's name on it and will be chased; an absent one has nobody's and
 * will not.
 */
type Status = "missing" | "overdue" | "planned";

const SKIN: Record<Status, string> = {
  missing: "border-danger bg-danger-soft",
  overdue: "border-warn bg-warn-soft",
  planned: "border-brand bg-brand-soft",
};

/**
 * "In 3 days" / "Today" / "4 days overdue".
 *
 * Deliberately NOT `relativeDays` from `lib/format.ts`, which answers "4 days
 * ago" for the past. That phrasing is right for a thing that HAPPENED — a call
 * logged, a bill raised — and wrong for a thing that was supposed to happen
 * and did not. "Follow up on price — 4 days ago" reads as a note about a
 * completed call; "4 days overdue" reads as a debt, which is what it is. The
 * two words are one character apart on the screen and opposite in meaning, so
 * this one is written out rather than reached for.
 *
 * `daysBetween` is what measures it, over two calendar days in the business's
 * own zone, never over two instants: a stored DATE is not an instant until
 * something names the midnight, and subtracting milliseconds would put an
 * action due tomorrow at "in 0 days" for most of today.
 */
function dueLabel(days: number): string {
  if (days === 0) return "Today";
  if (days > 0) return `In ${days} ${days === 1 ? "day" : "days"}`;
  const late = -days;
  return `${late} ${late === 1 ? "day" : "days"} overdue`;
}

/**
 * WHICH SEAT THE RESPONSIBLE PERSON HOLDS ON THIS LEAD.
 *
 * §8.5 asks for the person AND their role, and nothing stores a role against
 * `lead_next_action_owner_id` — it is a plain `users` reference. Inventing one
 * from their account level would be worse than saying nothing: a role is a
 * LEVEL in MahekOne and the app is the job, so "associate" is what most of
 * these people are and it answers nothing about why they are holding this
 * lead.
 *
 * What CAN be said honestly is which of this lead's own seats they sit in,
 * which is a fact about the row rather than a guess about the person. Where
 * they sit in none, the name goes out on its own — somebody outside the seats
 * can perfectly well be asked to make a call, and naming a seat they do not
 * hold would be a fact nobody established.
 *
 * The seats are read in the same order `vantagesFor` reads them, so the word
 * beside a name here and the vantage beside the same name in "Where this lead
 * stands" cannot disagree about one person.
 */
function seatOf(record: LeadRecord, userId: string): string | null {
  if (record.salesmanId === userId) return "owner — whose book it is";
  if (record.backOfficeAmId === userId) return "back office";
  if (record.leadManagerId === userId) return "lead manager";
  if (record.salesAmId === userId) return "sales account manager";
  if (record.relationshipOwnerId === userId) return "relationship owner";
  return null;
}

export function NextActionBand({
  record,
  active,
  nowMs,
}: {
  record: LeadRecord;
  /**
   * Whether §24 applies at all. A lost lead, a converted one and a parked one
   * are the three cases where owing nobody anything is the CORRECT state —
   * nobody is supposed to be working them — and a danger strip saying so on
   * every closed lead is the marking people learn to ignore. A next action
   * that IS recorded still draws on all three, because a call somebody
   * promised before the lead was parked is a thing they should still see.
   */
  active: boolean;
  nowMs: number;
}) {
  /*
   * ALL THREE PARTS OR NONE. A date with nobody against it is the failure this
   * rule was written about, so a half-filled next action is drawn as no next
   * action rather than as a plan with a gap in it — a strip reading
   * "12 Sep · somebody" is one people stop reading.
   */
  const complete =
    Boolean(record.nextAction) &&
    Boolean(record.nextActionDate) &&
    Boolean(record.nextActionOwnerId);

  if (!complete) {
    if (!active) return null;
    return (
      <div className={cx("mb-4 rounded-[6px] border-l-[3px] px-4 py-3", SKIN.missing)}>
        <div className="text-sm font-semibold text-ink">Nothing is owed by anybody</div>
        <p className="mt-0.5 mb-0 text-[13px] text-pretty text-body">
          An active lead may not sit with no next action against it. Name an action, a day and a
          person — the Commercial tab&rsquo;s first-order panel and every stage move ask for all
          three, and this lead stays on the exception list until one of them does.
        </p>
      </div>
    );
  }

  /* The calendar day in the business's own zone, off the instant the server
     read. `calendarDate` names the zone; a bare local getter would answer in
     whichever zone the machine drawing this happens to be in, and on a server
     in UTC that is five and a half hours early. */
  const today = calendarDate(new Date(nowMs), APP_TIMEZONE);
  const days = daysBetween(today, record.nextActionDate!);

  /*
   * PAST ITS DAY ONLY WHERE NOTHING CAME BACK. An action whose outcome has
   * been recorded is done, whatever its date says, and drawing a finished call
   * as overdue is how a screen teaches people to ignore the colour.
   */
  const overdue = days < 0 && !record.nextActionOutcome;
  const status: Status = overdue ? "overdue" : "planned";
  const seat = record.nextActionOwnerId ? seatOf(record, record.nextActionOwnerId) : null;

  return (
    <div className={cx("mb-4 rounded-[6px] border-l-[3px] px-4 py-3", SKIN[status])}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-semibold text-ink">{record.nextAction}</span>
        <span className={cx("text-[13px] font-medium", overdue ? "text-warn-ink" : "text-body")}>
          · {dueLabel(days)}
        </span>
        <span className="text-[13px] text-muted">· {shortDate(record.nextActionDate!)}</span>
      </div>
      <div className="mt-0.5 text-[13px] text-body">
        {/* The person, then the seat they hold on THIS lead. "somebody" is the
            honest fallback for an owner whose account has since gone: the id
            is still on the row and the work is still theirs to hand on. */}
        {record.nextActionOwnerName ?? "somebody"}
        {seat ? <span className="text-muted"> · {seat}</span> : null}
      </div>
      {/* §24's fourth answer — what that person is expected to come back with.
          Said as "expected back" rather than "outcome" where none is recorded
          yet, because the two are one field and the word has to survive both:
          before the day it is what we are waiting for, after it is what we
          got. Silence on it is a real state and is drawn as one. */}
      <div className="mt-1 text-[13px] text-muted">
        {record.nextActionOutcome
          ? `Expected back: ${record.nextActionOutcome}`
          : "Nothing recorded yet about what this is expected to produce."}
      </div>
    </div>
  );
}
