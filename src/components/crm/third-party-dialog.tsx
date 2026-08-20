"use client";

import * as React from "react";
import { Badge, Button, Input } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import {
  DistributorPicker,
  type DistributorCandidate,
} from "./distributor-picker";

/** One chosen distributor, as the dialog holds it before anything is saved. */
export type ChosenDistributor = {
  id: string;
  name: string;
  city: string;
  isPrimary: boolean;
  note: string;
};

/**
 * Converting to a third-party customer, which is TWO facts and not a tick.
 *
 * The mark says this shop does not bill with us; without saying who does, it
 * takes an account off the calling list and leaves nobody to ask about it. So
 * the dialog will not save until at least one distributor is named, and the
 * action refuses the same thing — this is the screen half of a rule, not the
 * rule itself.
 *
 * ONE SET OF DISTRIBUTORS FOR THE WHOLE SELECTION when several shops are
 * converted at once. That is the ordinary case: a row of shops on one route is
 * served by one distributor, which is exactly why they arrived on the same
 * screen together. Where it is not true, the record page's own panel is where
 * each shop's arrangement is corrected.
 *
 * The suggestions are the ORDER HISTORY talking, never a default. Where the
 * sheet already shows goods going to this shop on somebody's bill, that
 * somebody is offered as one tap — and it is still a tap. A suggestion that
 * wrote itself would be the spreadsheet deciding what a record is, which is
 * the thing this whole subsystem was built to undo.
 */
export function ThirdPartyDialog({
  open,
  onClose,
  onConfirm,
  /** The shops being converted, for the sentence at the top. */
  names,
  /** Only meaningful for one shop: who its order history suggests. */
  suggestions = [],
  excludeCustomerId,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (distributors: ChosenDistributor[]) => Promise<boolean>;
  names: string[];
  suggestions?: Array<{ id: string; name: string; orders: number }>;
  excludeCustomerId?: string;
  busy?: boolean;
}) {
  const [chosen, setChosen] = React.useState<ChosenDistributor[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  function add(c: DistributorCandidate | { id: string; name: string; city?: string }) {
    setError(null);
    setChosen((prev) =>
      prev.some((p) => p.id === c.id)
        ? prev
        : [
            ...prev,
            {
              id: c.id,
              name: c.name,
              city: "city" in c && c.city ? c.city : "",
              // The first one named is the usual one until somebody says
              // otherwise. A single distributor that is not marked as the
              // usual one is a distinction without a difference.
              isPrimary: prev.length === 0,
              note: "",
            },
          ],
    );
  }

  function drop(id: string) {
    setChosen((prev) => {
      const next = prev.filter((p) => p.id !== id);
      // The badge cannot be left on a row that is gone, and the remaining one
      // is the answer to who serves this shop usually.
      if (next.length && !next.some((n) => n.isPrimary)) next[0].isPrimary = true;
      return next;
    });
  }

  function setPrimary(id: string) {
    setChosen((prev) => prev.map((p) => ({ ...p, isPrimary: p.id === id })));
  }

  async function save() {
    if (!chosen.length) {
      setError(
        "Name at least one distributor. A third-party customer is a shop somebody else bills, and this is where we say who.",
      );
      return;
    }
    setSaving(true);
    try {
      const done = await onConfirm(chosen);
      if (done) {
        setChosen([]);
        setError(null);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  const many = names.length > 1;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title={
        many
          ? `Convert ${names.length} leads to third-party customers`
          : `Convert ${names[0] ?? "this lead"} to a third-party customer`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={saving || busy || !chosen.length}
            title={
              chosen.length
                ? undefined
                : "Name at least one distributor first"
            }
          >
            {saving || busy ? "Converting…" : "Convert"}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-[22px] text-body">
        A third-party customer is a shop we deliver to and do not bill.{" "}
        {many ? "These accounts" : "This account"} will stop being chased for a
        first order, and{many ? " their" : " its"} history, orders and
        complaints stay exactly as they are.
      </p>
      {many ? (
        <p className="mt-2 text-[13px] text-muted">
          {names.slice(0, 6).join(", ")}
          {names.length > 6 ? ` and ${names.length - 6} more` : ""} — the
          distributors below are recorded against every one of them.
        </p>
      ) : null}

      {suggestions.length ? (
        <div className="mt-4">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            From the order history
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => add(s)}
                disabled={chosen.some((c) => c.id === s.id)}
                className="rounded-[4px] border border-line-strong px-2.5 py-1 text-[13px] text-body hover:bg-canvas disabled:opacity-45"
              >
                {s.name}
                <span className="ml-1.5 text-muted">
                  {s.orders} deliver{s.orders === 1 ? "y" : "ies"}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] text-muted">
            Goods have gone to this shop on these accounts&apos; bills. It is
            evidence, not the answer — nothing is recorded until you pick one.
          </p>
        </div>
      ) : null}

      {/* Not a `Field`: that renders a <label>, and a label wrapping a list of
          buttons hands every click on a result back to the search box. */}
      <div className="mt-4">
        <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Distributors
        </div>
        <DistributorPicker
          excludeCustomerId={excludeCustomerId}
          exclude={chosen.map((c) => c.id)}
          onPick={add}
        />
        <p className="mt-1 text-[13px] text-muted">
          Who buys from us and bills this shop. At least one, and a distributor
          is always an account we invoice directly.
        </p>
      </div>

      {chosen.length ? (
        <div className="mt-3 rounded-[4px] border border-line">
          {chosen.map((c) => (
            <div
              key={c.id}
              className="border-b border-divider px-3 py-2.5 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink">
                    {c.name}
                    {c.isPrimary ? (
                      <span className="ml-2">
                        <Badge tone="brand">Usual</Badge>
                      </span>
                    ) : null}
                  </div>
                  {c.city ? (
                    <div className="text-[12px] text-muted">{c.city}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {c.isPrimary ? null : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setPrimary(c.id)}
                      title="The distributor who serves this shop usually"
                    >
                      Make usual
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => drop(c.id)}>
                    Remove
                  </Button>
                </div>
              </div>
              <Input
                value={c.note}
                placeholder="Note — the route, the rate, anything the next person needs (optional)"
                onChange={(e) =>
                  setChosen((prev) =>
                    prev.map((p) =>
                      p.id === c.id ? { ...p, note: e.target.value } : p,
                    ),
                  )
                }
                className="mt-2"
              />
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
