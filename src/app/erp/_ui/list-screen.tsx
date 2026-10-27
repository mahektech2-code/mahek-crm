"use client";

import { Page } from "./page-head";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { NavLink } from "@/components/shell/nav-link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColSpec, FormSpec, ListRow, ListSpec, Tone } from "@/lib/erp/ui";
import type { Result } from "@/lib/result";
import { cellText, inr, nf, NEW_FORM_ACTION } from "@/lib/erp/ui";
import { colOf as colIn, listCsv, listQueryParams, LIST_QUERY_KEYS, pageOf, subMatches, type ListPage, type ListQuery } from "@/lib/erp/list-query";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { Button, Card, checkboxClass, cx, EmptyState, Input, Select, SortableTh, Td, Th, Tr } from "@/components/ui/primitives";
import { eyebrowClass, LinkButton, linkClass } from "./look";
import { RowMenu, SelectionBar, Tabs } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { PeriodPicker } from "./period-picker";
import { FlagBadge, flagsBesideStatus, rowTone, StatusBadge } from "./badge";
import { GodownPicker, type PickItem } from "./godown-picker";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { RecordDialog } from "./record-dialog";
import { useKit } from "./kit";
import { CHECK_COL, fitColumns } from "./fit-columns";
import { ColumnsMenu, toolbarToggleClass } from "./columns-menu";
import { useColumnChoice } from "./use-column-choice";
import { NewMenu } from "./new-menu";
import { CardGrid } from "@/components/ui/card-grid";

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
       tabs than fit, and a tab scrolled out of sight is one nobody finds.
       Each is a NavLink, prefetched on hover like the sidebar: a plain Link
       prefetched every tab in view the moment the page drew — four requests
       for each real click on production, on the one shared core. */
    <nav aria-label={`${label} lists`} className="mb-4 flex flex-wrap items-center gap-x-5 border-b border-line">
      {tabs.map((t) => (
        <NavLink
          key={t.key}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx(
            "-mb-px flex items-center gap-1.5 border-b-2 py-2 text-sm whitespace-nowrap",
            t.active ? "border-brand font-semibold text-ink" : "border-transparent font-medium text-muted hover:text-body",
          )}
        >
          {t.label}
          {t.count ? <span className="min-w-4.5 rounded-full bg-warn-soft px-1.5 text-center text-2xs leading-[17px] font-bold text-warn-ink">{t.count}</span> : null}
        </NavLink>
      ))}
      <span className="flex-1" />
      {toggle ? (
        <NavLink href={toggle.href} className={linkClass("brand", "px-2 py-2.5 text-meta")}>
          {toggle.label}
        </NavLink>
      ) : null}
    </nav>
  );
}

/**
 * A screen's sub-modules, above its tabs (`ErpView.section`): Petty Cash's
 * Overview, Expenses, Receipts and Cash & Bank. Drawn heavier than the tabs
 * under them, so the two levels never read as one long strip.
 */
