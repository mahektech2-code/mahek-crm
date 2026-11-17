"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Input, Select } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { useToast } from "@/components/ui/toast";
import { restoreLeads } from "@/lib/actions/lead-trash";
import { APP_TIMEZONE, addDays, type BusinessDate } from "@/lib/business-date";
import { phoneDisplay, shortDate, stamp, stampDate } from "@/lib/format";
import { Card, Pill, btnClass } from "./_shell/kit";
import type { TrashRow, TrashSort } from "@/lib/services/lead-trash-service";

/* ---------------------------------------------------------------------------
 * THE TRASH — every deleted lead, and the one place one comes back from.
 *
 * A lead deleted in Lead Management is off every screen in the building; this
 * lists them, newest first, filtered, searched and paged in the database, and
 * restores them — one, a selection, or a whole page — exactly as they were,
 * history and all. Administrators only: the API refuses everybody else, and so
 * does the restore.
 *
 * The filters ride on the address (`?tq=&tby=&tfrom=&tto=&tsort=&tpage=&tper=`), so a
 * filtered trash is a link one administrator can send another, and a reload
 * lands where it was.
 * ------------------------------------------------------------------------- */

type Page = {
  rows: TrashRow[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  deleters: Array<{ id: string; name: string; count: number }>;
};

type Filters = { q: string; by: string; from: string; to: string; sort: TrashSort; page: number; per: number };

const SORT_LABEL: Record<TrashSort, string> = {
  deleted_desc: "Deleted — newest first",
  deleted_asc: "Deleted — oldest first",
  name_asc: "Name — A to Z",
  created_desc: "Lead created — newest first",
};

/** The filters as the address states them, from the server. */
export type TrashFilters = { q: string; by: string; from: string; to: string; sort: string; page: number; per: number };

function cleanFilters(f: TrashFilters): Filters {
  return {
    q: f.q,
    by: f.by,
    from: /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : "",
    to: /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : "",
    sort: f.sort in SORT_LABEL ? (f.sort as TrashSort) : "deleted_desc",
    page: Math.max(1, Math.floor(f.page) || 1),
    per: [25, 50, 100].includes(f.per) ? f.per : 25,
  };
}

/** The API's own parameter names. */
function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.by) p.set("by", f.by);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "deleted_desc") p.set("sort", f.sort);
  if (f.page > 1) p.set("page", String(f.page));
  if (f.per !== 25) p.set("per", String(f.per));
  return p.toString();
}

/**
 * The same filters in the console's address, under names of their own: the
 * console already reads `q` and `page` for the catalogue's list, and the two
 * must not steer each other.
 */
function toAddress(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(toQuery(f))) p.set(`t${k}`, v);
  return p.toString();
}

