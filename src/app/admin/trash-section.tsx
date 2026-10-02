"use client";

import * as React from "react";
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Input, Select, Td, Th } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { useToast } from "@/components/ui/toast";
import { restoreLeads } from "@/lib/actions/lead-trash";
import { phoneDisplay, stamp, stampDate } from "@/lib/format";
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

export function TrashSection({ initial }: { initial: TrashFilters }) {
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

  return (
    <div className="mt-5 flex flex-col gap-4">
      <Callout tone="brand">
        <div>
          Leads deleted in Lead Management land here. While they are in the trash they are on no
          screen — not the lists, the calling queue, search, reports or the salesmen&rsquo;s phones.
          Restoring brings a lead back exactly as it was: same owner, same stage, every call and note.
        </div>
      </Callout>

      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="flex flex-wrap items-end gap-2.5 border-b border-line px-4 py-3">
          <div className="w-[260px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Search</div>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Name, contact, city, phone or reason"
              className="h-8"
            />
          </div>
          <div className="w-[200px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Deleted by</div>
            <Select value={filters.by} onChange={(e) => patch({ by: e.target.value })} className="h-8">
              <option value="">Anybody</option>
              {(data?.deleters ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.count}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-[150px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Deleted from</div>
            <Input type="date" value={filters.from} onChange={(e) => patch({ from: e.target.value })} className="h-8" />
          </div>
          <div className="w-[150px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Deleted to</div>
            <Input type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} className="h-8" />
          </div>
          <div className="w-[210px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Sort</div>
            <Select value={filters.sort} onChange={(e) => patch({ sort: e.target.value as TrashSort })} className="h-8">
              {(Object.keys(SORT_LABEL) as TrashSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </Select>
          </div>
          {narrowed ? (
            <button
              onClick={() => {
                setTyped("");
                patch({ q: "", by: "", from: "", to: "" });
              }}
              className="h-8 cursor-pointer px-2 text-[13px] text-brand"
            >
              Clear filters
            </button>
          ) : null}
          <span className="flex-1" />
          <span className="pb-1.5 text-[13px] text-muted">
            {data ? `${data.total.toLocaleString("en-IN")} ${data.total === 1 ? "lead" : "leads"} in the trash${narrowed ? " match" : ""}` : ""}
          </span>
        </div>

        {picked.size ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-brand-soft px-4 py-2.5">
            <span className="text-[13px] font-medium text-ink">
              {picked.size} selected
            </span>
            <button onClick={() => setPicked(new Set())} className="cursor-pointer text-[13px] text-muted underline">
              Clear
            </button>
            <span className="flex-1" />
            <Button size="sm" variant="primary" onClick={() => setConfirm([...picked])}>
              Restore {picked.size === 1 ? "it" : `all ${picked.size}`}
            </Button>
          </div>
        ) : null}

        {failed ? (
          <div className="px-5 py-8 text-center text-[13px] text-danger">{failed}</div>
        ) : loading && !data ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted">Opening the trash…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={narrowed ? "Nothing in the trash matches" : "The trash is empty"}
            body={
              narrowed
                ? "Try a wider date range or a shorter search."
                : "Leads deleted from Lead Management will be listed here, ready to restore."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th className="w-9">
                    <Checkbox
                      label=""
                      aria-label="Select every lead on this page"
                      checked={allOnPage}
                      onChange={(e) =>
                        setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                    />
                  </Th>
                  <Th>Lead</Th>
                  <Th>City</Th>
                  <Th>Owner</Th>
                  <Th>Stage</Th>
                  <Th>Deleted</Th>
                  <Th>Why</Th>
                  <Th align="right">Comes back with</Th>
                  <Th align="right"> </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const h = history[r.id];
                  return (
                    <React.Fragment key={r.id}>
                      <tr className="hover:bg-canvas">
                        <Td>
                          <Checkbox
                            label=""
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
                          />
                        </Td>
                        <Td>
                          <div className="text-sm font-medium text-ink">{r.name}</div>
                          <div className="text-[12px] text-muted">
                            {[r.contactPerson, r.phone ? phoneDisplay(r.phone) : null].filter(Boolean).join(" · ") || "—"}
                          </div>
                        </Td>
                        <Td className="text-[13px] text-body">{r.city ?? "—"}</Td>
                        <Td className="text-[13px] text-body">{r.ownerName ?? "Unassigned"}</Td>
                        <Td className="text-[13px] text-body">
                          {r.leadStage ? r.leadStage.replace(/_/g, " ") : "—"}
                          {r.leadSalesType ? (
                            <div className="text-[11px] text-muted">{r.leadSalesType.replace(/_/g, " ")}</div>
                          ) : null}
                        </Td>
                        <Td>
                          <div className="text-[13px] text-ink">{stamp(r.deletedAt)}</div>
                          <div className="text-[12px] text-muted">by {r.deletedByName ?? "—"}</div>
                        </Td>
                        <Td className="max-w-[280px] text-[13px] whitespace-normal text-body">{r.reason ?? "—"}</Td>
                        <Td align="right" className="text-[12px] text-muted">
                          <div>{r.calls} {r.calls === 1 ? "call" : "calls"} · created {stampDate(r.createdAt)}</div>
                          {r.previousTrashings ? (
                            <Badge tone="warn">Deleted {r.previousTrashings + 1}×</Badge>
                          ) : null}
                        </Td>
                        <Td align="right">
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="secondary" onClick={() => toggleHistory(r.id)}>
                              {h ? "Hide history" : "History"}
                            </Button>
                            <Button size="sm" variant="primary" onClick={() => setConfirm([r.id])}>
                              Restore
                            </Button>
                          </div>
                        </Td>
                      </tr>
                      {h ? (
                        <tr className="bg-canvas">
                          <td colSpan={9} className="border-b border-divider px-12 py-2.5">
                            {h === "loading" ? (
                              <span className="text-[13px] text-muted">Reading…</span>
                            ) : h.length === 0 ? (
                              <span className="text-[13px] text-muted">No recorded moves.</span>
                            ) : (
                              <ol className="space-y-1">
                                {h.map((e) => (
                                  <li key={e.id} className="text-[13px] text-body">
                                    <span className="font-medium text-ink">
                                      {e.action === "trashed" ? "Deleted" : "Restored"}
                                    </span>{" "}
                                    {stamp(e.at)} by {e.actorName ?? "—"}
                                    {e.reason ? <span className="text-muted"> — “{e.reason}”</span> : null}
                                  </li>
                                ))}
                              </ol>
                            )}
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

        {data && data.total > 0 ? (
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
    </div>
  );
}

type HistoryRow = { id: string; action: "trashed" | "restored"; reason: string | null; actorName: string | null; at: string };
