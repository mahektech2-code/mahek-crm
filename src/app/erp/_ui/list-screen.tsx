"use client";

import { Page } from "./page-head";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColSpec, ListRow, ListSpec, Tone } from "@/lib/erp/ui";
import { cellText, inr, nf } from "@/lib/erp/ui";
import { colOf as colIn, listCsv, listQueryParams, LIST_QUERY_KEYS, pageOf, type ListPage, type ListQuery } from "@/lib/erp/list-query";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { Button, Card, cx, EmptyState, SortableTh, Td, Th, Tr } from "@/components/ui/primitives";
import { SelectionBar, Tabs } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { PeriodPicker } from "./period-picker";
import { FlagBadge, flagsBesideStatus, rowTone, StatusBadge } from "./badge";
import { GodownPicker, type PickItem } from "./godown-picker";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { RecordDrawer } from "./record-drawer";
import { useKit } from "./kit";
import { CHECK_COL, fitColumns } from "./fit-columns";
import { ColumnsMenu } from "./columns-menu";
import { useColumnChoice } from "./use-column-choice";

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
 *
 * TWO WAYS TO PAGE, ONE READING. Given `server`, the rows are ONE page the
 * server already searched, sorted and cut, and every change to the toolbar
 * or the pager is a change to the URL that asks it for the next one — the
 * ERP's lists run to tens of thousands of rows, and sending all of them to
 * draw twenty-five was most of every page load. Without it (HRMS and the
 * other short lists) the rows are all there are and the same `pageOf` runs
 * here instead, so neither side can read a search differently.
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
    /* Tabs WRAP rather than scroll: on a tablet Orders and Logistics have more
       tabs than fit, and a tab scrolled out of sight is one nobody finds. */
    <nav aria-label={`${label} lists`} className="mb-4 flex flex-wrap items-center border-b border-line">
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
          {t.count ? <span className="rounded-full bg-warn px-1.5 text-2xs leading-[18px] font-medium text-white">{t.count}</span> : null}
        </Link>
      ))}
      <span className="flex-1" />
      {toggle ? (
        <Link href={toggle.href} className="px-2 py-2.5 text-meta font-medium text-brand-hover hover:underline">
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
  initialNew,
  server,
  openRow,
}: {
  spec: ListSpec;
  /** Every row, or — with `server` — the one page the server cut. */
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
  /**
   * Open the new-record form on arrival (`?new=1`), with these answers already
   * in it — the Departments page's "Create chemical requirement" lands here
   * with the department and the category chosen. Only the form's own fields
   * are taken; anything else in the query is ignored.
   */
  initialNew?: Record<string, string> | null;
  /** The server's page: what it read the URL as, and everything about the rows not sent. */
  server?: ListPage & { query: ListQuery };
  /** The record `?open=` names, sent beside the page because it may be on another one. */
  openRow?: ListRow | null;
}) {
  const ui = useErpUi();
  const { flags: FLAG, place, exportList, listIds } = useKit();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [local, setLocal] = useState<ListQuery>({ q: "", chip: "", gf: "", grp: true, sort: null, page: 1, size: 25, ids: filter?.ids ?? null, pd: "" });
  /* While the server cuts the next page the current one stays, dimmed — never a blank table between two pages. */
  const [pending, startTransition] = useTransition();
  /* The search box answers as it is typed; the server is asked once the typing pauses. */
  const [qInput, setQInput] = useState(server?.query.q ?? "");
  const query: ListQuery = server ? { ...server.query, q: qInput } : local;
  const go = (next: ListQuery, extra?: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params.toString());
    for (const k of LIST_QUERY_KEYS) p.delete(k);
    p.delete("open");
    for (const [k, v] of Object.entries(listQueryParams(next))) p.set(k, v);
    extra?.(p);
    const qs = p.toString();
    startTransition(() => router.replace(qs ? `${path}?${qs}` : path, { scroll: false }));
  };
  const setQuery = (patch: Partial<ListQuery>) => {
    if (server) go({ ...server.query, q: qInput, ...patch });
    else setLocal((l) => ({ ...l, ...patch }));
  };
  const serverQ = server?.query.q;
  useEffect(() => {
    if (serverQ === undefined || qInput === serverQ) return;
    const t = setTimeout(() => go({ ...server!.query, q: qInput, page: 1 }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the typed text starts a search
  }, [qInput, serverQ]);
  const q = server ? qInput : local.q;
  const setQ = (v: string) => (server ? setQInput(v) : setLocal((l) => ({ ...l, q: v, page: 1 })));
  const { chip, gf, size } = query;
  const setPage = (n: number) => setQuery({ page: n });
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(initialOpen ?? null);
  /* Opened once per arrival, then the query is cleared so a reload does not open it again. */
  const newOpened = useRef(false);
  useEffect(() => {
    if (newOpened.current || !initialNew || !spec.newForm || spec.readOnly) return;
    newOpened.current = true;
    const form = spec.newForm;
    const known = new Set(form.header.map((f) => f.k));
    const preset = Object.fromEntries(Object.entries(initialNew).filter(([k]) => known.has(k)));
    ui.openForm({ ...form, init: { ...form.init, ...preset } });
    const q = new URLSearchParams(params.toString());
    q.delete("new");
    for (const k of Object.keys(initialNew)) q.delete(k);
    const qs = q.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  }, [initialNew, spec.newForm, spec.readOnly, ui, params, path, router]);
  /* Clearing a filter or closing a record returns to the same TAB: the tab is
     in the query, and a bare path would open the screen's first one. */
  const tabKey = params.get("view");
  const home = tabKey ? `${path}?view=${encodeURIComponent(tabKey)}` : path;

  const cols = spec.cols;
  /* The table never scrolls sideways: it draws the columns that fit the card
     it is in (`fit-columns.ts`), measured as the card resizes, and folds the
     rest into the record drawer. Before the first measurement it assumes a
     tablet-width card, so the page as the server sent it never overflows —
     on a wider screen the extra columns arrive with the measurement. */
  const [avail, setAvail] = useState(760);
  const tableBox = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = tableBox.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAvail(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [spec.cards]);
  const [chosenCols, setChosenCols] = useColumnChoice(`${path}|${spec.screen}`);
  /* A group key that is not a declared column still gets words, not its
     identifier: "monthLbl" reads "Month". */
  const colOf = (k: string): ColSpec => colIn(cols, k);

  /* The page: the server's, or cut here from every row by the same function. */
  const lp: ListPage = useMemo(() => server ?? pageOf(spec, rows, local, FLAG), [server, spec, rows, local, FLAG]);
  const chips = lp.chips;
  const view = { srt: lp.sort };
  const gk = spec.groups && query.grp ? spec.groups : null;
  const total = lp.total;
  const pg = lp.page;
  const pageRows = lp.rows;
  /* A whole list drops a ticked row that has since gone; a paged one cannot
     see past its page, and the server refuses an id that no longer exists. */
  const inView = useMemo(() => (server ? null : new Set(rows.map((r) => r.id))), [server, rows]);
  const chosen = Object.keys(sel).filter((id) => sel[id] && (!inView || inView.has(id)));
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => sel[r.id]);
  const bulkOn = !!spec.bulk?.length;
  /* Columns that are facts about the group are drawn once in its header while
     grouped, so the rows carry only what differs from line to line. */
  const headCols = gk && spec.groupHead ? spec.groupHead.map((k) => cols.find((c) => c.k === k)).filter((c): c is ColSpec => !!c) : [];
  /* The group's own key is the header's first word, so while grouped its rows
     do not repeat it — a godown column reading "Bhiwandi" fourteen times under
     a header that says Bhiwandi is noise. */
  const lineCols = gk ? cols.filter((c) => !headCols.includes(c) && !gk.includes(c.k)) : cols;
  /* The longest badge each status and flags column will draw, over every row rather than this page, so widths hold still from page to page. */
  const badgeChars = lp.badgeChars;
  const fit = fitColumns({ cols: lineCols, avail, check: bulkOn, chosen: chosenCols, badgeChars });
  const shownCols = fit.shown;

  const exportCsv = async () => {
    let out: { csv: string; n: number };
    if (server) {
      if (!exportList) return;
      ui.toast("Preparing the export…");
      const res = await exportList(spec.screen, listQueryParamsWithIds(query));
      if (!res.ok) return ui.toast(res.error);
      out = res.data;
    } else out = listCsv(spec, rows, local, FLAG);
    const url = URL.createObjectURL(new Blob([out.csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${spec.screen}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast(`Exported ${nf(out.n)} rows as shown`);
  };
  /* "Select all" across every page: the ids are here already for a short
     list, and asked of the server for a paged one. */
  const selectAll = async () => {
    let ids: string[];
    if (server) {
      if (!listIds) return;
      const res = await listIds(spec.screen, listQueryParamsWithIds(query));
      if (!res.ok) return ui.toast(res.error);
      ids = res.data;
    } else ids = pageOf(spec, rows, { ...local, page: 1, size: Number.MAX_SAFE_INTEGER }, FLAG).rows.map((r) => r.id);
    setSel((s) => {
      const n = { ...s };
      ids.forEach((id) => (n[id] = true));
      return n;
    });
  };

  const open = pageRows.find((r) => r.id === openId) ?? (openRow && openRow.id === openId ? openRow : null) ?? (server ? null : rows.find((r) => r.id === openId) ?? null);
  const closeRec = () => {
    setOpenId(null);
    if (params.get("open")) {
      const p = new URLSearchParams(params.toString());
      p.delete("open");
      const qs = p.toString();
      router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    }
  };
  const clearAll = () => {
    setQInput("");
    if (server) go({ ...server.query, q: "", chip: "", gf: "", page: 1, ids: null }, (p) => (p.delete("f"), p.delete("fl")));
    else {
      setLocal((l) => ({ ...l, q: "", chip: "", gf: "", page: 1 }));
      if (filter) router.replace(home);
    }
  };
  /* "Nothing here yet. Entries appear as …" reads as a heading and the
     sentence that explains it, not as one bold paragraph. */
  const [emptyTitle, emptyBody] = splitFirstSentence(spec.noDataLine ?? "Nothing here yet.");
  /* A register read through a window: the period picker, and what to say when the period is empty or too long. */
  const win = server?.window ?? null;
  const noMatchBits = [q ? `“${q}”` : "", chip, filter ? filter.label.toLowerCase() : "", gf].filter(Boolean).join(" · ");
  const pickChip = (v: string) => setQuery({ chip: v, page: 1 });

  const sortBy = (k: string) => {
    const on = view.srt && view.srt.k === k;
    setQuery({ sort: { k, d: on && view.srt!.d > 0 ? -1 : 1 } });
  };

  return (
    <Page
      title={label}
      sub={sub}
      actions={
        <>
          {/* One export for every list: it used to sit beside a "Download"
              that did exactly the same thing on the stock and label lists. */}
          {lp.all ? (
            <Button variant="secondary" onClick={exportCsv} title="Download these rows, as filtered, as CSV">
              <Icon n="dl" />
              Export
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
    >

      {tabs && tabs.length > 1 ? <ListTabs label={label} tabs={tabs} toggle={toggle} /> : null}

      {above}

      {/* Not overflow-hidden: the filter bar's menus open over the rows, and on a short list they would be cut off at the card's edge. */}
      <Card className="relative">
        {/* The next page is on its way: a bar along the top, and the rows it replaces dimmed, so a click visibly took. */}
        {pending ? <span aria-hidden className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse rounded-t-[6px] bg-brand" /> : null}
        {chips.length >= 2 && chips.length <= MAX_TABS ? (
          <Tabs
            className="px-4"
            value={chip}
            onChange={pickChip}
            tabs={[{ key: "", label: "All", count: lp.beforeChip }, ...chips.map((c) => ({ key: c.v, label: c.v, count: c.n }))]}
          />
        ) : null}

        {/* An empty list has nothing to search, group or choose columns of:
            the toolbar is drawn once there is something to work on. */}
        {lp.all > 0 || filter || win ? (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3">
          <div className="relative w-[300px] max-w-full">
            <ShellIcon name="search" size={16} className="pointer-events-none absolute top-2 left-2.5 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search this list"
              className="h-8 w-full rounded-control border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
            />
            {q ? (
              <button onClick={() => setQ("")} aria-label="Clear search" className="absolute top-1.5 right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center text-muted hover:text-body">
                <ShellIcon name="close" size={14} />
              </button>
            ) : null}
          </div>
          {win ? <PeriodPicker key={win.pd} pd={win.pd} label={win.label} dateLabel={win.dateLabel} onPick={(pd) => setQuery({ pd, page: 1 })} /> : null}
          {chips.length > MAX_TABS ? (
            <select
              value={chip}
              onChange={(e) => pickChip(e.target.value)}
              aria-label={colOf(spec.chips!).l}
              className="h-8 cursor-pointer rounded-control border border-line bg-surface px-2.5 text-meta text-body outline-none focus:border-brand"
            >
              <option value="">All {colOf(spec.chips!).l.toLowerCase()} · {nf(lp.beforeChip)}</option>
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
              onPick={(v) => setQuery({ gf: v, page: 1 })}
            />
          ) : null}
          {spec.groups ? (
            <button
              onClick={() => setQuery({ grp: !query.grp, page: 1 })}
              aria-pressed={!!gk}
              className={cx(
                "h-8 cursor-pointer rounded-control border px-2.5 text-meta whitespace-nowrap",
                gk ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              Group by {spec.groups.map((k) => lowerFirst(colOf(k).l)).join(" · ")}
            </button>
          ) : null}
          {filter ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-brand bg-brand-soft pr-1 pl-2.5 text-meta font-medium text-brand-hover">
              From dashboard · {filter.label}
              <button onClick={() => (server ? go({ ...server.query, ids: null, page: 1 }, (p) => (p.delete("f"), p.delete("fl"))) : router.replace(home))} aria-label="Remove filter" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] hover:bg-brand-softer">
                <ShellIcon name="close" size={14} />
              </button>
            </span>
          ) : null}
          <span className="flex-1" />
          {!spec.cards && cols.length > 1 ? <ColumnsMenu cols={lineCols} fit={fit} chosen={chosenCols} onChoose={setChosenCols} /> : null}
          {spec.hidden.length ? (
            <span className="flex items-center gap-1.5 text-meta text-muted" title={`Not on your account: ${spec.hidden.map((x) => x.l).join(", ")}`}>
              <Icon n="lock" s={14} />
              {spec.hidden.length} column{spec.hidden.length > 1 ? "s" : ""} hidden
            </span>
          ) : null}
        </div>
        ) : null}

        {spec.scopedLine ? <div className="border-b border-divider bg-brand-soft/40 px-4 py-2 text-meta text-brand-hover">{spec.scopedLine}</div> : null}

        {win?.tooWide ? (
          <EmptyState
            title="That period is too long to show"
            body={`${win.label} holds ${nf(win.tooWide.n)} rows, and this list reads at most ${nf(win.tooWide.cap)} at a time. Pick a shorter period, or search within one.`}
          />
        ) : lp.all === 0 && win ? (
          <EmptyState title={`Nothing in ${lowerFirst(win.label)}`} body={`No rows have a ${lowerFirst(win.dateLabel)} in this period. Pick a longer one to see older rows.`} />
        ) : lp.all === 0 ? (
          <EmptyState
            title={emptyTitle}
            body={emptyBody}
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
          <div className={cx("transition-opacity", pending && "pointer-events-none opacity-60")} aria-busy={pending || undefined}>
            {spec.cards ? (
              <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {pageRows.map((r) => {
                  const src = String(r.v[spec.cards!.img] ?? "");
                  return (
                    <button
                      key={r.id}
                      onClick={() => setOpenId(r.id)}
                      className="flex cursor-pointer flex-col overflow-hidden rounded-card border border-line bg-surface text-left hover:border-brand"
                    >
                      <span className="flex aspect-[3/2] items-center justify-center bg-canvas">
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a private attachment, read through the scoped endpoint
                          <img src={src} alt={String(r.v[spec.cards!.title] ?? "")} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="px-3 text-center text-xs text-muted">{spec.cards!.empty}</span>
                        )}
                      </span>
                      <span className="grid gap-0.5 px-3 py-2">
                        <span className="truncate text-sm font-semibold text-ink">{String(r.v[spec.cards!.title] ?? "")}</span>
                        {spec.cards!.lines.map((k) =>
                          r.v[k] ? (
                            <span key={k} className="truncate text-xs text-muted">
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
            <div ref={tableBox} className="overflow-x-auto">
              <table className="w-full table-fixed">
                <colgroup>
                  {bulkOn ? <col style={{ width: CHECK_COL }} /> : null}
                  {shownCols.map((c) => (
                    <col key={c.k} style={{ width: fit.widths[c.k] }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {bulkOn ? (
                      <Th>
                        <input
                          type="checkbox"
                          checked={allOnPage}
                          aria-label="Select this page"
                          onChange={() => {
                            const n = { ...sel };
                            pageRows.forEach((r) => (n[r.id] = !allOnPage));
                            setSel(n);
                          }}
                          className="h-[15px] w-[15px] cursor-pointer accent-brand"
                        />
                      </Th>
                    ) : null}
                    {shownCols.map((c) => {
                      const on = !!view.srt && view.srt.k === c.k;
                      return (
                        <SortableTh
                          key={c.k}
                          align={c.t === "n" || c.t === "m" ? "right" : "left"}
                          active={on}
                          direction={on && view.srt!.d < 0 ? "desc" : "asc"}
                          onSort={() => sortBy(c.k)}
                        >
                          {/* A heading wraps onto a second line rather than widening its column. */}
                          <span className={cx("whitespace-normal leading-[1.3]", c.t === "n" || c.t === "m" ? "text-right" : "text-left")}>{c.l}</span>
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
                      if (gk) {
                        const g = lp.groupOf[r.id] ?? "";
                        if (g !== lastG) {
                          const grp = lp.groups[g] ?? { n: 0, agg: null, ids: [], head: {} };
                          let aggText = `${nf(grp.n)} ${grp.n === 1 ? "row" : "rows"}`;
                          if (spec.agg && grp.agg != null) aggText += ` · ${colOf(spec.agg.k).t === "m" ? inr(grp.agg) : nf(grp.agg)} ${spec.agg.l}`;
                          const allSel = grp.ids.every((id) => sel[id]);
                          out.push(
                            <tr key={`g:${g}`} className="border-b border-divider bg-canvas">
                              <td colSpan={shownCols.length + (bulkOn ? 1 : 0)} className="px-3 py-2">
                                <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                                  <span className="text-2xs font-medium tracking-[0.04em] text-muted uppercase">{gk.map((k) => colOf(k).l).join(" · ")}</span>
                                  <span className="text-meta font-semibold text-ink">{g || "—"}</span>
                                  {headCols.map((c) => (
                                    <GroupFact key={c.k} c={c} v={grp.head[c.k]} />
                                  ))}
                                  <span className={cx("text-xs text-muted", headCols.length > 0 && "ml-auto")}>{aggText}</span>
                                  {spec.groupSel && bulkOn ? (
                                    <button
                                      onClick={() => {
                                        const n = { ...sel };
                                        grp.ids.forEach((id) => (n[id] = !allSel));
                                        setSel(n);
                                      }}
                                      className="h-6 cursor-pointer rounded-control border border-line bg-surface px-2 text-xs text-brand-hover hover:bg-brand-soft"
                                    >
                                      {allSel ? "Clear" : `Select all ${grp.n}`}
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
                            <Td className={cx(tone && EDGE[tone])} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={!!sel[r.id]}
                                aria-label="Select row"
                                onChange={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                                className="h-[15px] w-[15px] cursor-pointer accent-brand"
                              />
                            </Td>
                          ) : null}
                          {shownCols.map((c, i) => (
                            <Cell key={c.k} c={c} r={r} cols={cols} edge={!bulkOn && i === 0 && tone ? EDGE[tone] : undefined} />
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
            <div className="overflow-hidden rounded-b-[6px]">
              <Pager
                total={total}
                page={pg}
                perPage={size}
                onPage={setPage}
                onPerPage={(n) => setQuery({ size: n, page: 1 })}
              />
            </div>
          </div>
        )}
      </Card>

      {bulkOn ? (
        <SelectionBar count={chosen.length} onClear={() => setSel({})}>
          {/* The header box takes this page; this takes everything the
              search, chips and godown filter leave, across every page. */}
          {chosen.length < total ? (
            <button
              onClick={selectAll}
              className="cursor-pointer text-meta text-line-strong underline-offset-2 hover:text-white hover:underline"
            >
              Select all {nf(total)}
            </button>
          ) : null}
          {spec.bulk!.map((b) => (
            <Button key={b.id} variant="dark" size="sm" onClick={() => ui.bulk(spec.screen, b, chosen, () => setSel({}))}>
              {b.l}
            </Button>
          ))}
        </SelectionBar>
      ) : null}

      {open ? <RecordDrawer key={open.id} screen={spec} kind={label} row={open} onClose={closeRec} /> : null}
    </Page>
  );
}

/** One fact about a group, in its header: the status as its badge, a name in
    bold, anything else as label and value. A blank fact is left out. */
/** "SFG no" reads "sfg no" lowercased whole; only a leading capital of an ordinary word is lowered. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function GroupFact({ c, v }: { c: ColSpec; v: ListRow["v"][string] | undefined }) {
  const text = cellText(c, v);
  if (v == null || text === "" || text === "—") return null;
  if (c.t === "s") return <StatusBadge value={String(v)} />;
  if (c.t === "b") return <span className="text-meta font-semibold text-ink">{text}</span>;
  return (
    <span className="text-xs text-muted">
      {c.l} <span className={cx("text-body", c.t === "mono" && "font-mono")}>{text}</span>
    </span>
  );
}

/** Splits at the first sentence end: the first sentence, and the rest (or undefined). */
function splitFirstSentence(line: string): [string, string | undefined] {
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(line.trim());
  return m ? [m[1], m[2]] : [line.trim(), undefined];
}

function Cell({ c, r, edge, cols }: { c: ColSpec; r: ListRow; edge?: string; cols: ColSpec[] }) {
  /* Every cell is held to its column: the table is fixed-width, so a long
     value ends in "…" with the whole of it on hover, and badges that do not
     fit are clipped rather than pushing the row wider. */
  const { flags } = useKit();
  if (c.t === "f") {
    const shown = flagsBesideStatus(r, cols, flags);
    const words = shown.map((f) => flags[f]?.[0] ?? f).join(", ");
    return (
      <Td className={cx(edge, "overflow-hidden")} title={words || undefined}>
        {/* Two flags on one row wrap onto a second line rather than the
            second being cut off at the column's edge. */}
        <span className="flex flex-wrap gap-1 overflow-hidden py-0.5">
          {shown.map((f) => (
            <FlagBadge key={f} flag={f} />
          ))}
        </span>
      </Td>
    );
  }
  if (c.t === "s") {
    const v = r.v[c.k];
    return (
      <Td className={cx(edge, "overflow-hidden")} title={v == null ? undefined : String(v)}>
        <span className="flex overflow-hidden">
          <StatusBadge value={v} />
        </span>
      </Td>
    );
  }
  const txt = cellText(c, r.v[c.k]);
  const num = c.t === "n" || c.t === "m";
  const empty = txt === "—";
  return (
    <Td
      align={num ? "right" : "left"}
      title={empty ? undefined : txt}
      className={cx(
        edge,
        "truncate tabular-nums",
        c.t === "b" ? "font-medium text-ink" : empty ? "text-line-strong" : undefined,
        !empty && (c.t === "ph" || c.t === "em" || c.t === "map") && "text-brand",
        c.t === "mono" && "font-mono text-meta",
      )}
    >
      {txt}
    </Td>
  );
}

/** A query as the export and select-all actions take it: the URL's keys, plus the dashboard's ids. */
function listQueryParamsWithIds(q: ListQuery): Record<string, string> {
  return { ...listQueryParams(q), ...(q.ids ? { f: q.ids.join(",") } : {}) };
}
