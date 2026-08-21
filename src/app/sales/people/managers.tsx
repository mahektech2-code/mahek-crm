"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Modal } from "@/components/ui/overlays";
import { setManagerTerritories } from "@/lib/actions/sales";
import type { ManagerRow } from "@/lib/services/sales-service";
import { Button, Cell, HeadCell, Pill, Row, Table } from "../parts";

/**
 * Who covers what, and the one screen that sets it.
 *
 * Territories used to be rows somebody typed into the database, which is the
 * same category of problem as the sheet import having no button: on a deploy
 * nobody has shell access to, a permission that can only be granted from a
 * terminal is a permission nobody can grant.
 *
 * **No regions means national**, and the dialog says so rather than leaving an
 * empty list to be interpreted. It is the widest scope there is, so it is
 * stated: an empty box that quietly means "sees everything" is how somebody
 * gets the whole country by unticking the last region without noticing.
 */
export function Managers({
  managers,
  regions,
}: {
  managers: ManagerRow[];
  regions: string[];
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState<ManagerRow | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(m: ManagerRow) {
    setOpen(m);
    setPicked(m.regions ?? []);
    setError(null);
  }

  async function save() {
    if (!open) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setManagerTerritories({ managerId: open.id, regions: picked });
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(null);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  return (
    <>
      <h2 className="mt-8 mb-2 text-[15px] font-semibold text-ink">
        Who covers what
      </h2>
      <p className="mb-3 max-w-[820px] text-[13px] text-pretty text-muted">
        Everybody who holds this console, and the patch each of them sees. A manager with no
        regions sees the whole country — that is the widest scope there is, so it is said in words
        rather than shown as an empty cell.
      </p>

      <Table
        minWidth={860}
        head={
          <>
            <HeadCell width={240}>Manager</HeadCell>
            <HeadCell width={240}>Account</HeadCell>
            <HeadCell>Covers</HeadCell>
            <HeadCell align="right" width={140} />
          </>
        }
      >
        {managers.map((m, i) => (
          <Row key={m.id} striped={i % 2 === 1}>
            <Cell truncate={240}>
              <span className="font-medium text-ink">{m.name}</span>
              {m.active ? null : (
                <span className="ml-2">
                  <Pill>Closed</Pill>
                </span>
              )}
            </Cell>
            <Cell truncate={240} className="text-muted">
              {m.email}
            </Cell>
            <Cell truncate={380}>
              {m.regions?.length ? (
                m.regions.join(", ")
              ) : (
                <span title="No regions set, which means every region — the widest scope there is.">
                  <Pill tone="brand">All of India</Pill>
                </span>
              )}
            </Cell>
            <Cell align="right">
              <Button size="sm" onClick={() => begin(m)}>
                Set the patch
              </Button>
            </Cell>
          </Row>
        ))}
      </Table>

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open ? `What ${open.name} covers` : ""}
        width={520}
      >
        {regions.length === 0 ? (
          <p className="text-[13px] text-muted">
            No customer record names a region yet, so there is nothing to divide up. Regions come
            from <span className="font-mono text-[12px]">customers.territory_region</span> rather
            than a list of their own — a second list would offer regions the book does not use.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {regions.map((r) => {
                const on = picked.includes(r);
                return (
                  <button
                    key={r}
                    onClick={() =>
                      setPicked(on ? picked.filter((x) => x !== r) : [...picked, r])
                    }
                    className={
                      "inline-flex h-8 items-center rounded-[4px] border px-3 text-[13px] " +
                      (on
                        ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                        : "border-line bg-surface text-body hover:bg-canvas")
                    }
                  >
                    {r}
                  </button>
                );
              })}
            </div>

            <p className="mt-3 text-[13px] text-pretty text-muted">
              {picked.length
                ? `They will see ${picked.join(", ")} and nothing else — every figure, list and count in this console narrows to it.`
                : "Nothing picked means they see the whole country. That is the widest scope there is, so make sure it is what you mean."}
            </p>
          </>
        )}

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(null)}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : picked.length ? "Set the patch" : "Give them everything"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
