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
  recordDeliveryAddress,
  removeDistributor,
  updateDistributor,
} from "@/lib/actions/third-party";
import type { Result } from "@/lib/result";
import {
  DistributorPicker,
  type DistributorCandidate,
} from "./distributor-picker";

export type Relation = {
  customerId: string;
  name: string;
  city: string | null;
  recorded: boolean;
  linkId: string | null;
  isPrimary: boolean;
  note: string | null;
  stillDirect: boolean;
  kind: "lead" | "customer";
  thirdParty: boolean;
  orders: number;
  lastAt: string | null;
};

/**
 * THE DELIVERY CHAIN, AS ONE LIST PER DIRECTION.
 *
 * It was two panels answering one question between them: what a person
 * recorded, and — under its own title — every shop the order sheet shows goods
 * going to. Four rows beside eighty-six, two counts, and nothing on the screen
 * saying how they differed. A reader's first thought was that they were the
 * same list twice, which is the point at which a screen has stopped answering.
 *
 * One list now, and what was the second panel becomes the WORKLIST inside it:
 * a shop the sheet has seen and nobody has recorded is exactly the row
 * somebody should act on, so it sits among the recorded ones saying "from the
 * order sheet" with the button that records it. The list moves into its
 * recorded half as the work is done.
 *
 * `direction` is the only thing that differs between the two ends of the same
 * relationship — one component, because two would drift into two vocabularies
 * for one arrangement.
 */
