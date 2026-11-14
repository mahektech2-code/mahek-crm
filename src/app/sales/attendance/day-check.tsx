"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import type { DayEvidence } from "@/lib/services/day-evidence-service";
import { DayCheck } from "../people/[id]/day-check";

/**
 * THE DAY CHECK, OPENED OVER THE ROLL-CALL IT WAS ASKED FROM.
 *
 * "Check 3" used to be a link to `/sales/people/<id>?day=<day>` — a nine-tab
 * record of a MONTH, opened on one of its tabs, to answer a question about one
 * person on one day. The manager who arrived there had to find his way back to
 * a list he was already reading, and the date he had stepped to was in the URL
 * rather than on the screen he landed on, so the second and third person cost
 * a navigation each. In practice the check does not get done.
 *
 * The question is local and so is the answer. The roll-call is already standing
 * on a date; this fetches that person's day, draws it over the list, and closes
 * back onto the row it came from with the outstanding count already updated.
 *
 * **The full record is still one click away and named**, because "what has he
 * been doing this month" is a real question and this dialog is deliberately not
 * where it is answered.
 *
 * **It is fetched on the press, not carried on every row.** Eleven people's
 * photographs serialised into the roll-call to answer a question about one of
 * them is the mistake the customer record already carries three paragraphs
 * about.
 */
export function DayCheckDialog({
  salesmanId,
  salesmanName,
  day,
  longDay,
  today,
  retentionHours,
  outstanding,
}: {
  salesmanId: string;
  salesmanName: string;
  day: string;
  longDay: string;
  today: string;
  retentionHours: number;
  /** How many marks nobody has answered yet, which is what the button says. */
  outstanding: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [evidence, setEvidence] = React.useState<DayEvidence | null>(null);
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "failed">("idle");

  /* Re-read on every open, and again after a verdict: the dialog holds its own
     copy of the list, so `router.refresh()` — which is what updates the count
     on the row behind it — has nothing to say to what is on the screen. */
  const load = React.useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(
        `/api/sales/day-evidence?salesman=${encodeURIComponent(salesmanId)}&day=${day}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { evidence: DayEvidence | null };
      setEvidence(body.evidence ? revive(body.evidence) : null);
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [salesmanId, day]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          void load();
        }}
        className={
          "cursor-pointer rounded-[4px] border bg-surface px-2.5 py-1 text-[13px] font-medium whitespace-nowrap hover:bg-canvas " +
          (outstanding
            ? "border-warn text-warn-ink"
            : "border-line text-body")
        }
        title={
          outstanding
            ? `${outstanding} photograph${outstanding === 1 ? "" : "s"} on this day that nobody has answered for`
            : "Every mark on this day has a verdict — open it to read them"
        }
      >
        {outstanding ? `Check ${outstanding}` : "Open"}
      </button>
      {/* Silence where there is nothing outstanding, rather than a green "all
          checked" on every row. A line that appears on eleven rows out of
          eleven is furniture, and the one row that wants attention has to
          stand out from it. */}
      {outstanding ? (
        <span className="block text-[12px] text-warn-ink">not looked at yet</span>
      ) : null}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={820}
        title={
          <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span>
              {salesmanName}
              <span className="ml-2 text-[13px] font-normal text-muted">{longDay}</span>
            </span>
            <Link
              href={`/sales/people/${salesmanId}?day=${day}`}
              className="text-[13px] font-medium no-underline hover:underline"
            >
              Open his whole record →
            </Link>
          </span>
        }
      >
        {state === "loading" || state === "idle" ? (
          <p className="py-10 text-center text-[13px] text-muted">Reading his day…</p>
        ) : state === "failed" ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-ink">His day could not be read</p>
            <p className="mt-1 text-[13px] text-muted">
              Nothing has been changed. Try again, and if it keeps failing his record
              opens the same list on its own page.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body hover:bg-canvas"
            >
              Try again
            </button>
          </div>
        ) : (
          <DayCheck
            salesmanId={salesmanId}
            day={day}
            longDay={longDay}
            today={today}
            evidence={evidence}
            retentionHours={retentionHours}
            /* The roll-call behind this is already on a date, and the stepper
               would move only what is inside the dialog. */
            showDateNav={false}
            onChanged={() => {
              void load();
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

/**
 * JSON has no instants, so the wire hands back strings where the type says
 * `Date` — and `DayCheck` formats several of them. Reviving here rather than
 * leaving the type to lie: the alternative is a cast that quiets the compiler
 * across a serialisation boundary, which is the shape of a bug this codebase
 * has already paid for once in `canRead`.
 */
function revive(e: DayEvidence): DayEvidence {
  return {
    ...e,
    attendance: e.attendance
      ? {
          ...e.attendance,
          checkInAt: e.attendance.checkInAt ? new Date(e.attendance.checkInAt) : null,
          checkOutAt: e.attendance.checkOutAt ? new Date(e.attendance.checkOutAt) : null,
        }
      : null,
    items: e.items.map((i) => ({
      ...i,
      at: i.at ? new Date(i.at) : null,
      review: i.review ? { ...i.review, decidedAt: new Date(i.review.decidedAt) } : null,
    })),
  };
}