export function SectionTabs({ label, sections }: { label: string; sections: ListTab[] }) {
  return (
    <nav aria-label={`${label} sections`} className="mb-3 flex flex-wrap items-center gap-1 border-b border-line">
      {sections.map((t) => (
        <NavLink
          key={t.key}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx(
            "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-3 text-base whitespace-nowrap",
            t.active ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
          {t.count ? <span className={cx("rounded-full px-1.5 text-2xs leading-[18px] font-medium", t.active ? "bg-brand text-white" : "bg-canvas text-body")}>{t.count}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

/** Figures read left to right with an operator between them: Opening + In − Out = Closing. */
export function FigureStrip({ items }: { items: NonNullable<ListSpec["strip"]> }) {
  return (
    <Card className="mb-3 flex flex-wrap items-stretch">
      {items.map((f) => (
        <div key={f.l} className="flex min-w-0 flex-1 items-stretch">
          {f.op ? <span className="flex items-center border-l border-divider px-3 text-lg text-muted">{f.op}</span> : null}
          <div className={cx("min-w-0 flex-1 px-4 py-3", f.op && "border-l border-divider")}>
            <div className={eyebrowClass}>{f.l}</div>
            <div className={cx("mt-0.5 text-lg font-semibold tabular-nums", f.tone === "danger" ? "text-danger" : f.tone === "success" ? "text-success" : "text-ink")}>{f.v}</div>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** The coloured edge a flagged row carries, in the CRM's tokens. */
/** The dot and the bar of a figure card, by the tone its value is drawn in. */
const STAT_FILL: Record<Tone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  brand: "bg-brand",
  neutral: "bg-faint",
  muted: "bg-faint",
};

/**
 * THE CHIPS, AS FIGURE CARDS — the v4 list head. The same choice the chip tabs
 * offer, one card per value with its count and its share of the whole, the
 * total first and the rest largest first. Picking a card is picking the chip.
 */
export function StatCards({
  total,
  chips,
  value,
  tones,
  onPick,
}: {
  total: number;
  chips: { v: string; n: number }[];
  value: string;
  tones: Record<string, Tone>;
  onPick: (v: string) => void;
}) {
  const cards = [
    { v: "", l: "Total", n: total, fill: "bg-ink", share: "All records", pct: 100 },
    ...[...chips]
      .sort((a, b) => b.n - a.n)
      .map((c) => {
        const pct = total ? Math.round((c.n / total) * 100) : 0;
        return { v: c.v, l: c.v, n: c.n, fill: STAT_FILL[tones[c.v] ?? "neutral"], share: `${pct}% of total`, pct: Math.max(2, pct) };
      }),
  ];
  return (
    <CardGrid min={150} gap="gap-3" className="mb-3">
      {cards.map((c) => {
        const on = c.v === value;
        return (
          <button
            key={c.v || "all"}
            type="button"
            title={c.l}
            aria-pressed={on}
            onClick={() => onPick(c.v)}
            className={cx(
              "flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-[10px] border bg-surface px-4 pt-3.5 pb-3 text-left",
              on ? "border-brand ring-3 ring-brand-soft" : "border-line hover:border-line-strong",
            )}
          >
            <span className="flex min-w-0 items-center gap-2 text-meta font-semibold text-muted">
              <span className={cx("h-1.75 w-1.75 flex-none rounded-full", c.fill)} />
              <span className="truncate">{c.l}</span>
            </span>
            <span className="text-2xl leading-7.5 font-bold tracking-tight text-ink tabular-nums">{nf(c.n)}</span>
            <span className="block h-1 overflow-hidden rounded-full bg-divider">
              <span className={cx("block h-full rounded-full", c.fill)} style={{ width: `${c.pct}%` }} />
            </span>
            <span className="text-xs text-faint">{c.share}</span>
          </button>
        );
      })}
    </CardGrid>
  );
}

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
  sections,
  toggle,
  above,
  initialNew,
  server,
  openRow,
  bare = false,
}: {
  spec: ListSpec;
  /** Every row, or — with `server` — the one page the server cut. */
  rows: ListRow[];
  /** The screen's name: the page title and the record dialog's kind line. */
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
  /** Sub-modules above the tabs, where the screen has two levels. */
  sections?: ListTab[] | null;
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
  /** Drawn inside a page that already has its own heading (Petty Cash): no title, its buttons on a row of their own. */
  bare?: boolean;
}) {
  const ui = useErpUi();
  const { flags: FLAG, place, exportList, listIds, loadForm, tones, look } = useKit();
  const v4 = look === "v4";
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [local, setLocal] = useState<ListQuery>({ q: "", chip: "", gf: "", grp: true, sort: null, page: 1, size: 25, ids: filter?.ids ?? null, pd: "", parts: false, fx: {} });
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
  /* Totals opened onto their folded rows, by hand. Unset follows the search: a lot number typed opens the total it is under. */
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  /* A New form too heavy to send with the list is asked for when it is wanted
     (`lazy-forms.ts`) — from the first hover over the button, so by the click
     it has usually landed. Asked once per press: a form carries next numbers
     and stock that a save moves, so a kept copy would go stale. */
  const hasNew = !!(spec.newForm || spec.newFormLazy) && !spec.readOnly;
  const newAsk = useRef<Promise<Result<FormSpec>> | null>(null);
  const askNew = () => (newAsk.current ??= loadForm(spec.screen, NEW_FORM_ACTION, server?.query.pd ?? ""));
  const warmNew = () => {
    if (!spec.newForm && spec.newFormLazy) void askNew();
  };
  const openNew = (preset?: Record<string, string>) => {
    const open = (form: FormSpec) => {
      const known = new Set(form.header.map((f) => f.k));
      const given = Object.fromEntries(Object.entries(preset ?? {}).filter(([k]) => known.has(k)));
      ui.openForm(preset ? { ...form, init: { ...form.init, ...given } } : form);
    };
    if (spec.newForm) return open(spec.newForm);
    if (!spec.newFormLazy) return;
    void askNew().then((res) => {
      newAsk.current = null;
      if (res.ok) open(res.data);
      else ui.toast(res.error, "error");
    });
  };
  /* Opened once per arrival, then the query is cleared so a reload does not open it again. */
  const newOpened = useRef(false);
  useEffect(() => {
    if (newOpened.current || !initialNew || !hasNew) return;
    newOpened.current = true;
    openNew(initialNew);
    const q = new URLSearchParams(params.toString());
    q.delete("new");
    for (const k of Object.keys(initialNew)) q.delete(k);
    const qs = q.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival; openNew reads the spec this render was given
  }, [initialNew, hasNew, params, path, router]);
  /* Clearing a filter or closing a record returns to the same TAB: the tab is
     in the query, and a bare path would open the screen's first one. */
  const tabKey = params.get("view");
  const home = tabKey ? `${path}?view=${encodeURIComponent(tabKey)}` : path;

  const cols = spec.cols;
  /* The table never scrolls sideways: it draws the columns that fit the card
     it is in (`fit-columns.ts`), measured as the card resizes, and folds the
     rest into the record dialog. Before the first measurement it assumes a
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
  /* A row's ⋯ menu takes a narrow column of its own at the end. */
  const menuIds = spec.rowMenu ?? [];
  const menuOn = menuIds.length > 0;
  const fit = fitColumns({ cols: lineCols, avail: menuOn ? Math.max(0, avail - MENU_COL) : avail, check: bulkOn, chosen: chosenCols, badgeChars });
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

  /* A folded row opens its own record, so it is looked for under its total too. */
  const withSubs = (rs: ListRow[]) => rs.flatMap((r) => [r, ...(r.sub ?? [])]);
  const open =
    withSubs(pageRows).find((r) => r.id === openId) ??
    (openRow && openRow.id === openId ? openRow : null) ??
    (server ? null : withSubs(rows).find((r) => r.id === openId) ?? null);
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
    if (server) go({ ...server.query, q: "", chip: "", gf: "", fx: {}, page: 1, ids: null }, (p) => (p.delete("f"), p.delete("fl")));
    else {
      setLocal((l) => ({ ...l, q: "", chip: "", gf: "", fx: {}, page: 1 }));
      if (filter) router.replace(home);
    }
  };
  /* "Nothing here yet. Entries appear as …" reads as a heading and the
     sentence that explains it, not as one bold paragraph. */
  const [emptyTitle, emptyBody] = splitFirstSentence(spec.noDataLine ?? "Nothing here yet.");
  /* A register read through a window: the period picker, and what to say when the period is empty or too long. */
  const win = server?.window ?? null;
  const noMatchBits = [q ? `“${q}”` : "", chip, filter ? filter.label.toLowerCase() : "", gf, ...Object.values(query.fx)].filter(Boolean).join(" · ");
  const pickFx = (k: string, v: string) => {
    const fx = { ...query.fx };
    if (v) fx[k] = v;
    else delete fx[k];
    setQuery({ fx, page: 1 });
  };
  const pickChip = (v: string) => setQuery({ chip: v, page: 1 });

  const sortBy = (k: string) => {
    const on = view.srt && view.srt.k === k;
    setQuery({ sort: { k, d: on && view.srt!.d > 0 ? -1 : 1 } });
  };

  const toolbar =
    lp.all > 0 || filter || win ? (
        <div className={cx("flex flex-wrap items-center gap-2.5", v4 ? "mb-3" : "border-b border-divider px-4 py-3")}>
          <div className="relative w-[300px] max-w-full">
            <ShellIcon name="search" size={16} className="pointer-events-none absolute top-2.25 left-2.5 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this list" aria-label="Search this list" className="pr-7 pl-7.5" />
            {q ? (
              <button onClick={() => setQ("")} aria-label="Clear search" className="absolute top-1.75 right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center text-muted hover:text-body">
                <ShellIcon name="close" size={14} />
              </button>
            ) : null}
          </div>
          {win ? <PeriodPicker key={win.pd} pd={win.pd} label={win.label} dateLabel={win.dateLabel} onPick={(pd) => setQuery({ pd, page: 1 })} /> : null}
          {chips.length > MAX_TABS ? (
            <Select value={chip} onChange={(e) => pickChip(e.target.value)} aria-label={colOf(spec.chips!).l} className="cursor-pointer">
              <option value="">All {colOf(spec.chips!).l.toLowerCase()} · {nf(lp.beforeChip)}</option>
              {chips.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.v} · {nf(c.n)}
                </option>
              ))}
            </Select>
          ) : null}
          {(lp.facets ?? []).map((f) =>
            f.opts.length > 1 || query.fx[f.k] ? (
              <Select
                key={f.k}
                value={query.fx[f.k] ?? ""}
                onChange={(e) => pickFx(f.k, e.target.value)}
                aria-label={`Filter by ${lowerFirst(f.l)}`}
                className={cx("max-w-[220px] cursor-pointer", query.fx[f.k] && "border-brand bg-brand-soft text-brand-hover")}
              >
                <option value="">All {lowerFirst(f.l)}</option>
                {f.opts.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.v} · {nf(o.n)}
                  </option>
                ))}
              </Select>
            ) : null,
          )}
          {spec.godownKey ? (
            <GodownPicker
              value={gf}
              label={gf || `All ${place.many}`}
              align="left"
              items={[{ v: "", l: `All ${place.many}`, sub: `${godowns.length} ${place.many}` }, ...godowns]}
              onPick={(v) => setQuery({ gf: v, page: 1 })}
            />
          ) : null}
          {spec.fold ? (
            <span role="group" aria-label={spec.fold.l} className="inline-flex h-8 items-center overflow-hidden rounded-control border border-line text-meta">
              <span className="px-2.5 text-muted">{spec.fold.l}</span>
              {[
                { v: false, l: spec.fold.whole },
                { v: true, l: spec.fold.parts },
              ].map((o) => (
                <button
                  key={o.l}
                  onClick={() => setQuery({ parts: o.v, page: 1 })}
                  aria-pressed={query.parts === o.v}
                  className={cx(
                    "h-full cursor-pointer border-l border-line px-2.5 whitespace-nowrap",
                    query.parts === o.v ? "bg-brand-soft font-medium text-brand-hover" : "bg-surface text-body hover:bg-canvas",
                  )}
                >
                  {o.l}
                </button>
              ))}
            </span>
          ) : null}
          {spec.groups ? (
            <button
              onClick={() => setQuery({ grp: !query.grp, page: 1 })}
              aria-pressed={!!gk}
              className={toolbarToggleClass(!!gk)}
            >
              Group by {spec.groups.map((k) => lowerFirst(colOf(k).l)).join(" · ")}
            </button>
          ) : null}
          {filter ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-brand bg-brand-soft pr-1 pl-2.5 text-meta font-medium text-brand-hover">
              From dashboard · {filter.label}
              <button onClick={() => (server ? go({ ...server.query, ids: null, page: 1 }, (p) => (p.delete("f"), p.delete("fl"))) : router.replace(home))} aria-label="Remove filter" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-control hover:bg-brand-softer">
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
    ) : null;

  const Frame = bare ? BareFrame : Page;
  return (
    <Frame
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
          {spec.newMenu?.length && !spec.readOnly ? (
            <NewMenu items={spec.newMenu} />
          ) : hasNew ? (
            <Button variant="primary" onClick={() => openNew()} onPointerEnter={warmNew} onFocus={warmNew}>
              <ShellIcon name="plus" size={16} />
              {spec.newLabel ?? "New"}
            </Button>
          ) : null}
        </>
      }
    >

      {sections?.length ? <SectionTabs label={label} sections={sections} /> : null}
      {tabs && (tabs.length > 1 || (sections?.length && tabs.length)) ? <ListTabs label={label} tabs={tabs} toggle={toggle} /> : null}

      {above}

      {spec.strip?.length ? <FigureStrip items={spec.strip} /> : null}

      {/* v4: the chips are figure cards, and the search and filters stand on
          the page above the table rather than inside its card. */}
      {v4 && chips.length >= 2 && chips.length <= MAX_TABS ? (
        <StatCards total={lp.beforeChip} chips={chips} value={chip} tones={tones} onPick={pickChip} />
      ) : null}
      {v4 ? toolbar : null}

      {/* Not overflow-hidden: the filter bar's menus open over the rows, and on a short list they would be cut off at the card's edge. */}
      <Card className="relative">
        {/* The next page is on its way: a bar along the top, and the rows it replaces dimmed, so a click visibly took. */}
        {pending ? <span aria-hidden className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse rounded-t-card bg-brand" /> : null}
        {chips.length >= 2 && chips.length <= MAX_TABS && !v4 ? (
          <Tabs
            className="px-4"
            value={chip}
            onChange={pickChip}
            tabs={[{ key: "", label: "All", count: lp.beforeChip }, ...chips.map((c) => ({ key: c.v, label: c.v, count: c.n }))]}
          />
        ) : null}

        {/* An empty list has nothing to search, group or choose columns of:
            the toolbar is drawn once there is something to work on. */}
        {v4 ? null : toolbar}

        {spec.fold?.note && !query.parts && lp.all > 0 ? <div className="border-b border-divider px-4 py-2 text-meta text-muted">{spec.fold.note}</div> : null}

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
              hasNew ? (
                <Button variant="primary" onClick={() => openNew()} onPointerEnter={warmNew} onFocus={warmNew}>
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
                  {menuOn ? <col style={{ width: MENU_COL }} /> : null}
                </colgroup>
                <thead>
                  <tr>
                    {bulkOn ? (
                      <Th>
                        <input
                          type="checkbox" className={checkboxClass}
                          checked={allOnPage}
                          aria-label="Select this page"
                          onChange={() => {
                            const n = { ...sel };
                            pageRows.forEach((r) => (n[r.id] = !allOnPage));
                            setSel(n);
                          }}
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
                    {menuOn ? (
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    ) : null}
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
                            <Tr key={`g:${g}`} className="bg-canvas">
                              <Td colSpan={shownCols.length + (bulkOn ? 1 : 0) + (menuOn ? 1 : 0)} className="py-2 whitespace-normal">
                                <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                                  <span className={eyebrowClass}>{gk.map((k) => colOf(k).l).join(" · ")}</span>
                                  <span className="text-meta font-semibold text-ink">{g || "—"}</span>
                                  {headCols.map((c) => (
                                    <GroupFact key={c.k} c={c} v={grp.head[c.k]} />
                                  ))}
                                  <span className={cx("text-xs text-muted", headCols.length > 0 && "ml-auto")}>{aggText}</span>
                                  {spec.groupSel && bulkOn ? (
                                    <LinkButton
                                      onClick={() => {
                                        const n = { ...sel };
                                        grp.ids.forEach((id) => (n[id] = !allSel));
                                        setSel(n);
                                      }}
                                      className="text-xs"
                                    >
                                      {allSel ? "Clear" : `Select all ${grp.n}`}
                                    </LinkButton>
                                  ) : null}
                                </span>
                              </Td>
                            </Tr>,
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
                                type="checkbox" className={checkboxClass}
                                checked={!!sel[r.id]}
                                aria-label="Select row"
                                onChange={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                              />
                            </Td>
                          ) : null}
                          {shownCols.map((c, i) => (
                            <Cell
                              key={c.k}
                              c={c}
                              r={r}
                              cols={cols}
                              edge={!bulkOn && i === 0 && tone ? EDGE[tone] : undefined}
                              lead={
                                i === 0 && r.sub?.length ? (
                                  <FoldToggle
                                    open={unfolded[r.id] ?? subMatches(cols, r, q, FLAG)}
                                    n={r.sub.length}
                                    onToggle={() => setUnfolded((u) => ({ ...u, [r.id]: !(u[r.id] ?? subMatches(cols, r, q, FLAG)) }))}
                                  />
                                ) : undefined
                              }
                            />
                          ))}
                          {menuOn ? <MenuCell row={r} ids={menuIds} screen={spec.screen} /> : null}
                        </Tr>,
                      );
                      /* Its folded rows, under it: indented, and blank where they only repeat their total. */
                      if (r.sub?.length && (unfolded[r.id] ?? subMatches(cols, r, q, FLAG))) {
                        for (const x of r.sub) {
                          out.push(
                            <Tr key={`${r.id}>${x.id}`} onClick={() => setOpenId(x.id)} className="cursor-pointer bg-canvas/60 hover:bg-canvas">
                              {bulkOn ? <Td /> : null}
                              {shownCols.map((c, i) =>
                                i === 0 ? (
                                  <Td key={c.k} className="truncate pl-10 text-meta text-body" title={x.subLine ?? cellText(c, x.v[c.k])}>
                                    {x.subLine ?? cellText(c, x.v[c.k])}
                                  </Td>
                                ) : c.t !== "n" && c.t !== "m" && x.v[c.k] === r.v[c.k] ? (
                                  <Td key={c.k} />
                                ) : (
                                  <Cell key={c.k} c={c} r={x} cols={cols} small />
                                ),
                              )}
                              {menuOn ? <MenuCell row={x} ids={menuIds} screen={spec.screen} /> : null}
                            </Tr>,
                          );
                        }
                      }
                    });
                    return out;
                  })()}
                </tbody>
              </table>
            </div>
            )}
            <div className="overflow-hidden rounded-b-card">
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

      {open ? <RecordDialog key={open.id} screen={spec} kind={label} row={open} onClose={closeRec} /> : null}
    </Frame>
  );
}

