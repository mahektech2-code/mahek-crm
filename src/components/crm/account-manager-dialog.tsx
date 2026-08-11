"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Button, Select, cx } from "@/components/ui/primitives";
import { PersonPicker, type Person } from "./person-picker";

/* ---------------------------------------------------------------------------
 * Update account manager.
 *
 * TWO managers, asked separately, either or both changeable in one go. Sales
 * is whose book the account is in; back office is who does the dispatch and
 * the paperwork. A salesperson resigning says nothing about who raises the
 * invoices, so folding them into one "owner" would force whoever is covering a
 * leaver to move both and quietly reassign work nobody asked about.
 *
 * The dialog opens with NEITHER selected, and a manager left untouched is left
 * alone — omitted from the request entirely rather than sent as its current
 * value. Sending the current value would stamp a decision mark on an account
 * nobody decided anything about, and that mark is what tells the sheet to keep
 * its hands off.
 *
 * TWO SEATS, TWO REASONS. The reason used to be asked once, at the bottom, for
 * whatever moved — which reads fine until both move at once, and both moving
 * at once is the ordinary case, because that is what happens when somebody
 * leaves. "Salesperson left" was then stamped on the back-office row too, and
 * the history said the dispatch clerk changed because a salesperson resigned.
 * Each seat now carries its own reason and its own note, inside the card it
 * belongs to, and they are stored as the two rows they always were.
 *
 * THE LISTS ARE DIFFERENT ON PURPOSE. Sales offers accounts only, because it
 * decides whose calling queue the account lands in and a name with no login
 * cannot be given a queue. Back office offers accounts AND the current
 * employees from the HRMS master, because it drives no queue — and most of
 * the people who actually do that work have never signed in.
 * ------------------------------------------------------------------------- */

export type AmChange = {
  /** The accounts that will actually move — the review step may trim these. */
  customerIds: string[];
  salesAmId?: string | null;
  backOffice?:
    | { kind: "user"; userId: string }
    | { kind: "employee"; employeeId: string }
    | { kind: "none" };
  sales?: { reasonCode: string; note?: string };
  backOfficeReason?: { reasonCode: string; note?: string };
};

/** One selected account, for the review step. */
export type AmAccount = {
  id: string;
  name: string;
  salesName: string | null;
  backOfficeName: string | null;
};

/**
 * Above this many accounts, the change is reviewed before it is made.
 *
 * Bulk is the whole point of the screen — "everything Suresh had" is forty
 * accounts, not one — and it is also where a filter that selected more than
 * somebody meant does the most damage in a single press. One account is its
 * own review: the row is right there and the dialog names it.
 */
const REVIEW_ABOVE = 1;

