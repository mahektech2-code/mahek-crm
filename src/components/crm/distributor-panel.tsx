"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { ConfirmDialog, Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { shortDate } from "@/lib/format";
import {
  addDistributor,
  removeDistributor,
  updateDistributor,
} from "@/lib/actions/third-party";
import type { Result } from "@/lib/result";
import {
  DistributorPicker,
  type DistributorCandidate,
} from "./distributor-picker";

export type PanelLink = {
  id: string;
  distributorId: string;
  distributorName: string;
  distributorCity: string | null;
  stillDirect: boolean;
  isPrimary: boolean;
  note: string | null;
  deliveredOrders: number;
  lastDeliveredAt: string | null;
};

/**
 * Who bills this shop — the panel on a third-party customer's record.
 *
 * It is the arrangement AND the evidence in one place, because the two are
 * read together and disagree usefully. The link is what somebody decided; the
 * delivery count beside it is what the order sheet has actually seen. A named
 * distributor with no deliveries behind it is worth noticing, and so is a
 * distributor sending two hundred loads to a shop nobody has named them for.
 *
 * Every action here takes `customer.classify`, checked in the action. Where
 * the reader does not hold it the panel still draws — knowing who bills a shop
 * is the point of the record, and a screen that hides a fact because you may
 * not change it is a screen that has stopped answering the question.
 */