export function DeliveryRelations({
  anchorId,
  anchorName,
  relations,
  canEdit,
  direction,
  /** Only meaningful on a shop: it must keep at least one distributor. */
  isThirdParty,
}: {
  anchorId: string;
  anchorName: string;
  relations: Relation[];
  canEdit: boolean;
  direction: "distributors" | "addresses";
  isThirdParty: boolean;
}) {
  const router = useRouter();
  const { run: toasted } = useToast();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Relation | null>(null);
  const [removing, setRemoving] = React.useState<Relation | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function run<T>(work: Promise<Result<T>>, key: string): Promise<boolean> {
    setBusy(key);
    try {
      const result = await toasted(work);
      if (result.ok) router.refresh();
      return result.ok;
    } finally {
      setBusy(null);
    }
  }

  const isShopSide = direction === "distributors";
  const recordedCount = relations.filter((r) => r.recorded).length;
  const onlyRecorded = recordedCount === 1;

  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-5 py-3.5">
        <span className="text-lg leading-6 font-semibold text-ink">
          {isShopSide ? "Distributors" : "Delivery addresses"}
        </span>
        <span className="flex items-center gap-3">
          {/* The recorded half is named in the count, because that is the half
              somebody is responsible for. "86" alone reads as 86 decisions. */}
          <span className="text-[13px] text-muted">
            {relations.length === 0
              ? "none"
              : `${relations.length} · ${recordedCount} recorded`}
          </span>
          {canEdit && isShopSide ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Add distributor
            </Button>
          ) : null}
        </span>
      </div>

      {relations.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          {isShopSide
            ? isThirdParty
              ? "Nobody is recorded as billing this shop. It was converted before distributors were recorded — name who bills it."
              : "Nothing is delivered here on somebody else's bill."
            : "No goods on this account's bills have gone anywhere else."}
        </p>
      ) : (
        // A fixed height that scrolls inside itself, like every panel here: a
        // distributor with eighty-six delivery addresses must not be the
        // customer whose record you can read the least of.
        <div className="max-h-[420px] overflow-y-auto px-5 py-3">
          {relations.map((r) => (
            <div
              key={r.linkId ?? r.customerId}
              className="flex items-start justify-between gap-3 border-b border-divider py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="text-sm text-ink">
                  <Link
                    href={`/crm/customers/${r.customerId}`}
                    className="text-ink no-underline hover:underline"
                  >
                    {r.name}
                  </Link>
                  {r.isPrimary ? (
                    <span className="ml-2">
                      <Badge tone="brand">
                        {isShopSide ? "Usual" : "We are the usual distributor"}
                      </Badge>
                    </span>
                  ) : null}
                  {/* The one distinction the whole panel exists to draw. */}
                  {r.recorded ? null : (
                    <span
                      className="ml-2"
                      title="The order sheet shows goods going here. Nobody has recorded the arrangement."
                    >
                      <Badge tone="muted">From the order sheet</Badge>
                    </span>
                  )}
                  {isShopSide && r.recorded && !r.stillDirect ? (
                    <span
                      className="ml-2"
                      title="This account is no longer one we bill, so the arrangement needs looking at."
                    >
                      <Badge tone="warn">Not a direct customer now</Badge>
                    </span>
                  ) : null}
                </div>
                <div className="text-[12px] text-muted">
                  {r.city ? `${r.city} · ` : ""}
                  {r.orders > 0
                    ? `${r.orders} deliver${r.orders === 1 ? "y" : "ies"}${
                        r.lastAt ? `, last ${shortDate(r.lastAt)}` : ""
                      }`
                    : "no deliveries recorded yet"}
                </div>
                {r.note ? (
                  <div className="mt-0.5 text-[12px] text-body">{r.note}</div>
                ) : null}
              </div>
              {canEdit ? (
                <div className="flex shrink-0 gap-2">
                  {r.recorded ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditing(r)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy !== null || (isShopSide && isThirdParty && onlyRecorded)}
                        title={
                          isShopSide && isThirdParty && onlyRecorded
                            ? "A third-party customer has to have somebody billing it. Add another distributor first, or stop treating this account as a third-party customer."
                            : undefined
                        }
                        onClick={() => setRemoving(r)}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    // One tap, on the row that reports the evidence. The
                    // alternative is reading the name, opening another screen,
                    // searching for it and picking the account you were
                    // already looking at.
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(
                          isShopSide
                            ? recordDeliveryAddress({
                                distributorId: r.customerId,
                                shopId: anchorId,
                              })
                            : recordDeliveryAddress({
                                distributorId: anchorId,
                                shopId: r.customerId,
                              }),
                          r.customerId,
                        )
                      }
                    >
                      {busy === r.customerId ? "Recording…" : "Record"}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <LinkDialog
        open={adding}
        title={`Add a distributor for ${anchorName}`}
        customerId={anchorId}
        exclude={relations.filter((r) => r.recorded).map((r) => r.customerId)}
        onClose={() => setAdding(false)}
        onSave={async ({ distributorId, isPrimary, note }) =>
          run(
            addDistributor({ customerId: anchorId, distributorId, isPrimary, note }),
            "add",
          )
        }
      />

      <LinkDialog
        // Keyed, so opening it on a second row starts from that row's values.
        key={editing?.linkId ?? "none"}
        open={Boolean(editing)}
        title={`Edit ${editing?.name ?? ""}`}
        customerId={anchorId}
        exclude={relations
          .filter((r) => r.recorded && r.linkId !== editing?.linkId)
          .map((r) => r.customerId)}
        initial={
          editing
            ? {
                distributorId: editing.customerId,
                distributorName: editing.name,
                isPrimary: editing.isPrimary,
                note: editing.note ?? "",
              }
            : undefined
        }
        // Only the shop side may swap WHO the arrangement is with: from the
        // distributor's end the other account is the shop, and swapping it
        // would move a delivery address onto a different shop by editing a row
        // on a third account's page.
        allowSwap={isShopSide}
        onClose={() => setEditing(null)}
        onSave={async ({ distributorId, isPrimary, note }) => {
          if (!editing?.linkId) return false;
          return run(
            updateDistributor({
              linkId: editing.linkId,
              ...(isShopSide && distributorId !== editing.customerId
                ? { distributorId }
                : {}),
              isPrimary,
              note: note.trim() ? note.trim() : null,
            }),
            "edit",
          );
        }}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this arrangement?"
        body={
          removing
            ? isShopSide
              ? `${removing.name} will no longer be recorded as billing ${anchorName}. Orders already delivered here on their bill are untouched, and the row stays in this list as something the order sheet has seen.`
              : `${removing.name} will no longer be recorded as a delivery address for ${anchorName}. Orders already delivered there are untouched.`
            : ""
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (removing?.linkId) await run(removeDistributor(removing.linkId), "remove");
        }}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

/**
 * Add and Edit are ONE dialog, because they ask the same three questions —
 * which distributor, are they the usual one, and what should the next person
 * know.
 */
function LinkDialog({
  open,
  title,
  customerId,
  exclude,
  initial,
  allowSwap = true,
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
  allowSwap?: boolean;
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
          {allowSwap ? (
            <Button variant="secondary" size="sm" onClick={() => setPicked(null)}>
              Change
            </Button>
          ) : null}
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
