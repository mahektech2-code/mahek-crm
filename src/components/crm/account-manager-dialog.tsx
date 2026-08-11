"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Button, Select } from "@/components/ui/primitives";
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
 * ------------------------------------------------------------------------- */

export type AmChange = {
  salesAmId?: string | null;
  backOfficeAmId?: string | null;
  reasonCode: string;
  note?: string;
};

export function AccountManagerDialog({
  open,
  count,
  people,
  reasons,
  searchThreshold,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  people: Person[];
  reasons: string[];
  searchThreshold: number;
  onClose: () => void;
  onSubmit: (change: AmChange) => Promise<void>;
}) {
  // `undefined` means "leave this one alone"; `null` means "unassign it".
  const [sales, setSales] = React.useState<string | null | undefined>(undefined);
  const [backOffice, setBackOffice] = React.useState<string | null | undefined>(undefined);
  const [reason, setReason] = React.useState(reasons[0] ?? "");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const changingSales = sales !== undefined;
  const changingBackOffice = backOffice !== undefined;
  const noteRequired = /^other$/i.test(reason);
  const canSave =
    (changingSales || changingBackOffice) &&
    Boolean(reason) &&
    (!noteRequired || note.trim().length > 0);

  const why = !changingSales && !changingBackOffice
    ? "Pick which account manager to change"
    : noteRequired && !note.trim()
      ? "Say what the reason is"
      : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={`Update account manager on ${count} account${count === 1 ? "" : "s"}`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave || busy}
            title={why}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit({
                  ...(changingSales ? { salesAmId: sales } : {}),
                  ...(changingBackOffice ? { backOfficeAmId: backOffice } : {}),
                  reasonCode: reason,
                  note: note.trim() || undefined,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Updating…" : "Update"}
          </Button>
        </div>
      }
    >
      <p className="mb-4 text-[13px] text-muted">
        Change one or both. Whichever you leave untouched stays as it is — and
        from here the account keeps what you choose, so a sheet sync will not
        put the old name back.
      </p>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Section
          title="Account manager — Sales"
          hint="Whose book the account is in. Drives the calling queue and collections."
          active={changingSales}
          onToggle={(on) => setSales(on ? null : undefined)}
        >
          <PersonPicker
            label="Assign to"
            people={people}
            value={sales}
            onChange={setSales}
            threshold={searchThreshold}
            allowUnassigned
            disabled={busy}
          />
        </Section>

        <Section
          title="Account manager — Back office"
          hint="Dispatch, billing and paperwork."
          active={changingBackOffice}
          onToggle={(on) => setBackOffice(on ? null : undefined)}
        >
          <PersonPicker
            label="Assign to"
            people={people}
            value={backOffice}
            onChange={setBackOffice}
            threshold={searchThreshold}
            allowUnassigned
            disabled={busy}
          />
        </Section>
      </div>

      <div className="mb-3">
        <label className="mb-1.5 block text-[11px] tracking-wide text-muted uppercase">
          Why is it changing
        </label>
        <Select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}>
          {reasons.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] tracking-wide text-muted uppercase">
          Note {noteRequired ? "(required)" : "(optional)"}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          disabled={busy}
          placeholder={
            noteRequired ? "Say what the reason is" : "Anything the next person should know"
          }
          className="w-full rounded-[4px] border border-line px-2.5 py-2 text-sm outline-none focus:border-brand"
        />
      </div>
    </Modal>
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
