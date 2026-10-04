"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColSpec, ListRow, ListSpec, Tone } from "@/lib/erp/ui";
import { cellText, inr, nf } from "@/lib/erp/ui";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { Button, Card, cx, EmptyState, MetricStrip, PageHeader, SortableTh, Td, Th, Tr, type Metric } from "@/components/ui/primitives";
import { SelectionBar, Tabs } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { FlagBadge, rowTone, StatusBadge } from "./badge";
import { GodownPicker, type PickItem } from "./godown-picker";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { RecordDrawer } from "./record-drawer";
import { useKit } from "./kit";

/* ---------------------------------------------------------------------------
 * The generic ERP list, drawn the way the CRM draws a list: the page header
 * with its actions, a strip of the counts that matter, then ONE card holding
 * the status tabs, the filter bar, the table and the pager — the Customers and
 * Complaints screens' shape, so a person who knows one knows the other. The
 * ERP's own parts (the godown filter, grouping with group totals and group
 * select, the "from dashboard" filter, the hidden-columns line) sit inside
 * that shape rather than beside it.
 *
 * Rules are the server's: this only filters, sorts and pages what it was sent.
 * ------------------------------------------------------------------------- */

/** More status values than this and they are a dropdown, not a row of tabs. */
const MAX_TABS = 7;

/** A tab of a screen with several lists (`views` in the registry): a link, because each tab is its own server read. */
export type ListTab = {
  key: string;
  label: string;
  href: string;
  active: boolean;
  /** Work waiting on this tab for the person looking — the sidebar badge, per tab. */
  count?: number;
};

/**
 * A screen's tabs. Exported because a screen can have a tab that is not a
 * list (HRMS Settings' rules), and that page draws the same strip so moving
 * between the two does not change the furniture under somebody's thumb.
 */
export function ListTabs({ label, tabs, toggle }: { label: string; tabs: ListTab[]; toggle?: { label: string; href: string } | null }) {
  return (
    <nav aria-label={`${label} lists`} className="mb-4 flex items-center overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx(
            "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm whitespace-nowrap",
            t.active ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
          {t.count ? <span className="rounded-full bg-warn px-1.5 text-[11px] leading-[18px] font-medium text-white">{t.count}</span> : null}
        </Link>
      ))}
      <span className="flex-1" />
      {toggle ? (
        <Link href={toggle.href} className="px-2 py-2.5 text-[13px] font-medium text-[#5223E0] hover:underline">
          {toggle.label}
        </Link>
      ) : null}
    </nav>
  );
}

/** The coloured edge a flagged row carries, in the CRM's tokens. */
const EDGE: Partial<Record<Tone, string>> = {
  danger: "shadow-[inset_3px_0_0_var(--color-danger)]",
  warn: "shadow-[inset_3px_0_0_var(--color-warn)]",
  success: "shadow-[inset_3px_0_0_var(--color-success)]",
  brand: "shadow-[inset_3px_0_0_var(--color-brand)]",
  info: "shadow-[inset_3px_0_0_var(--color-brand)]",
};

