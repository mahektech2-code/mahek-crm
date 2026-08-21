"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Button, Select, cx } from "@/components/ui/primitives";
import { PersonPicker, type Person } from "./person-picker";

/* ---------------------------------------------------------------------------
 * Setting who the salesperson answers to.
 *
 * Its own dialog rather than a third card in the account manager one, because
 * the two are not the same decision and are not held by the same people. Sales
 * and back office are accounts' and admin's — whose book an account is in
 * decides whose targets it counts toward. This seat drives nothing, so it is a
 * manager's, and putting a control they hold inside a dialog they cannot open
 * would mean building the permission and then hiding it.
 *
 * IT HAS TWO SCOPES, and that is the whole feature. A tick-list is how a
 * handful of accounts move. "Everything under Rahul" is a hundred and
 * forty-seven and is what somebody actually needs on the day he leaves — so
 * the second scope is the FILTERS the list is currently showing, run again on
 * the server, rather than a set assembled twenty-five rows at a time.
 *
 * WHICH MEANS THE REVIEW STEP CHANGES SHAPE. A tick-list can be read line by
 * line and the from-column is what catches a filter that caught too much. A
 * filtered transfer cannot: the whole point is that nobody is going to read a
 * hundred and forty-seven rows. What it gets instead is the count, the filters
 * it came from said back in words, and the count sent to the server so a
 * transfer that would now touch a different set is refused rather than
 * quietly made larger.
 * ------------------------------------------------------------------------- */

/** What the dialog is acting on. Exactly one of the two, never both. */
export type SalesManagerScope =
  | { kind: "ids"; ids: string[]; accounts: SalesManagerAccount[] }
  | {
      kind: "filters";
      /** What the list is filtered by, verbatim — the server runs it again. */
      filters: Record<string, string | undefined>;
      /** Said back in words, because a count with no "of what" is not a review. */
      describedAs: string[];
      count: number;
    };

/** One selected account, for the tick-list review. */
export type SalesManagerAccount = {
  id: string;
  name: string;
  salesManagerName: string | null;
};

export type SalesManagerChange = {
  target:
    | { kind: "user"; userId: string }
    | { kind: "employee"; employeeId: string }
    | { kind: "none" };
  reasonCode: string;
  note?: string;
  /** Present only on a filtered transfer — see `expectedCount` in the action. */
  expectedCount?: number;
  /** Present only on a tick-list, after anything was unticked. */
  ids?: string[];
};

/**
 * Above this many accounts, the change is reviewed before it is made. One
 * account is its own review: the row is right there and the dialog names it.
 */
const REVIEW_ABOVE = 1;