export function AccountManagerDialog({
  open,
  accounts,
  salesPeople,
  backOfficePeople,
  reasons,
  searchThreshold,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** Everything selected. The count is derived, so the two cannot disagree. */
  accounts: AmAccount[];
  salesPeople: Person[];
  backOfficePeople: Person[];
  reasons: string[];
  searchThreshold: number;
  onClose: () => void;
  onSubmit: (change: AmChange) => Promise<void>;
}) {
  // `undefined` means "leave this one alone"; `null` means "unassign it".
  const [sales, setSales] = React.useState<string | null | undefined>(undefined);
  const [backOffice, setBackOffice] = React.useState<string | null | undefined>(
    undefined,
  );
  const [salesReason, setSalesReason] = React.useState(reasons[0] ?? "");
  const [salesNote, setSalesNote] = React.useState("");
  const [boReason, setBoReason] = React.useState(reasons[0] ?? "");
  const [boNote, setBoNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [reviewing, setReviewing] = React.useState(false);
  /* Which accounts are still going. Everything, until somebody unticks one. */
  const [going, setGoing] = React.useState<Set<string>>(
    () => new Set(accounts.map((a) => a.id)),
  );

  const changingSales = sales !== undefined;
  const changingBackOffice = backOffice !== undefined;
  const needsNote = (code: string) => /^other$/i.test(code);
  const seatReady = (active: boolean, code: string, note: string) =>
    !active || (Boolean(code) && (!needsNote(code) || note.trim().length > 0));

  const formReady =
    (changingSales || changingBackOffice) &&
    seatReady(changingSales, salesReason, salesNote) &&
    seatReady(changingBackOffice, boReason, boNote);

  const why = !changingSales && !changingBackOffice
    ? "Pick which account manager to change"
    : !seatReady(changingSales, salesReason, salesNote)
      ? "Say what the sales reason is"
      : !seatReady(changingBackOffice, boReason, boNote)
        ? "Say what the back office reason is"
        : undefined;

  const needsReview = accounts.length > REVIEW_ABOVE;
  const chosenCount = going.size;

  /** The change itself, built once so the review and the save cannot differ. */
  const buildChange = (): AmChange => ({
    customerIds: accounts.filter((a) => going.has(a.id)).map((a) => a.id),
    ...(changingSales ? { salesAmId: sales } : {}),
    ...(changingBackOffice
      ? {
          backOffice:
            backOffice === null
              ? ({ kind: "none" } as const)
              : backOffice.startsWith("emp:")
                ? ({ kind: "employee", employeeId: backOffice.slice(4) } as const)
                : ({ kind: "user", userId: backOffice } as const),
        }
      : {}),
    ...(changingSales
      ? { sales: { reasonCode: salesReason, note: salesNote.trim() || undefined } }
      : {}),
    ...(changingBackOffice
      ? {
          backOfficeReason: {
            reasonCode: boReason,
            note: boNote.trim() || undefined,
          },
        }
      : {}),
  });

  const nameOf = (people: Person[], value: string | null | undefined) =>
    value === null
      ? "Unassigned"
      : (people.find((p) => p.id === value)?.name ?? "—");

  const title = reviewing
    ? `Review ${accounts.length} account${accounts.length === 1 ? "" : "s"} before moving`
    : `Update account manager on ${accounts.length} account${accounts.length === 1 ? "" : "s"}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={reviewing ? 640 : 560}
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
            disabled={!formReady || busy || (reviewing && chosenCount === 0)}
            title={
              reviewing && chosenCount === 0
                ? "Nothing is ticked, so nothing would move"
                : why
            }
            onClick={async () => {
              /*
               * The review is a step, not a confirmation dialog: it shows what
               * each account moves FROM, which is the thing somebody cannot
               * check from the selection bar and the thing they most need
               * before moving forty books at once.
               */
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
        <ReviewStep
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
          salesTo={changingSales ? nameOf(salesPeople, sales) : null}
          backOfficeTo={
            changingBackOffice ? nameOf(backOfficePeople, backOffice) : null
          }
          disabled={busy}
        />
      ) : (
        <>
          <p className="mb-4 text-[13px] text-muted">
            Change one or both. Whichever you leave untouched stays as it is — and
            from here the account keeps what you choose, so a sheet sync will not
            put the old name back.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Section
              title="Account manager — Sales"
              hint="Whose book the account is in. Drives the calling queue and collections."
              active={changingSales}
              onToggle={(on) => setSales(on ? null : undefined)}
            >
              <PersonPicker
                label="Assign to"
                people={salesPeople}
                value={sales}
                onChange={setSales}
                threshold={searchThreshold}
                allowUnassigned
                disabled={busy}
              />
              <SeatReason
                reasons={reasons}
                code={salesReason}
                note={salesNote}
                onCode={setSalesReason}
                onNote={setSalesNote}
                disabled={busy}
              />
            </Section>

            <Section
              title="Account manager — Back office"
              hint="Dispatch, billing and paperwork. Anyone on the staff list, with or without a login."
              active={changingBackOffice}
              onToggle={(on) => setBackOffice(on ? null : undefined)}
            >
              <PersonPicker
                label="Assign to"
                people={backOfficePeople}
                value={backOffice}
                onChange={setBackOffice}
                threshold={searchThreshold}
                allowUnassigned
                disabled={busy}
              />
              <SeatReason
                reasons={reasons}
                code={boReason}
                note={boNote}
                onCode={setBoReason}
                onNote={setBoNote}
                disabled={busy}
              />
            </Section>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * What is about to happen, per account, with a way out of any row.
 *
 * The FROM column is why this exists. A selection made through a filter is a
 * list nobody has read line by line, and "Suresh → Priya" beside a customer
 * whose manager was never Suresh is the one thing that catches a filter that
 * caught too much.
 */
function ReviewStep({
  accounts,
  going,
  onToggle,
  salesTo,
  backOfficeTo,
  disabled,
}: {
  accounts: AmAccount[];
  going: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  salesTo: string | null;
  backOfficeTo: string | null;
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
                {salesTo ? (
                  <span className="block">
                    Sales: {a.salesName ?? "Unassigned"} → {salesTo}
                  </span>
                ) : null}
                {backOfficeTo ? (
                  <span className="block">
                    Back office: {a.backOfficeName ?? "Unassigned"} → {backOfficeTo}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The reason for ONE seat, inside the card that seat lives in.
 *
 * Beside the picker rather than under both of them, because a reason that sits
 * below two cards belongs to neither and gets applied to both.
 */
function SeatReason({
  reasons,
  code,
  note,
  onCode,
  onNote,
  disabled,
}: {
  reasons: string[];
  code: string;
  note: string;
  onCode: (v: string) => void;
  onNote: (v: string) => void;
  disabled: boolean;
}) {
  const required = /^other$/i.test(code);
  return (
    <div className="mt-3 border-t border-divider pt-3">
      <label className="mb-1.5 block text-[11px] tracking-wide text-muted uppercase">
        Why this one is changing
      </label>
      <Select value={code} onChange={(e) => onCode(e.target.value)} disabled={disabled}>
        {reasons.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </Select>
      <label className="mt-2 mb-1.5 block text-[11px] tracking-wide text-muted uppercase">
        Note {required ? "(required)" : "(optional)"}
      </label>
      <textarea
        value={note}
        onChange={(e) => onNote(e.target.value)}
        rows={2}
        maxLength={500}
        disabled={disabled}
        placeholder={
          required ? "Say what the reason is" : "Anything the next person should know"
        }
        className="w-full rounded-[4px] border border-line px-2.5 py-2 text-sm outline-none focus:border-brand"
      />
    </div>
  );
}

/**
 * A manager is only changed if it is switched ON, which is what keeps "leave
 * this alone" distinct from "unassign it" all the way to the server.
 */
function Section({
  title,
  hint,
  active,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  active: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-[6px] border p-3 ${active ? "border-brand" : "border-line"}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <span>
          <span className="block text-[13px] font-semibold text-ink">{title}</span>
          <span className="block text-[11px] text-muted">{hint}</span>
        </span>
      </label>
      {active ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}