export function ListScreen({
  spec,
  rows,
  label,
  sub,
  initialOpen,
  godowns,
  filter,
  tabs,
  toggle,
  above,
}: {
  spec: ListSpec;
  rows: ListRow[];
  /** The screen's name: the page title and the record drawer's kind line. */
  label: string;
  sub?: string;
  /** A record to open on arrival (`?open=` from search or a link). */
  initialOpen?: string | null;
  /** Godown picker items for the list's godown filter. */
  godowns: PickItem[];
  /** A dashboard pre-filter: the ids it counted, and what to call it. */
  filter?: { label: string; ids: string[] } | null;
  /** The screen's tabs, when it has several lists. */
  tabs?: ListTab[];
  /** The current tab's second list (every entry behind the available stock), and the way back. */
  toggle?: { label: string; href: string } | null;
  /** Drawn between the header and the list: a calendar, a chart, a scope switch. */
  above?: React.ReactNode;
}) {
  const ui = useErpUi();
  const { flags: FLAG, tones: ST_TONE, place } = useKit();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("");
  const [gf, setGf] = useState("");
  const [groupOn, setGroupOn] = useState(true);
  const [sort, setSort] = useState<{ k: string; d: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(initialOpen ?? null);
  /* Clearing a filter or closing a record returns to the same TAB: the tab is
     in the query, and a bare path would open the screen's first one. */
  const tabKey = params.get("view");
  const home = tabKey ? `${path}?view=${encodeURIComponent(tabKey)}` : path;

  const cols = spec.cols;
  /* A group key that is not a declared column still gets words, not its
     identifier: "monthLbl" reads "Month". */
  const colOf = (k: string): ColSpec =>
    cols.find((c) => c.k === k) ?? {
      k,
      l: k.replace(/Lbl$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
      t: "t",
    };

  const filtered = useMemo(() => {
    let all = rows;
    if (filter) {
      const ids = new Set(filter.ids);
      all = all.filter((r) => ids.has(r.id));
    }
    if (spec.godownKey && gf) all = all.filter((r) => String(r.v[spec.godownKey!] ?? "") === gf);
    return all;
  }, [rows, filter, gf, spec.godownKey]);

  const chips = useMemo(() => {
    if (!spec.chips) return [];
    const vals = Array.from(new Set(filtered.map((r) => String(r.v[spec.chips!] ?? "")).filter(Boolean)));
    return vals.map((v) => ({ v, n: filtered.filter((r) => String(r.v[spec.chips!]) === v).length }));
  }, [filtered, spec.chips]);

  const view = useMemo(() => {
    let all = filtered;
    if (spec.chips && chip) all = all.filter((r) => String(r.v[spec.chips!] ?? "") === chip);
    const ql = q.trim().toLowerCase();
    if (ql) {
      all = all.filter((r) =>
        cols
          .map((c) => (c.t === "f" ? r.flags.map((f) => FLAG[f]?.[0] ?? f).join(" ") : cellText(c, r.v[c.k])))
          .join(" ")
          .toLowerCase()
          .includes(ql),
      );
    }
    const srt = sort ?? (spec.sortDefault ? { k: spec.sortDefault[0], d: spec.sortDefault[1] } : null);
    if (srt) {
      all = all.slice().sort((a, b) => {
        const x = a.v[srt.k];
        const y = b.v[srt.k];
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
        return c * srt.d;
      });
    }
    return { all, srt };
  }, [filtered, chip, q, sort, cols, spec.chips, spec.sortDefault, FLAG]);

  const gk = spec.groups && groupOn ? spec.groups : null;
  const gOf = (r: ListRow) => (gk ?? []).map((k) => cellText(colOf(k), r.v[k])).join(" · ");
  /* Grouping reorders the rows so each group is contiguous, in the order its
     first row appears — cheap enough to do every render at list sizes. */
  const grouped = (() => {
    if (!gk) return { list: view.all, by: null as Map<string, ListRow[]> | null };
    const by = new Map<string, ListRow[]>();
    view.all.forEach((r) => {
      const g = gOf(r);
      by.set(g, [...(by.get(g) ?? []), r]);
    });
    return { list: Array.from(by.values()).flat(), by };
  })();

  const total = grouped.list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const pg = Math.min(page, pages);
  const pageRows = grouped.list.slice((pg - 1) * size, (pg - 1) * size + size);
  const inView = new Set(rows.map((r) => r.id));
  const chosen = Object.keys(sel).filter((id) => sel[id] && inView.has(id));
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => sel[r.id]);
  const bulkOn = !!spec.bulk?.length;

  const exportCsv = () => {
    const head = cols.map((c) => c.l).join(",");
    const body = grouped.list
      .map((r) =>
        cols
          .map((c) => `"${(c.t === "f" ? r.flags.map((f) => FLAG[f]?.[0] ?? f).join("; ") : cellText(c, r.v[c.k])).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([`${head}\n${body}`], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${spec.screen}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast(`Exported ${nf(grouped.list.length)} rows as shown`);
  };

  const open = rows.find((r) => r.id === openId) ?? null;
  const closeRec = () => {
    setOpenId(null);
    if (params.get("open")) router.replace(home);
  };
  const clearAll = () => {
    setQ("");
    setChip("");
    setGf("");
    setPage(1);
    if (filter) router.replace(home);
  };
  const noMatchBits = [q ? `“${q}”` : "", chip, filter ? filter.label.toLowerCase() : "", gf].filter(Boolean).join(" · ");
  const pickChip = (v: string) => {
    setChip(v);
    setPage(1);
  };

  /* The strip counts the statuses, as the CRM's Complaints screen does above
     its tabs — only where there are few enough to read at a glance. */
  const metrics: Metric[] | null =
    chips.length >= 2 && chips.length <= 5
      ? [
          { label: "All", value: nf(filtered.length), onClick: () => pickChip("") },
          ...chips.map((c) => {
            const t = ST_TONE[c.v];
            return { label: c.v, value: nf(c.n), tone: t === "danger" ? ("danger" as const) : t === "success" ? ("success" as const) : undefined, onClick: () => pickChip(c.v) };
          }),
        ]
      : null;

  const sortBy = (k: string) => {
    const on = view.srt && view.srt.k === k;
    setSort({ k, d: on && view.srt!.d > 0 ? -1 : 1 });
  };

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title={label}
        subtitle={sub}
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv} title="Download these rows, as filtered, as CSV">
              Export
            </Button>
            {spec.download ? (
              <Button variant="secondary" onClick={exportCsv}>
                <Icon n="dl" />
                Download
              </Button>
            ) : null}
            {(spec.tools ?? []).map((t) => (
              <Button
                key={t.id}
                variant={t.primary ? "primary" : "secondary"}
                disabled={!!t.why}
                title={t.why}
                onClick={() => ui.tool(spec.screen, t)}
              >
                {t.l}
              </Button>
            ))}
            {spec.newForm && !spec.readOnly ? (
              <Button variant="primary" onClick={() => spec.newForm && ui.openForm(spec.newForm)}>
                <ShellIcon name="plus" size={16} />
                {spec.newLabel ?? "New"}
              </Button>
            ) : null}
          </>
        }
      />

      {tabs && tabs.length > 1 ? <ListTabs label={label} tabs={tabs} toggle={toggle} /> : null}

      {above}
      {metrics ? <MetricStrip metrics={metrics} /> : null}

      <Card className="overflow-hidden">
        {chips.length >= 2 && chips.length <= MAX_TABS ? (
          <Tabs
            className="px-4"
            value={chip}
            onChange={pickChip}
            tabs={[{ key: "", label: "All", count: filtered.length }, ...chips.map((c) => ({ key: c.v, label: c.v, count: c.n }))]}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3">
          <div className="relative w-[300px] max-w-full">
            <ShellIcon name="search" size={16} className="pointer-events-none absolute top-2 left-2.5 text-muted" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search this list"
              className="h-8 w-full rounded-[4px] border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
            />
            {q ? (
              <button onClick={() => setQ("")} aria-label="Clear search" className="absolute top-1.5 right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center text-muted hover:text-body">
                <ShellIcon name="close" size={14} />
              </button>
            ) : null}
          </div>
          {chips.length > MAX_TABS ? (
            <select
              value={chip}
              onChange={(e) => pickChip(e.target.value)}
              aria-label={colOf(spec.chips!).l}
              className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body outline-none focus:border-brand"
            >
              <option value="">All {colOf(spec.chips!).l.toLowerCase()} · {nf(filtered.length)}</option>
              {chips.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.v} · {nf(c.n)}
                </option>
              ))}
            </select>
          ) : null}
          {spec.godownKey ? (
            <GodownPicker
              value={gf}
              label={gf || `All ${place.many}`}
              align="left"
              items={[{ v: "", l: `All ${place.many}`, sub: `${godowns.length} ${place.many}` }, ...godowns]}
              onPick={(v) => {
                setGf(v);
                setPage(1);
              }}
            />
          ) : null}
          {spec.groups ? (
            <button
              onClick={() => {
                setGroupOn((g) => !g);
                setPage(1);
              }}
              aria-pressed={!!gk}
              className={cx(
                "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px] whitespace-nowrap",
                gk ? "border-brand bg-brand-soft font-medium text-[#5223E0]" : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              Group by {spec.groups.map((k) => colOf(k).l.toLowerCase()).join(" · ")}
            </button>
          ) : null}
          {filter ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-brand bg-brand-soft pr-1 pl-2.5 text-[13px] font-medium text-[#5223E0]">
              From dashboard · {filter.label}
              <button onClick={() => router.replace(home)} aria-label="Remove filter" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] hover:bg-brand-softer">
                <ShellIcon name="close" size={14} />
              </button>
            </span>
          ) : null}
          <span className="flex-1" />
          {spec.hidden.length ? (
            <span className="flex items-center gap-1.5 text-[13px] text-muted" title={`Not on your account: ${spec.hidden.map((x) => x.l).join(", ")}`}>
              <Icon n="lock" s={14} />
              {spec.hidden.length} column{spec.hidden.length > 1 ? "s" : ""} hidden
            </span>
          ) : null}
        </div>

        {spec.scopedLine ? <div className="border-b border-divider bg-brand-soft/40 px-4 py-2 text-[13px] text-[#5223E0]">{spec.scopedLine}</div> : null}

        {rows.length === 0 ? (
          <EmptyState
            title={spec.noDataLine ?? "Nothing here yet"}
            action={
              spec.newForm && !spec.readOnly ? (
                <Button variant="primary" onClick={() => ui.openForm(spec.newForm!)}>
                  {spec.newLabel ?? "New"}
                </Button>
              ) : undefined
            }
          />
        ) : total === 0 ? (
          <EmptyState
            title="Nothing matches"
            body={`No rows match ${noMatchBits}.`}
            action={
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <>
            {spec.cards ? (
              <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {pageRows.map((r) => {
                  const src = String(r.v[spec.cards!.img] ?? "");
                  return (
                    <button
                      key={r.id}
                      onClick={() => setOpenId(r.id)}
                      className="flex cursor-pointer flex-col overflow-hidden rounded-[6px] border border-line bg-surface text-left hover:border-brand"
                    >
                      <span className="flex aspect-[3/2] items-center justify-center bg-canvas">
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a private attachment, read through the scoped endpoint
                          <img src={src} alt={String(r.v[spec.cards!.title] ?? "")} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="px-3 text-center text-[12px] text-muted">{spec.cards!.empty}</span>
                        )}
                      </span>
                      <span className="grid gap-0.5 px-3 py-2">
                        <span className="truncate text-[14px] font-semibold text-ink">{String(r.v[spec.cards!.title] ?? "")}</span>
                        {spec.cards!.lines.map((k) =>
                          r.v[k] ? (
                            <span key={k} className="truncate text-[12px] text-muted">
                              {String(r.v[k])}
                            </span>
                          ) : null,
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    {bulkOn ? (
                      <Th className="w-9">
                        <input
                          type="checkbox"
                          checked={allOnPage}
                          aria-label="Select this page"
                          onChange={() => {
                            const n = { ...sel };
                            pageRows.forEach((r) => (n[r.id] = !allOnPage));
                            setSel(n);
                          }}
                          className="h-[15px] w-[15px] cursor-pointer accent-[#6835FB]"
                        />
                      </Th>
                    ) : null}
                    {cols.map((c) => {
                      const on = !!view.srt && view.srt.k === c.k;
                      return (
                        <SortableTh
                          key={c.k}
                          align={c.t === "n" || c.t === "m" ? "right" : "left"}
                          active={on}
                          direction={on && view.srt!.d < 0 ? "desc" : "asc"}
                          onSort={() => sortBy(c.k)}
                        >
                          {c.l}
                        </SortableTh>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let lastG: string | null = null;
                    const out: React.ReactNode[] = [];
                    pageRows.forEach((r) => {
                      if (gk && grouped.by) {
                        const g = gOf(r);
                        if (g !== lastG) {
                          const rs = grouped.by.get(g) ?? [];
                          let aggText = `${nf(rs.length)} ${rs.length === 1 ? "row" : "rows"}`;
                          if (spec.agg && cols.some((c) => c.k === spec.agg!.k)) {
                            const s = rs.reduce((t, x) => t + (Number(x.v[spec.agg!.k]) || 0), 0);
                            const v = spec.agg.t === "avg" ? s / (rs.length || 1) : s;
                            aggText += ` · ${colOf(spec.agg.k).t === "m" ? inr(v) : nf(v)} ${spec.agg.l}`;
                          }
                          const allSel = rs.every((x) => sel[x.id]);
                          out.push(
                            <tr key={`g:${g}`} className="border-b border-divider bg-canvas">
                              <td colSpan={cols.length + (bulkOn ? 1 : 0)} className="px-3 py-2">
                                <span className="sticky left-3 inline-flex items-center gap-2.5">
                                  <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{gk.map((k) => colOf(k).l).join(" · ")}</span>
                                  <span className="text-[13px] font-semibold text-ink">{g || "—"}</span>
                                  <span className="text-xs text-muted">{aggText}</span>
                                  {spec.groupSel && bulkOn ? (
                                    <button
                                      onClick={() => {
                                        const n = { ...sel };
                                        rs.forEach((x) => (n[x.id] = !allSel));
                                        setSel(n);
                                      }}
                                      className="h-6 cursor-pointer rounded-[4px] border border-line bg-surface px-2 text-xs text-[#5223E0] hover:bg-brand-soft"
                                    >
                                      {allSel ? "Clear" : `Select all ${rs.length}`}
                                    </button>
                                  ) : null}
                                </span>
                              </td>
                            </tr>,
                          );
                          lastG = g;
                        }
                      }
                      const tone = rowTone(r.flags, FLAG);
                      out.push(
                        <Tr key={r.id} onClick={() => setOpenId(r.id)} className={cx("cursor-pointer", sel[r.id] ? "bg-brand-soft" : "hover:bg-canvas")}>
                          {bulkOn ? (
                            <Td className={cx("w-9", tone && EDGE[tone])} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={!!sel[r.id]}
                                aria-label="Select row"
                                onChange={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                                className="h-[15px] w-[15px] cursor-pointer accent-[#6835FB]"
                              />
                            </Td>
                          ) : null}
                          {cols.map((c, i) => (
                            <Cell key={c.k} c={c} r={r} edge={!bulkOn && i === 0 && tone ? EDGE[tone] : undefined} />
                          ))}
                        </Tr>,
                      );
                    });
                    return out;
                  })()}
                </tbody>
              </table>
            </div>
            )}
            <Pager
              total={total}
              page={pg}
              perPage={size}
              onPage={setPage}
              onPerPage={(n) => {
                setSize(n);
                setPage(1);
              }}
            />
          </>
        )}
      </Card>

      {bulkOn ? (
        <SelectionBar count={chosen.length} onClear={() => setSel({})}>
          {spec.bulk!.map((b) => (
            <Button key={b.id} variant="dark" size="sm" onClick={() => ui.bulk(spec.screen, b, chosen, () => setSel({}))}>
              {b.l}
            </Button>
          ))}
        </SelectionBar>
      ) : null}

      {open ? <RecordDrawer key={open.id} screen={spec} kind={label} row={open} onClose={closeRec} /> : null}
    </div>
  );
}

function Cell({ c, r, edge }: { c: ColSpec; r: ListRow; edge?: string }) {
  if (c.t === "f") {
    return (
      <Td className={edge}>
        <span className="flex gap-1">
          {r.flags.map((f) => (
            <FlagBadge key={f} flag={f} />
          ))}
        </span>
      </Td>
    );
  }
  if (c.t === "s") {
    return (
      <Td className={edge}>
        <StatusBadge value={r.v[c.k]} />
      </Td>
    );
  }
  const txt = cellText(c, r.v[c.k]);
  const num = c.t === "n" || c.t === "m";
  const empty = txt === "—";
  return (
    <Td
      align={num ? "right" : "left"}
      title={c.t === "b" && txt.length > 40 ? txt : undefined}
      className={cx(
        edge,
        "tabular-nums",
        c.t === "b" ? "max-w-[320px] truncate text-brand" : empty ? "text-line-strong" : undefined,
        !empty && (c.t === "ph" || c.t === "em" || c.t === "map") && "text-brand",
        c.t === "mono" && "font-mono text-[13px]",
      )}
    >
      {txt}
    </Td>
  );
}