/** The width of a row's ⋯ menu column. */
const MENU_COL = 52;

/**
 * A row's ⋯ menu: the record's own actions the screen names in `rowMenu`, in
 * that order, run exactly as the record dialog runs them. A click inside it
 * never opens the record.
 */
function MenuCell({ row, ids, screen }: { row: ListRow; ids: string[]; screen: string }) {
  const ui = useErpUi();
  const items = ids
    .map((id) => row.actions?.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ label: a.l, disabled: !!a.why, title: a.why || undefined, onSelect: () => ui.act(screen, a, row.id) }));
  return (
    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
      {items.length ? <RowMenu items={items} /> : null}
    </Td>
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

/** The caret on a total that opens onto the rows folded under it. Its own button, so it does not open the total's record. */
function FoldToggle({ open, n, onToggle }: { open: boolean; n: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      aria-label={open ? `Hide the ${n} ${n === 1 ? "row" : "rows"} under this` : `Show the ${n} ${n === 1 ? "row" : "rows"} under this`}
      className="mr-1.5 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-control align-[-4px] text-muted hover:bg-brand-soft hover:text-brand-hover"
    >
      <Icon n={open ? "down" : "chev"} s={14} />
    </button>
  );
}

function Cell({ c, r, edge, cols, lead, small }: { c: ColSpec; r: ListRow; edge?: string; cols: ColSpec[]; lead?: React.ReactNode; small?: boolean }) {
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
        small && "text-meta",
      )}
    >
      {lead}
      {txt}
    </Td>
  );
}

/** A query as the export and select-all actions take it: the URL's keys, plus the dashboard's ids. */
function listQueryParamsWithIds(q: ListQuery): Record<string, string> {
  return { ...listQueryParams(q), ...(q.ids ? { f: q.ids.join(",") } : {}) };
}

/** A list inside a page that already carries its heading: the buttons on their own row, then the list. */
function BareFrame({ actions, children }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      {actions ? <div className="mb-3 flex flex-wrap justify-end gap-2.5 empty:hidden">{actions}</div> : null}
      {children}
    </div>
  );
}
