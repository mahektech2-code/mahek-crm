"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Pill } from "@/components/console/parts";
import { setSalesmanHometown } from "@/lib/actions/sales";
import { setExpenseHometown } from "@/lib/actions/expense-policy-sets";
import type { HometownState } from "@/lib/services/hometown-service";

/* ---------------------------------------------------------------------------
 * WHERE HE LIVES, picked — never typed.
 *
 * One control for both doors: the Sales Dashboard's Salesmen screen and the
 * Admin Console's "Who is on which". The pay rule compares a hometown with the
 * towns of the shops he visits, and those towns come from the reviewed place
 * tree, so the picker offers that tree and nothing else: a state, then one of
 * its cities. A typed "nagpur city" would be a town no shop is in, and every
 * day of his would read as a day away.
 *
 * Each door saves through its own action, which asks its own question — the
 * Salesmen screen and the team, or the expense-policy capability — and both
 * land in the one writer, `writeHometown`.
 * ------------------------------------------------------------------------- */

export type HometownValue = {
  city: string;
  state: string | null;
  /** Null on a town typed before the picker existed. */
  placeId: string | null;
};

const SEARCH_ABOVE = 10;
const count = (n: number) => n.toLocaleString("en-IN");

export function HometownPicker({
  salesman,
  hometown,
  tree,
  door,
  canWrite = true,
  refuse,
  compact = false,
}: {
  salesman: { id: string; name: string };
  hometown: HometownValue | null;
  tree: HometownState[];
  /** Which screen this is on, which decides which action — and which permission — saves it. */
  door: "sales" | "admin";
  canWrite?: boolean;
  /** Why it cannot be changed, when it cannot. */
  refuse?: string;
  /** A table cell: the town on one line and a small button. */
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [stateId, setStateId] = React.useState<string | null>(null);
  const [placeId, setPlaceId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin() {
    const current = hometown?.placeId ?? null;
    const home = current
      ? tree.find((s) => s.cities.some((c) => c.id === current))
      : null;
    const byName =
      !home && hometown?.state
        ? tree.find((s) => s.name === hometown.state)
        : null;
    setStateId(
      home?.id ?? byName?.id ?? (tree.length === 1 ? tree[0].id : null),
    );
    setPlaceId(current);
    setQuery("");
    setError(null);
    setOpen(true);
  }

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    let result;
    try {
      result =
        door === "sales"
          ? await setSalesmanHometown({
              salesmanId: salesman.id,
              placeId: next,
            })
          : await setExpenseHometown({ userId: salesman.id, placeId: next });
    } catch {
      result = {
        ok: false as const,
        error: "That could not be saved. Try again.",
      };
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

  const state = tree.find((s) => s.id === stateId) ?? null;
  const cities = React.useMemo(() => {
    if (!state) return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.cities;
    return state.cities.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.district ?? "").toLowerCase().includes(q),
    );
  }, [state, query]);
  const chosen = state?.cities.find((c) => c.id === placeId) ?? null;
  const typed = !!hometown && !hometown.placeId;

  return (
    <>
      <span
        className={
          compact
            ? "flex min-w-0 items-center gap-2"
            : "flex flex-wrap items-center gap-2"
        }
      >
        {hometown ? (
          <span
            className="min-w-0 truncate"
            title={
              typed
                ? "Typed before the picker — pick it from the list"
                : [hometown.city, hometown.state].filter(Boolean).join(", ")
            }
          >
            <span className="text-ink">{hometown.city}</span>
            {/* In a table cell the town is the answer; the state rides on the hover. */}
            {hometown.state && !compact ? (
              <span className="text-muted">, {hometown.state}</span>
            ) : null}
            {typed ? (
              <span className="ml-1.5">
                <Pill tone="warn">Typed</Pill>
              </span>
            ) : null}
          </span>
        ) : (
          <span title="With no hometown, every day he records as away is paid as away.">
            <Pill tone="warn">Not set</Pill>
          </span>
        )}
        <Button
          size="sm"
          tone="quiet"
          onClick={begin}
          disabled={!canWrite}
          title={canWrite ? undefined : refuse}
        >
          {hometown ? "Change" : "Set"}
        </Button>
      </span>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Where ${salesman.name} lives`}
        width={600}
        footer={
          <div className="flex items-center justify-between gap-4">
            <div>
              {hometown ? (
                <Button
                  tone="danger"
                  size="sm"
                  onClick={() => void save(null)}
                  disabled={busy}
                >
                  Clear hometown
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button tone="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                onClick={() => void save(placeId)}
                disabled={busy || !chosen}
                title={chosen ? undefined : "Pick a town first"}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        }
      >
        <p className="text-[13px] text-pretty text-muted">
          Meals are paid only on days away from home. A day counts as away when
          he visits a shop in another town, names another town for the trip, or
          stays out overnight. With no hometown set, every day he records as
          away is paid as away.
        </p>
        {typed ? (
          <p className="mt-3 rounded-[4px] bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
            “{hometown?.city}” was typed before towns were picked from the list.
            Pick it below so it matches the towns of the shops he visits.
          </p>
        ) : null}

        {tree.length === 0 ? (
          <p className="mt-4 text-[13px] text-muted">
            The place list is empty, so there is no town to pick yet. Towns come
            from the reviewed places the customer book is filed under.
          </p>
        ) : (
          <>
            <Step n={1} title="State" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tree.map((s) => (
                <Chip
                  key={s.id}
                  on={s.id === stateId}
                  onClick={() => {
                    setStateId(s.id);
                    setQuery("");
                    if (!s.cities.some((c) => c.id === placeId))
                      setPlaceId(null);
                  }}
                  label={s.name}
                />
              ))}
            </div>

            <Step
              n={2}
              title="Town"
              hint={
                state
                  ? `${count(state.cities.length)} in ${state.name}`
                  : undefined
              }
            />
            {!state ? (
              <p className="mt-2 rounded-[4px] border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">
                Pick a state and its towns appear here.
              </p>
            ) : (
              <>
                {state.cities.length > SEARCH_ABOVE ? (
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search towns in ${state.name}`}
                    aria-label="Search towns"
                    className="mt-2 h-8 w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
                  />
                ) : null}
                <div
                  className="mt-2 flex max-h-64 flex-col gap-0.5 overflow-y-auto"
                  role="radiogroup"
                  aria-label="Town"
                >
                  {cities.length === 0 ? (
                    <p className="py-2 text-[12px] text-muted">
                      Nothing in {state.name} matches “{query}”.
                    </p>
                  ) : (
                    cities.map((c) => (
                      <label
                        key={c.id}
                        className={
                          "flex cursor-pointer items-center gap-2 rounded-[4px] px-1.5 py-1 " +
                          (c.id === placeId
                            ? "bg-brand-soft"
                            : "hover:bg-canvas")
                        }
                      >
                        <input
                          type="radio"
                          name={`hometown-${salesman.id}`}
                          checked={c.id === placeId}
                          onChange={() => setPlaceId(c.id)}
                          className="size-3.5 shrink-0 accent-[#5223E0]"
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-body">
                          {c.name}
                          {c.district && c.district !== c.name ? (
                            <span className="text-muted">
                              {" "}
                              · {c.district} district
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[12px] text-muted">
                          {c.shops ? `${count(c.shops)} shops` : ""}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </>
            )}

            {chosen ? (
              <div className="mt-4 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-[13px] text-body">
                {salesman.name} lives in{" "}
                <span className="font-medium text-ink">{chosen.name}</span>,{" "}
                {state?.name}. A day spent only in {chosen.name} earns no meal
                allowance.
              </div>
            ) : null}
          </>
        )}

        {error ? (
          <p className="mt-3 rounded-[4px] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        ) : null}
      </Modal>
    </>
  );
}

function Step({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="mt-5 flex items-baseline gap-2 border-b border-line pb-1.5">
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-white">
        {n}
      </span>
      <span className="text-[13px] font-medium text-ink">{title}</span>
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </div>
  );
}

function Chip({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={
        "inline-flex h-8 max-w-full items-center rounded-[4px] border px-2.5 text-[13px] " +
        (on
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas")
      }
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
