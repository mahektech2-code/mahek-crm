"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Button, Select } from "@/components/ui/primitives";
import { PersonPicker, type Person } from "./person-picker";

/* ---------------------------------------------------------------------------
 * §Q — handing the relationship over.
 *
 * Its own dialog rather than an arm of the sales manager one, for the reason
 * that dialog is its own: these are different decisions held by different
 * people, and a control folded into a dialog somebody cannot open is a
 * permission built and then hidden.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER is "nobody". `PersonPicker` can return
 * null and the sales manager dialog treats that as a real answer, because an
 * account genuinely may have no sales manager. A handover to nobody is not a
 * handover — it is the state every converted account is already in, and the
 * marker exists to get accounts OUT of it. Taking one back is done by handing
 * it to whoever should hold it instead, which is the same act with a
 * different name and needs no second control.
 * ------------------------------------------------------------------------- */

export type HandoverAccount = {
  id: string;
  name: string;
  kind: "lead" | "customer";
  /** Who runs it today, or null where nobody has taken it on. */
  relationshipOwnerName: string | null;
};

export type HandoverChange = {
  toUserId: string;
  reasonCode: string;
  note?: string;
  ids: string[];
};

export function HandoverDialog({
  open,
  accounts,
  people,
  reasons,
  searchThreshold,
  onClose,
  onSubmit,
}: {
  open: boolean;
  accounts: HandoverAccount[];
  /**
   * ACCOUNTS ONLY — never the employee list the sales manager picker also
   * offers. That seat records who somebody answers to and works perfectly for
   * a person with no login; this one grants SIGHT of an account, and a name
   * that cannot sign in cannot be given a book to open.
   */
  people: Person[];
  reasons: string[];
  searchThreshold: number;
  onClose: () => void;
  onSubmit: (change: HandoverChange) => Promise<void>;
}) {
  const [person, setPerson] = React.useState<string | null>(null);
  const [reasonCode, setReasonCode] = React.useState(reasons[0] ?? "");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  /*
   * A LEAD IS SHOWN AND EXCLUDED, never quietly dropped. Ticking a mixed list
   * is the ordinary way this dialog gets opened on one, and the difference
   * between eight moving and "eight moving, two are still leads" is the
   * difference between a manager who knows where those two went and one who
   * finds out in March. The server refuses them again regardless.
   */
  const eligible = accounts.filter((a) => a.kind === "customer");
  const leads = accounts.filter((a) => a.kind !== "customer");

  const noteRequired = /^other$/i.test(reasonCode);
  const canSave =
    !busy && person !== null && reasonCode !== "" && eligible.length > 0 &&
    (!noteRequired || note.trim() !== "");

  async function save() {
    if (!canSave || person === null) return;
    setBusy(true);
    try {
      await onSubmit({
        toUserId: person,
        reasonCode,
        note: note.trim() || undefined,
        ids: eligible.map((a) => a.id),
      });
    } finally {
      setBusy(false);
    }
  }

  const takingOver = eligible.filter((a) => a.relationshipOwnerName !== null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        eligible.length === 1
          ? `Hand over ${eligible[0].name}`
          : `Hand over ${eligible.length} accounts`
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-muted">
          Who runs this account from here. It moves who the account answers to
          day to day and who can open it — it does <strong>not</strong> move
          whose orders it counts as, or whose target it feeds. Those stay with
          the sales account manager.
        </p>

        {leads.length ? (
          <p className="m-0 rounded border border-warning/40 bg-warning/10 p-2 text-xs">
            {leads.length === 1
              ? `${leads[0].name} is still a lead, so it stays out of this — the Lead Manager runs it until it orders.`
              : `${leads.length} of these are still leads and stay out of this — the Lead Manager runs a lead until it orders.`}
          </p>
        ) : null}

        <PersonPicker
          people={people}
          value={person}
          onChange={setPerson}
          threshold={searchThreshold}
          label="Hand the relationship to"
        />

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Why</span>
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            Note {noteRequired ? <span className="text-danger">— required</span> : null}
          </span>
          <textarea
            className="min-h-16 rounded border border-rule bg-surface p-2 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Anything the person taking this on should know"
          />
        </label>

        {/* A handover that takes an account OFF somebody is the half worth
            saying out loud — they are about to be told, and the manager
            pressing the button should know that before it happens rather
            than after. */}
        {takingOver.length ? (
          <p className="m-0 text-xs text-muted">
            {takingOver.length === 1
              ? `${takingOver[0].relationshipOwnerName} currently runs ${takingOver[0].name} and will be told it moved.`
              : `${takingOver.length} of these already have somebody running them. They will be told.`}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={!canSave}
            title={
              eligible.length === 0
                ? "Nothing here can be handed over"
                : person === null
                  ? "Pick who runs it from here"
                  : noteRequired && note.trim() === ""
                    ? "A note is required when the reason is Other"
                    : undefined
            }
          >
            {busy ? "Handing over…" : "Hand over"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