export function SalesManagerDialog({
  open,
  scope,
  people,
  reasons,
  searchThreshold,
  onClose,
  onSubmit,
}: {
  open: boolean;
  scope: SalesManagerScope;
  /** Accounts AND current employees — this seat needs no login. */
  people: Person[];
  reasons: string[];
  searchThreshold: number;
  onClose: () => void;
  onSubmit: (change: SalesManagerChange) => Promise<void>;
}) {
  /*
   * `null` is a real answer here — "nobody is their sales manager" — and it is
   * also where the picker starts. Unlike the two-seat dialog there is no
   * "leave this alone" state to keep distinct from it: this dialog changes one
   * thing, and opening it is already saying which.
   */
  const [person, setPerson] = React.useState<string | null>(null);
  const [reasonCode, setReasonCode] = React.useState(reasons[0] ?? "");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [reviewing, setReviewing] = React.useState(false);

  const accounts = scope.kind === "ids" ? scope.accounts : [];
  const count = scope.kind === "ids" ? accounts.length : scope.count;

  /* Which accounts are still going. Everything, until somebody unticks one. */
  const [going, setGoing] = React.useState<Set<string>>(
    () => new Set(accounts.map((a) => a.id)),
  );

  const needsNote = /^other$/i.test(reasonCode);
  const formReady =
    Boolean(reasonCode) && (!needsNote || note.trim().length > 0);
  const why = !reasonCode
    ? "Pick a reason"
    : needsNote && !note.trim()
      ? "A note is required when the reason is Other"
      : undefined;

  const needsReview = count > REVIEW_ABOVE;
  const chosenCount = scope.kind === "ids" ? going.size : count;

  /** The change itself, built once so the review and the save cannot differ. */
  const buildChange = (): SalesManagerChange => ({
    target:
      person === null
        ? { kind: "none" }
        : person.startsWith("emp:")
          ? { kind: "employee", employeeId: person.slice(4) }
          : { kind: "user", userId: person },
    reasonCode,
    note: note.trim() || undefined,
    ...(scope.kind === "ids"
      ? { ids: accounts.filter((a) => going.has(a.id)).map((a) => a.id) }
      : // The number that was on the screen when somebody pressed the button.
        // The server refuses the transfer if the filters now match a different
        // set, rather than moving whatever has since arrived.
        { expectedCount: scope.count }),
  });

  const toName =
    person === null
      ? "Nobody"
      : (people.find((p) => p.id === person)?.name ?? "—");

  const noun = `${count} account${count === 1 ? "" : "s"}`;
  const title = reviewing
    ? `Review ${noun} before moving`
    : `Set the sales manager on ${noun}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={reviewing ? 640 : 520}
      title={title}
      footer={
        <div className="flex items-center justify-end gap-2">
          {reviewing ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReviewing(false)}
              disabled={busy}
            >
              Back
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            disabled={!formReady || busy || chosenCount === 0}
            title={
              chosenCount === 0 ? "Nothing is ticked, so nothing would move" : why
            }
            onClick={async () => {
              if (needsReview && !reviewing) {
                setReviewing(true);
                return;
              }
              setBusy(true);
              try {
                await onSubmit(buildChange());
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? "Updating…"
              : needsReview && !reviewing
                ? "Review the change"
                : needsReview
                  ? `Move ${chosenCount} account${chosenCount === 1 ? "" : "s"}`
                  : "Update"}
          </Button>
        </div>
      }
    >
      {reviewing ? (
        scope.kind === "ids" ? (
          <TickListReview
            accounts={accounts}
            going={going}
            onToggle={(accountId, on) =>
              setGoing((prev) => {
                const next = new Set(prev);
                if (on) next.add(accountId);
                else next.delete(accountId);
                return next;
              })
            }
            to={toName}
            disabled={busy}
          />
        ) : (
          <FilterReview describedAs={scope.describedAs} count={count} to={toName} />
        )
      ) : (
        <>
          <p className="mb-4 text-[13px] text-muted">
            {scope.kind === "filters"
              ? "Every account these filters match, including the ones on other pages. This is the way to hand a whole book over when somebody leaves."
              : "The accounts you ticked."}{" "}
            The sales manager is who the salesperson answers to — it does not
            change whose book an account is in, whose queue it appears on, or
            whose targets it counts toward. Leads are left alone: a lead answers
            to its owner and has no salesperson for a manager to sit above.
          </p>

          <PersonPicker
            label="Sales manager"
            people={people}
            value={person}
            onChange={setPerson}
            threshold={searchThreshold}
            allowUnassigned
            disabled={busy}
          />

          <div className="mt-4 border-t border-divider pt-3">
            <label className="mb-1.5 block text-[11px] tracking-wide text-muted uppercase">
              Why this is changing
            </label>
            <Select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              disabled={busy}
            >
              {reasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <label className="mt-2 mb-1.5 block text-[11px] tracking-wide text-muted uppercase">
              Note {needsNote ? "(required)" : "(optional)"}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              disabled={busy}
              placeholder={
                needsNote
                  ? "Say what the reason is"
                  : "Anything the next person should know"
              }
              className="w-full rounded-[4px] border border-line px-2.5 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * What is about to happen, per account, with a way out of any row.
 *
 * The FROM column is why this exists. A selection is a list nobody has read
 * line by line, and "Suresh → Priya" beside an account whose manager was never
 * Suresh is the one thing that catches a selection that caught too much.
 */
function TickListReview({
  accounts,
  going,
  onToggle,
  to,
  disabled,
}: {
  accounts: SalesManagerAccount[];
  going: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  to: string;
  disabled: boolean;
}) {
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        Untick anything that should stay where it is. Only the ticked accounts
        move.
      </p>
      <div className="max-h-[320px] overflow-y-auto rounded-[6px] border border-line">
        {accounts.map((a) => {
          const on = going.has(a.id);
          return (
            <label
              key={a.id}
              className={cx(
                "flex cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 last:border-0",
                on ? "" : "opacity-45",
              )}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={(e) => onToggle(a.id, e.target.checked)}
                className="h-4 w-4 flex-none cursor-pointer"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                {a.name}
              </span>
              <span className="flex-none text-right text-[12px] text-muted">
                {a.salesManagerName ?? "Unassigned"} → {to}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The review for a transfer nobody is going to read row by row.
 *
 * A hundred and forty-seven checkboxes is a review in name only — it looks
 * like diligence and is scrolled past. What can actually be checked is the
 * QUESTION that produced the set, so the filters are said back in words, and
 * the count that is about to move is the largest thing on the screen.
 */
function FilterReview({
  describedAs,
  count,
  to,
}: {
  describedAs: string[];
  count: number;
  to: string;
}) {
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        Check the filters below are the book you mean. Every account matching
        them moves — including the ones on pages you have not opened.
      </p>
      <div className="rounded-[6px] border border-line p-4">
        <div className="text-[28px] leading-none font-semibold text-ink tabular-nums">
          {count.toLocaleString("en-IN")}
        </div>
        <div className="mt-1 text-[13px] text-muted">
          account{count === 1 ? "" : "s"} move to{" "}
          <span className="text-ink">{to}</span>
        </div>
        <ul className="mt-3 border-t border-divider pt-3 text-[13px] text-body">
          {describedAs.length ? (
            describedAs.map((d) => (
              <li key={d} className="py-0.5">
                {d}
              </li>
            ))
          ) : (
            /* No filters at all is the whole book, and saying so plainly is
               the point: it is a legitimate thing to do and a terrifying thing
               to do by accident. */
            <li className="py-0.5 text-danger">
              No filters — this is every account you can see.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
