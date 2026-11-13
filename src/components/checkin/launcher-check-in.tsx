"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { ToastProvider } from "@/components/ui/toast";
import { cx } from "@/components/ui/primitives";
import { CheckInPanel, type CheckInState } from "./check-in-panel";

/* ---------------------------------------------------------------------------
 * THE LAUNCHER'S CHECK-IN. Checking in moved out of the HRMS (Nov 2026): the
 * launcher is where everybody lands after signing in, so the day starts there.
 * A strip says where the day stands and opens the dialog; the dialog opens by
 * itself on the first visit of a day nobody has checked in on, and a link with
 * `?checkin=1` opens it on purpose. HRMS Home draws this same strip, for
 * somebody whose only app is HRMS and who therefore never sees the launcher.
 *
 * "Later" closes it until the next day, remembered per browser — a reminder,
 * never a gate: nothing in MahekOne waits on a check-in.
 * ------------------------------------------------------------------------- */

const promptedKey = (date: string) => `mahek.checkin.prompted.${date}`;

function readPrompted(date: string): boolean {
  try {
    return window.localStorage.getItem(promptedKey(date)) === "1";
  } catch {
    return false;
  }
}

function markPrompted(date: string) {
  try {
    window.localStorage.setItem(promptedKey(date), "1");
  } catch {
    /* private window: it simply asks again next time */
  }
}

export function LauncherCheckIn({ state, canHelp, ask }: { state: CheckInState; canHelp: boolean; ask: boolean }) {
  const [open, setOpen] = useState(false);
  const t = state.today;
  const pending = state.linked && !t;

  /* Read the browser's memory after mounting, never during render: the server
     has none, and the two must draw the same first frame. */
  useEffect(() => {
    if (ask || (pending && !readPrompted(state.date))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- opening once on arrival is the point
      setOpen(true);
    }
  }, [ask, pending, state.date]);

  function close() {
    markPrompted(state.date);
    setOpen(false);
  }

  const status = !state.linked
    ? { dot: "bg-muted", title: "Check-in is not set up", line: "Your account is not linked to an employee record yet." }
    : !t
      ? { dot: "bg-warn", title: "Not checked in", line: [state.office, state.official ? `office hours ${state.official}` : ""].filter(Boolean).join(" · ") }
      : t.out
        ? { dot: "bg-success", title: `Day done · ${t.in} – ${t.out}`, line: `${t.worked} · ${t.workDay}` }
        : { dot: "bg-success", title: `Checked in at ${t.in}`, line: [state.office, t.late].filter(Boolean).join(" · ") };

  return (
    <ToastProvider>
      <div className="flex items-center gap-4 rounded-[8px] border border-line bg-surface px-5 py-3.5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <span className={cx("size-2.5 flex-none rounded-full", status.dot)} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{status.title}</span>
          {status.line ? <span className="mt-px block truncate text-[13px] text-muted">{status.line}</span> : null}
        </span>
        {state.linked && !(t && t.out) && !(t && t.field) ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cx(
              "h-9 flex-none rounded-[7px] px-4 text-sm font-semibold whitespace-nowrap",
              t ? "border border-line-strong bg-surface text-ink hover:bg-canvas" : "bg-brand text-white hover:bg-brand-hover",
            )}
          >
            {t ? "Check out" : "Check in"}
          </button>
        ) : null}
      </div>
      <Modal open={open} onClose={close} title={t ? "Your day" : "Check in"} width={480}>
        <CheckInPanel state={state} canHelp={canHelp} onDone={close} />
        {pending ? (
          <div className="mt-4 flex justify-end border-t border-divider pt-3">
            <button type="button" onClick={close} className="h-9 rounded-[7px] border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas">
              Later
            </button>
          </div>
        ) : null}
      </Modal>
    </ToastProvider>
  );
}