export function TrashSection({ initial, today }: { initial: TrashFilters; today: string }) {
  const { push } = useToast();
  const [filters, setFilters] = React.useState<Filters>(() => cleanFilters(initial));
  const [typed, setTyped] = React.useState(filters.q);
  const [data, setData] = React.useState<Page | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [confirm, setConfirm] = React.useState<string[] | null>(null);
  const [history, setHistory] = React.useState<Record<string, HistoryRow[] | "loading">>({});
  const [reload, setReload] = React.useState(0);

  const patch = (next: Partial<Filters>) =>
    setFilters((f) => ({ ...f, ...next, page: "page" in next ? (next.page ?? 1) : 1 }));

  // The search box settles before it asks.
  React.useEffect(() => {
    if (typed === filters.q) return;
    const t = setTimeout(() => patch({ q: typed.trim() }), 300);
    return () => clearTimeout(t);
  }, [typed, filters.q]);

  // One read per change of filters, and the address follows.
  React.useEffect(() => {
    const query = toQuery(filters);
    const address = toAddress(filters);
    try {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${address ? `?${address}` : ""}`);
    } catch {
      /* Not worth failing over. */
    }
    const controller = new AbortController();
    fetch(`/api/admin/lead-trash?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "The trash could not be read.");
        return res.json() as Promise<Page>;
      })
      .then((page) => {
        setData(page);
        setFailed(null);
        // A selection is of rows on screen; a new page is a new set.
        setPicked(new Set());
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setFailed((e as Error).message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [filters, reload]);

  const rows = data?.rows ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const narrowed = Boolean(filters.q || filters.by || filters.from || filters.to);

  const toggleHistory = (id: string) => {
    if (history[id]) {
      setHistory((h) => {
        const next = { ...h };
        delete next[id];
        return next;
      });
      return;
    }
    setHistory((h) => ({ ...h, [id]: "loading" }));
    fetch(`/api/admin/lead-trash/history?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<HistoryRow[]>) : []))
      .then((h) => setHistory((all) => ({ ...all, [id]: h })))
      .catch(() => setHistory((all) => ({ ...all, [id]: [] })));
  };

  /* The title row's slot, found once the page is in the document. */
  const slot = React.useSyncExternalStore(
    noSubscribe,
    () => document.getElementById(BIN_ACTIONS_SLOT),
    () => null,
  );
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const filterCount = [filters.by, filters.from, filters.to, filters.sort !== "deleted_desc" ? "s" : ""].filter(Boolean).length;

  const header = (
    <>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        aria-label="Find"
        placeholder="Name, number, who deleted"
        className="h-[38px] w-[260px] rounded-control border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
      />
      <div className="relative">
        <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} className={`${btnClass("plain")} h-[38px]`}>
          Filters
          {filterCount ? <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">{filterCount}</span> : null}
        </button>
        {filtersOpen ? (
          <div className="absolute top-[44px] right-0 z-30 flex w-[280px] flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-pop">
            <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
              Deleted by
              <Select value={filters.by} onChange={(e) => patch({ by: e.target.value })} className="h-9">
                <option value="">Anybody</option>
                {(data?.deleters ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.count}
                  </option>
                ))}
              </Select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
                From
                <Input type="date" value={filters.from} onChange={(e) => patch({ from: e.target.value })} className="h-9" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
                To
                <Input type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} className="h-9" />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
              Sort
              <Select value={filters.sort} onChange={(e) => patch({ sort: e.target.value as TrashSort })} className="h-9">
                {(Object.keys(SORT_LABEL) as TrashSort[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex items-center gap-2">
              {narrowed || filters.sort !== "deleted_desc" ? (
                <button
                  type="button"
                  onClick={() => {
                    setTyped("");
                    patch({ q: "", by: "", from: "", to: "", sort: "deleted_desc" });
                  }}
                  className="cursor-pointer text-[13px] font-semibold text-brand"
                >
                  Clear filters
                </button>
              ) : null}
              <span className="flex-1" />
              <button type="button" onClick={() => setFiltersOpen(false)} className={btnClass("plain", "sm")}>
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );

  const HEAD: React.CSSProperties = { fontSize: 12, fontWeight: 600, letterSpacing: 0 };
  const head = "bg-ink px-3.5 py-2.5 text-left whitespace-nowrap text-white normal-case";
  const cell = "h-12 border-b border-divider px-3.5 py-0 align-middle text-sm";

  return (
    <>
      {slot ? createPortal(header, slot) : null}

      {picked.size ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-brand bg-brand-soft px-4 py-2.5">
          <span className="text-[13px] font-semibold text-ink">{picked.size} selected</span>
          <button type="button" onClick={() => setPicked(new Set())} className="cursor-pointer text-[13px] text-muted underline">
            Clear
          </button>
          <span className="flex-1" />
          <button type="button" className={`${btnClass("primary", "sm")} h-8`} onClick={() => setConfirm([...picked])}>
            Restore {picked.size === 1 ? "it" : `all ${picked.size}`}
          </button>
        </div>
      ) : null}

      <Card>
        {failed ? (
          <div className="px-5 py-8 text-center text-[13px] text-danger">{failed}</div>
        ) : loading && !data ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted">Opening the bin…</div>
        ) : rows.length === 0 ? (
          <p className="m-0 px-[18px] py-6 text-muted">
            {narrowed ? "Nothing in the bin matches. Try a wider date range or a shorter search." : "No deleted leads. A lead deleted in Lead Management is held here, ready to restore."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={head} style={{ ...HEAD, width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label="Select every lead on this page"
                      checked={allOnPage}
                      onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      className="m-0 h-4 w-4 accent-brand"
                    />
                  </th>
                  {["Lead", "Mobile", "Owner", "Deleted by", "When", "Reason", ""].map((h, i) => (
                    <th key={i} className={head} style={HEAD}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const h = history[r.id];
                  return (
                    <React.Fragment key={r.id}>
                      <tr className="last:[&>td]:border-b-0">
                        <td className={cell}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.name}`}
                            checked={picked.has(r.id)}
                            onChange={(e) =>
                              setPicked((p) => {
                                const next = new Set(p);
                                if (e.target.checked) next.add(r.id);
                                else next.delete(r.id);
                                return next;
                              })
                            }
                            className="m-0 h-4 w-4 accent-brand"
                          />
                        </td>
                        <td className={cell}>
                          <span className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => toggleHistory(r.id)}
                              title={`${h ? "Hide" : "Show"} its history — ${r.calls} ${r.calls === 1 ? "call" : "calls"} come back with it`}
                              className="cursor-pointer text-left font-semibold text-ink hover:text-brand"
                            >
                              {r.name}
                            </button>
                            {r.previousTrashings ? <Pill tone="warn">Deleted {r.previousTrashings + 1}×</Pill> : null}
                          </span>
                        </td>
                        <td className={cell}>{r.phone ? phoneDisplay(r.phone) : <span className="text-muted">—</span>}</td>
                        <td className={cell}>{r.ownerName ? r.ownerName.split(/\s+/)[0] : <span className="text-muted">Unassigned</span>}</td>
                        <td className={cell}>{r.deletedByName ? r.deletedByName.split(/\s+/)[0] : "—"}</td>
                        <td className={cell} title={stamp(r.deletedAt)}>
                          {dayWord(r.deletedAt, today)}
                        </td>
                        <td className={cell}>{r.reason ?? <span className="text-muted">—</span>}</td>
                        <td className={cell} align="right">
                          <button type="button" className={`${btnClass("plain", "sm")} h-8`} onClick={() => setConfirm([r.id])}>
                            Restore
                          </button>
                        </td>
                      </tr>
                      {h ? (
                        <tr className="bg-canvas">
                          <td colSpan={8} className="border-b border-divider px-12 py-2.5">
                            {h === "loading" ? (
                              <span className="text-[13px] text-muted">Reading…</span>
                            ) : h.length === 0 ? (
                              <span className="text-[13px] text-muted">No recorded moves.</span>
                            ) : (
                              <ol className="m-0 space-y-1 p-0">
                                {h.map((e) => (
                                  <li key={e.id} className="list-none text-[13px] text-body">
                                    <span className="font-medium text-ink">{e.action === "trashed" ? "Deleted" : "Restored"}</span> {stamp(e.at)} by{" "}
                                    {e.actorName ?? "—"}
                                    {e.reason ? <span className="text-muted"> — “{e.reason}”</span> : null}
                                  </li>
                                ))}
                              </ol>
                            )}
                            <div className="mt-1 text-[12px] text-muted">
                              {r.calls} {r.calls === 1 ? "call" : "calls"} · created {stampDate(r.createdAt)}
                              {r.city ? ` · ${r.city}` : ""}
                              {r.leadStage ? ` · ${r.leadStage.replace(/_/g, " ")}` : ""}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > data.perPage ? (
          <Pager
            total={data.total}
            page={data.page}
            perPage={data.perPage}
            onPage={(p) => patch({ page: p })}
            onPerPage={(n) => patch({ per: n })}
          />
        ) : null}
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm && confirm.length > 1 ? `Restore ${confirm.length} leads` : "Restore this lead"}
        body={
          <span>
            {confirm && confirm.length > 1 ? "They go" : "It goes"} back to{" "}
            {confirm && confirm.length > 1 ? "their owners'" : "its owner's"} lists exactly as before
            — same stage, every call and note — and back onto the salesmen&rsquo;s phones on their next sync.
          </span>
        }
        confirmLabel="Restore"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          const r = await restoreLeads({ ids: confirm });
          push(r.ok ? (r.message ?? "Restored.") : r.error, r.ok ? "info" : "error");
          if (r.ok) setReload((n) => n + 1);
        }}
      />
    </>
  );
}

const noSubscribe = () => () => {};

/** The slot in the page's title row the search and Filters are drawn into. */
export const BIN_ACTIONS_SLOT = "bin-actions";

/** Today, Yesterday, or the day — read in IST against the server's business date. */
function dayWord(iso: string, today: string): string {
  const day = new Date(iso).toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE });
  if (day === today) return "Today";
  if (day === addDays(today as BusinessDate, -1)) return "Yesterday";
  return shortDate(iso);
}

type HistoryRow = { id: string; action: "trashed" | "restored"; reason: string | null; actorName: string | null; at: string };