export function DistributorPanel({
  customerId,
  customerName,
  links,
  canEdit,
  /** False on a direct customer, where these are FORMER arrangements. */
  isThirdParty,
}: {
  customerId: string;
  customerName: string;
  links: PanelLink[];
  canEdit: boolean;
  isThirdParty: boolean;
}) {
  const router = useRouter();
  const { run: toasted } = useToast();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<PanelLink | null>(null);
  const [removing, setRemoving] = React.useState<PanelLink | null>(null);
  const [busy, setBusy] = React.useState(false);

  /** Every write here: toast whatever it says, refresh the record if it took. */
  async function run<T>(work: Promise<Result<T>>): Promise<boolean> {
    setBusy(true);
    try {
      const result = await toasted(work);
      if (result.ok) router.refresh();
      return result.ok;
    } finally {
      setBusy(false);
    }
  }

  const only = links.length === 1;

  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-5 py-3.5">
        <span className="text-lg leading-6 font-semibold text-ink">
          {isThirdParty ? "Distributors" : "Billed through"}
        </span>
        <span className="flex items-center gap-3">
          <span className="text-[13px] text-muted">
            {links.length === 0 ? "none" : links.length}
          </span>
          {canEdit ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Add distributor
            </Button>
          ) : null}
        </span>
      </div>

      {links.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          {isThirdParty
            ? // The state the conversion rules exist to prevent, and it is
              // reachable only on an account marked before they existed. Said
              // plainly rather than drawn as an empty list, because it is a
              // job somebody has to do rather than a fact about the shop.
              "Nobody is recorded as billing this shop. It was marked as a third-party customer before distributors were recorded — name who bills it."
            : "Nothing is delivered here on somebody else's bill."}
        </p>
      ) : (
        <div className="px-5 py-3">
          {links.map((l) => (
            <div
              key={l.id}
              className="flex items-start justify-between gap-3 border-b border-divider py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="text-sm text-ink">
                  <Link
                    href={`/crm/customers/${l.distributorId}`}
                    className="text-ink no-underline hover:underline"
                  >
                    {l.distributorName}
                  </Link>
                  {l.isPrimary ? (
                    <span className="ml-2">
                      <Badge tone="brand">Usual</Badge>
                    </span>
                  ) : null}
                  {/* The link is not rewritten when the account at the other
                      end of it changes, so this is said rather than silently
                      corrected — it is still who billed this shop. */}
                  {l.stillDirect ? null : (
                    <span
                      className="ml-2"
                      title="This account is no longer a direct customer we bill, so the arrangement needs looking at."
                    >
                      <Badge tone="warn">Not a direct customer now</Badge>
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-muted">
                  {l.distributorCity ? `${l.distributorCity} · ` : ""}
                  {l.deliveredOrders > 0
                    ? `${l.deliveredOrders} deliver${l.deliveredOrders === 1 ? "y" : "ies"} on their bill${
                        l.lastDeliveredAt ? `, last ${shortDate(l.lastDeliveredAt)}` : ""
                      }`
                    : "no deliveries recorded on their bill yet"}
                </div>
                {l.note ? (
                  <div className="mt-0.5 text-[12px] text-body">{l.note}</div>
                ) : null}
              </div>
              {canEdit ? (
                <div className="flex shrink-0 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(l)}>
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || (isThirdParty && only)}
                    title={
                      isThirdParty && only
                        ? "A third-party customer has to have somebody billing it. Add another distributor first, or stop treating this account as a third-party customer."
                        : undefined
                    }
                    onClick={() => setRemoving(l)}
                  >
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <LinkDialog
        open={adding}
        title={`Add a distributor for ${customerName}`}
        customerId={customerId}
        exclude={links.map((l) => l.distributorId)}
        onClose={() => setAdding(false)}
        onSave={async ({ distributorId, isPrimary, note }) => {
          if (!distributorId) return false;
          return run(
            addDistributor({ customerId, distributorId, isPrimary, note }),
          );
        }}
      />

      <LinkDialog
        // Keyed, so opening it on a second row starts from that row's values
        // rather than the first row's. Resetting state in an effect is what
        // the React Compiler rules here rule out.
        key={editing?.id ?? "none"}
        open={Boolean(editing)}
        title={`Edit ${editing?.distributorName ?? ""}`}
        customerId={customerId}
        exclude={links
          .filter((l) => l.id !== editing?.id)
          .map((l) => l.distributorId)}
        initial={
          editing
            ? {
                distributorId: editing.distributorId,
                distributorName: editing.distributorName,
                isPrimary: editing.isPrimary,
                note: editing.note ?? "",
              }
            : undefined
        }
        onClose={() => setEditing(null)}
        onSave={async ({ distributorId, isPrimary, note }) => {
          if (!editing) return false;
          return run(
            updateDistributor({
              linkId: editing.id,
              ...(distributorId && distributorId !== editing.distributorId
                ? { distributorId }
                : {}),
              isPrimary,
              // Empty clears it. `null` and "leave it alone" are different
              // intentions, and the action reads them apart.
              note: note.trim() ? note.trim() : null,
            }),
          );
        }}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this distributor?"
        body={
          removing
            ? `${removing.distributorName} will no longer be recorded as billing ${customerName}. Orders already delivered here on their bill are untouched.`
            : ""
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (removing) await run(removeDistributor(removing.id));
        }}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

/**
 * Add and Edit are ONE dialog, because they ask the same three questions —
 * which distributor, are they the usual one, and what should the next person
 * know. Two dialogs would be two places for the "usual" rule to be worded
 * differently.
 */
function LinkDialog({
  open,
  title,
  customerId,
  exclude,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  customerId: string;
  exclude: string[];
  initial?: {
    distributorId: string;
    distributorName: string;
    isPrimary: boolean;
    note: string;
  };
  onClose: () => void;
  onSave: (values: {
    distributorId: string;
    isPrimary: boolean;
    note: string;
  }) => Promise<boolean>;
}) {
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(
    initial ? { id: initial.distributorId, name: initial.distributorName } : null,
  );
  const [isPrimary, setIsPrimary] = React.useState(initial?.isPrimary ?? false);
  const [note, setNote] = React.useState(initial?.note ?? "");
  const [saving, setSaving] = React.useState(false);

  async function save() {
    if (!picked) return;
    setSaving(true);
    try {
      const done = await onSave({ distributorId: picked.id, isPrimary, note });
      if (done) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!picked || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {picked ? (
        <div className="flex items-center justify-between gap-3 rounded-[4px] border border-line px-3 py-2.5">
          <span className="text-sm text-ink">{picked.name}</span>
          <Button variant="secondary" size="sm" onClick={() => setPicked(null)}>
            Change
          </Button>
        </div>
      ) : (
        <DistributorPicker
          autoFocus
          excludeCustomerId={customerId}
          exclude={exclude}
          onPick={(c: DistributorCandidate) => setPicked({ id: c.id, name: c.name })}
        />
      )}

      <label className="mt-3 flex items-center gap-2 text-sm text-body">
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
        />
        The distributor who serves this shop usually
      </label>
      <p className="mt-1 text-[12px] text-muted">
        There is only ever one. Ticking it here takes it off whoever holds it
        now, which is what handing it over means.
      </p>

      <div className="mt-3">
        <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Note
        </div>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="The route, the rate, anything the next person needs (optional)"
        />
      </div>
    </Modal>
  );
}
