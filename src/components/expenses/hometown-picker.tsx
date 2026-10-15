"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Pill } from "@/components/console/parts";
import { setSalesmanHometowns } from "@/lib/actions/sales";
import { setExpenseHometowns } from "@/lib/actions/expense-policy-sets";
import type { HometownState } from "@/lib/services/hometown-service";

/* ---------------------------------------------------------------------------
 * WHERE HE LIVES, picked — never typed. One town or several.
 *
 * One control for both doors: the Sales Dashboard's Salesmen screen and the
 * Admin Console's "Who is on which". The pay rule compares his hometowns with
 * the towns of the shops he visits, and those towns come from the reviewed
 * place tree, so the picker offers that tree and nothing else: a state, then
 * its towns, ticked. A typed "nagpur city" would be a town no shop is in, and
 * every day of his would read as a day away.
 *
 * He may have SEVERAL — he lives in one town and his family in another, or two
 * towns run into each other — and a day in any of them is a day at home. The
 * ticks are kept across states, so a hometown in each of two states is one
 * save. What is saved is the whole set: unticking a town takes it off.
 *
 * Each door saves through its own action, which asks its own question — the
 * Salesmen screen and the team, or the expense-policy capability — and both
 * land in the one writer, `writeHometowns`.
 * ------------------------------------------------------------------------- */

export type HometownValue = {
  city: string;
  state: string | null;
  /** Null on a town typed before the picker existed. */
  placeId: string | null;
};

const SEARCH_ABOVE = 10;
const count = (n: number) => n.toLocaleString("en-IN");
const said = (h: { city: string; state: string | null }) =>
  h.state ? `${h.city}, ${h.state}` : h.city;

