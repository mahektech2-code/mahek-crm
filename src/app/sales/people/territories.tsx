"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Modal } from "@/components/ui/overlays";
import { setSalesmanTerritories } from "@/lib/actions/sales";
import type { Salesman } from "@/lib/services/sales-service";
import { Button, Pill } from "../parts";

/**
 * Where a salesman WORKS, and the dialog that sets it.
 *
 * **A territory narrows a book. It is not a permission**, and the screen says
 * so, because the two look alike and reading this as access control is how
 * somebody later removes a real check believing it redundant. He sees his own
 * customers and his own leads either way — a territory only decides which of
 * them are in front of him.
 *
 * **Nothing picked means his whole book.** That is the safe default and a
 * deliberate one: allocating cities to eight people and forgetting the ninth
 * must not empty her handset, which is a failure this product already has on
 * record and the one nobody debugs, because it looks like having no work.
 *
 * The places offered are the ones the BOOK uses, read off `customers` rather
 * than kept as a list of their own. A list of its own would offer a city no
 * customer is in, and a territory that matches nothing is a book that goes
 * quietly empty.
 */
export function Territories({
  salesman,
  cities,
  beats,
}: {
  salesman: Salesman;
  cities: string[];
  beats: string[];
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<{ kind: string; value: string }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin() {
    setPicked(salesman.territories ?? []);
    setError(null);
    setOpen(true);
  }

  const has = (kind: string, value: string) =>
    picked.some((p) => p.kind === kind && p.value === value);

  const flip = (kind: string, value: string) =>
    setPicked((current) =>
      has(kind, value)
        ? current.filter((p) => !(p.kind === kind && p.value === value))
        : [...current, { kind, value }],
    );

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setSalesmanTerritories({
        salesmanId: salesman.id,
        territories: picked,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  const chips = (kind: string, values: string[], label: string) =>
    values.length === 0 ? null : (
      <div className="mt-4">
        <p className="mb-2 text-[12px] font-medium tracking-wide text-muted uppercase">
          {label}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => {
            const on = has(kind, v);
            return (
              <button
                key={kind + v}
                onClick={() => flip(kind, v)}
                className={
                  "inline-flex h-8 items-center rounded-[4px] border px-3 text-[13px] " +
                  (on
                    ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                    : "border-line bg-surface text-body hover:bg-canvas")
                }
              >
                {v}
              </button>
            );
          })}
        </div>
      </div>
    );

  return (
    <>
      <Button size="sm" onClick={begin}>
        Where they work
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Where ${salesman.name} works`}
        width={560}
      >
        <p className="text-[13px] text-pretty text-muted">
          This narrows what their handset shows to their own customers and leads in these places.
          It does not give them anybody else&apos;s — who may see a record is decided by whose book
          it is in, and nothing here changes that.
        </p>

        {cities.length === 0 && beats.length === 0 ? (
          <p className="mt-4 text-[13px] text-muted">
            No customer record names a city or a beat yet, so there is nothing to divide up.
            Places come from the book itself rather than a list of their own — a separate list
            would offer somewhere no customer is.
          </p>
        ) : (
          <>
            {chips("city", cities, "Cities")}
            {chips("beat", beats, "Beats")}

            <p className="mt-4 text-[13px] text-pretty text-muted">
              {picked.length
                ? `Their handset will show their own customers and leads in ${picked
                    .map((p) => p.value)
                    .join(", ")}. The rest of their book is still theirs — it is just not on the list.`
                : "Nothing picked means they see their whole book, which is what everybody sees today. That is the safe answer: a salesman with no territory must not open an empty handset."}
            </p>
          </>
        )}

        {error ? (
          <p className="mt-3 rounded-[4px] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button tone="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** The cell that shows it on the team table. */
export function WorksCell({ salesman }: { salesman: Salesman }) {
  const list = salesman.territories ?? [];
  if (!list.length) {
    return (
      <span title="No territory set, so their handset shows their whole book. That is the default and the safe one.">
        <Pill>Their whole book</Pill>
      </span>
    );
  }
  return <>{list.map((t) => t.value).join(", ")}</>;
}