export function HometownPicker({
  salesman,
  hometowns,
  tree,
  door,
  canWrite = true,
  refuse,
  compact = false,
}: {
  salesman: { id: string; name: string };
  hometowns: HometownValue[];
  tree: HometownState[];
  /** Which screen this is on, which decides which action — and which permission — saves it. */
  door: "sales" | "admin";
  canWrite?: boolean;
  /** Why it cannot be changed, when it cannot. */
  refuse?: string;
  /** A table cell: the towns on one line and a small button. */
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [stateId, setStateId] = React.useState<string | null>(null);
  /** Ticked towns, by place id, in the order they were ticked. */
  const [picked, setPicked] = React.useState<string[]>([]);
  /** Typed towns still kept, by name. */
  const [typedKept, setTypedKept] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /** Every town in the tree, by id, with the state it sits in. */
  const towns = React.useMemo(() => {
    const m = new Map<string, { name: string; state: string; stateId: string }>();
    for (const st of tree)
      for (const c of st.cities) m.set(c.id, { name: c.name, state: st.name, stateId: st.id });
    return m;
  }, [tree]);

  const typed = hometowns.filter((h) => !h.placeId);
  const placed = hometowns.filter((h) => h.placeId).map((h) => h.placeId!);

  function begin() {
    const first = placed.map((id) => towns.get(id)).find(Boolean);
    const byName =
      !first && hometowns[0]?.state
        ? tree.find((s) => s.name === hometowns[0].state)
        : null;
    setStateId(
      first?.stateId ?? byName?.id ?? (tree.length === 1 ? tree[0].id : null),
    );
    setPicked(placed);
    setTypedKept(typed.map((t) => t.city));
    setQuery("");
    setError(null);
    setOpen(true);
  }

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function save(placeIds: string[], keepTyped: string[]) {
    setBusy(true);
    setError(null);
    let result;
    try {
      result =
        door === "sales"
          ? await setSalesmanHometowns({ salesmanId: salesman.id, placeIds, keepTyped })
          : await setExpenseHometowns({ userId: salesman.id, placeIds, keepTyped });
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
  const pickedIn = (stId: string) =>
    picked.filter((id) => towns.get(id)?.stateId === stId).length;
  const changed =
    picked.length !== placed.length ||
    picked.some((id) => !placed.includes(id)) ||
    typedKept.length !== typed.length;
  const chosen = [
    ...picked.map((id) => towns.get(id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => t.name),
    ...typedKept,
  ];

  return (
    <>
      <span
        className={
          compact
            ? "flex min-w-0 items-center gap-2"
            : "flex flex-wrap items-center gap-2"
        }
      >
        {hometowns.length > 0 ? (
          compact ? (
            /* The first town gives way to the ellipsis; the count of the rest
               never does, or a second hometown is invisible on the list. */
            <span className="flex min-w-0 items-center gap-1" title={hometowns.map(said).join("; ")}>
              <span className="min-w-0 truncate text-ink">{hometowns[0].city}</span>
              {hometowns.length > 1 ? (
                <span className="shrink-0 text-muted">+{hometowns.length - 1}</span>
              ) : null}
              {typed.length ? (
                <span className="shrink-0">
                  <Pill tone="warn">Typed</Pill>
                </span>
              ) : null}
            </span>
          ) : (
            hometowns.map((h) => (
              <span
                key={`${h.placeId ?? ""}|${h.city}`}
                className="inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-surface px-2 py-0.5 text-[13px]"
                title={h.placeId ? said(h) : "Typed before the picker — pick it from the list"}
              >
                <span className="text-ink">{h.city}</span>
                {h.state ? <span className="text-muted">{h.state}</span> : null}
                {!h.placeId ? <Pill tone="warn">Typed</Pill> : null}
              </span>
            ))
          )
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
          {hometowns.length ? "Change" : "Set"}
        </Button>
      </span>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Where ${salesman.name} lives`}
        width={640}
        footer={
          <div className="flex items-center justify-between gap-4">
            <div>
              {hometowns.length > 0 ? (
                <Button
                  tone="danger"
                  size="sm"
                  onClick={() => void save([], [])}
                  disabled={busy}
                >
                  Clear all
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button tone="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                onClick={() => void save(picked, typedKept)}
                disabled={busy || !changed}
                title={changed ? undefined : "Tick or untick a town first"}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        }
      >
        <p className="text-[13px] text-pretty text-muted">
          Meals are paid only on days away from home. Tick every town he counts
          as home — a day spent in any of them is a day at home. A day is away
          when he visits a shop in a town that is none of them, names one for
          the trip, or stays out overnight. With no hometown set, every day he
          records as away is paid as away.
        </p>

        <Step
          n={0}
          title="His hometowns"
          hint={chosen.length ? `${count(chosen.length)} ticked` : "none yet"}
        />
        {chosen.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">
            Nothing ticked. Saving now clears his hometowns.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {picked.map((id) => {
              const t = towns.get(id);
              if (!t) return null;
              return (
                <Selected
                  key={id}
                  label={t.name}
                  sub={t.state}
                  onRemove={() => toggle(id)}
                />
              );
            })}
            {typedKept.map((name) => (
              <Selected
                key={`typed|${name}`}
                label={name}
                sub="typed"
                warn
                onRemove={() => setTypedKept((k) => k.filter((x) => x !== name))}
              />
            ))}
          </div>
        )}
        {typedKept.length ? (
          <p className="mt-3 rounded-[4px] bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
            {typedKept.map((t) => `“${t}”`).join(", ")}{" "}
            {typedKept.length === 1 ? "was" : "were"} typed before towns were
            picked from the list. Tick {typedKept.length === 1 ? "it" : "them"}{" "}
            below so {typedKept.length === 1 ? "it matches" : "they match"} the
            towns of the shops he visits, then remove the typed one.
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
                  }}
                  label={s.name}
                  badge={pickedIn(s.id) || undefined}
                />
              ))}
            </div>

            <Step
              n={2}
              title="Towns"
              hint={
                state
                  ? `${count(state.cities.length)} in ${state.name} · tick as many as apply`
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
                  role="group"
                  aria-label="Towns"
                >
                  {cities.length === 0 ? (
                    <p className="py-2 text-[12px] text-muted">
                      Nothing in {state.name} matches “{query}”.
                    </p>
                  ) : (
                    cities.map((c) => {
                      const on = picked.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className={
                            "flex cursor-pointer items-center gap-2 rounded-[4px] px-1.5 py-1 " +
                            (on ? "bg-brand-soft" : "hover:bg-canvas")
                          }
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(c.id)}
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
                      );
                    })
                  )}
                </div>
              </>
            )}

            {chosen.length ? (
              <div className="mt-4 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-[13px] text-body">
                {salesman.name} lives in{" "}
                <span className="font-medium text-ink">{listed(chosen)}</span>. A
                day spent only in {chosen.length === 1 ? "it" : "these"} earns no
                meal allowance.
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

/** "Nagpur", "Nagpur and Kamptee", "Nagpur, Kamptee and Wardha". */
function listed(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Selected({
  label,
  sub,
  warn = false,
  onRemove,
}: {
  label: string;
  sub: string;
  warn?: boolean;
  onRemove: () => void;
}) {
  return (
    <span
      className={
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-[4px] border pl-2 pr-1 text-[13px] " +
        (warn ? "border-warn-line bg-warn-soft text-warn-ink" : "border-brand bg-brand-soft text-ink")
      }
    >
      <span className="truncate font-medium">{label}</span>
      <span className="shrink-0 text-[12px] text-muted">{sub}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="flex size-5 shrink-0 items-center justify-center rounded-[3px] text-muted hover:bg-surface hover:text-ink"
      >
        ×
      </button>
    </span>
  );
}

function Step({ n, title, hint }: { n: number; title: string; hint?: string }) {
  /* 0 is the summary above the steps, not a step: it carries a tick. */
  return (
    <div className="mt-5 flex items-baseline gap-2 border-b border-line pb-1.5">
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-white">
        {n === 0 ? "✓" : n}
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
  badge,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  /** How many of its towns are ticked. */
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={
        "inline-flex h-8 max-w-full items-center gap-1.5 rounded-[4px] border px-2.5 text-[13px] " +
        (on
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas")
      }
    >
      <span className="truncate">{label}</span>
      {badge ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#5223E0] px-1 text-[11px] font-medium text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
