"use client";

import { Page } from "./page-head";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { bulkOffers } from "@/lib/erp/bulk-fit";
import { NavLink } from "@/components/shell/nav-link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColSpec, FormSpec, ListRow, ListSpec, Tone } from "@/lib/erp/ui";
import type { Result } from "@/lib/result";
import { aggsOf, cellText, moneyText, nf, NEW_FORM_ACTION } from "@/lib/erp/ui";
import { colOf as colIn, listCsv, listQueryParams, LIST_QUERY_KEYS, pageOf, queryRows, selectionTotals, selectionTotalText, subMatches, type ColFilter, type ListPage, type ListQuery, type SelectionTotal, type StatPick } from "@/lib/erp/list-query";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { Button, Card, checkboxClass, cx, EmptyState, Input, Select, SortableTh, Td, Th, Tr } from "@/components/ui/primitives";
import { eyebrowClass, IconButton, LinkButton, linkClass } from "./look";
import { FilterPanel } from "./filter-panel";
import { StatRow } from "./stat-row";
import { RowMenu, SelectionBar, Tabs } from "@/components/ui/overlays";
import { Pager } from "@/components/ui/pager";
import { PeriodPicker } from "./period-picker";
import { FlagBadge, flagsBesideStatus, rowTone, StatusBadge } from "./badge";
import type { PickItem } from "./godown-picker";
import { Icon } from "./icons";
import { InvoiceButtons } from "./invoice-buttons";
import { PrintInvoicesModal } from "./invoice-modals";
import { useErpUi } from "./erp-ui";
import { RecordDialog } from "./record-dialog";
import { useKit } from "./kit";
import { CHECK_COL, fitColumns } from "./fit-columns";
import { ColumnsMenu, toolbarToggleClass } from "./columns-menu";
import { useColumnChoice } from "./use-column-choice";
import { NewMenu } from "./new-menu";

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


const EMPTY_TILE = {
  brand: "bg-brand-soft text-brand",
  warn: "bg-warn-soft text-warn-ink",
  muted: "bg-divider text-muted",
} as const;

/** v4: the square tile over an empty list's sentence. */
function EmptyTile({ icon, tone = "brand" }: { icon: string; tone?: keyof typeof EMPTY_TILE }) {
  return (
    <span className={cx("flex h-12 w-12 items-center justify-center rounded-[10px]", EMPTY_TILE[tone])}>
      <Icon n={icon} s={22} />
    </span>
  );
}

/**
 * v4: a message list drawn as a conversation — who wrote down the left, what
 * they wrote in the middle, and the picked message's draft on the right with
 * the same actions its record carries. Nothing here that the record does not.
 */
function ChatView({ chat, screen, rows, onOpen }: { chat: NonNullable<ListSpec["chat"]>; screen: string; rows: ListRow[]; onOpen: (id: string) => void }) {
  const ui = useErpUi();
  const who = (r: ListRow) => String(r.v[chat.who] ?? r.title ?? "—");
  const people = [...new Set(rows.map(who))];
  const [pick, setPick] = useState<{ who: string; id: string | null }>({ who: people[0] ?? "", id: null });
  const current = people.includes(pick.who) ? pick.who : (people[0] ?? "");
  const thread = rows.filter((r) => who(r) === current).slice().reverse();
  const msg = thread.find((r) => r.id === pick.id) ?? thread[thread.length - 1];
  const initials = (n: string) =>
    n
      .split(/\s+/)
      .filter((w) => /^[A-Za-z]/.test(w))
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <div className="grid h-[min(640px,72vh)] grid-cols-1 overflow-hidden md:grid-cols-[minmax(220px,290px)_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)_300px]">
      <div className="overflow-y-auto border-r border-divider">
        {people.map((p) => {
          const mine = rows.filter((r) => who(r) === p);
          const waiting = mine.filter((r) => r.flags.includes("requested")).length;
          const last = mine[0];
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPick({ who: p, id: null })}
              className={cx("flex w-full cursor-pointer items-start gap-3 border-b border-divider px-3.5 py-3 text-left", p === current ? "bg-page" : "hover:bg-page")}
            >
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-hover">{initials(p)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{p}</span>
                  <span className="flex-none text-xs text-faint">{last ? cellText({ k: chat.when, l: "", t: "d" }, last.v[chat.when]) : ""}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-meta text-muted">{last ? String(last.v[chat.text] ?? "") : ""}</span>
                  {waiting ? <span className="flex h-4.5 min-w-4.5 flex-none items-center justify-center rounded-full bg-brand px-1 text-2xs font-bold text-white">{waiting}</span> : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="border-b border-divider px-4.5 py-3">
          <div className="truncate text-md font-semibold text-ink">{current}</div>
          {msg?.header ? <div className="font-mono text-xs text-faint">{msg.header}</div> : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-start gap-2.5 overflow-y-auto bg-page px-4.5 py-4">
          {thread.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setPick({ who: current, id: r.id })}
              className={cx(
                "max-w-[85%] cursor-pointer rounded-[10px] border bg-surface px-3.5 py-2.5 text-left",
                r.id === msg?.id ? "border-brand ring-3 ring-brand-soft" : "border-line hover:border-line-strong",
              )}
            >
              <span className="block text-sm whitespace-pre-wrap text-ink">{String(r.v[chat.text] ?? "")}</span>
              <span className="mt-1 flex items-center justify-end gap-2 text-xs text-faint">
                {String(r.v[chat.via] ?? "")} · {cellText({ k: chat.when, l: "", t: "d" }, r.v[chat.when])}
                {r.v.status ? <StatusBadge value={r.v.status} /> : null}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="hidden min-h-0 flex-col border-l border-divider xl:flex">
        <div className="border-b border-divider px-4.5 py-3 text-md font-semibold text-ink">Draft order</div>
        {msg ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-divider px-4.5 py-3">
              <span className="truncate text-sm font-semibold text-ink">{msg.title ?? current}</span>
              {msg.v.status ? <StatusBadge value={msg.v.status} /> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {(msg.fields ?? []).filter((f) => f.der).length ? (
                (msg.fields ?? [])
                  .filter((f) => f.der)
                  .map((f) => (
                    <div key={f.l} className="border-b border-divider px-4.5 py-2.5 text-meta">
                      <span className="block font-semibold text-ink">{f.v.split(" — ")[0]}</span>
                      {f.v.includes(" — ") ? <span className="block text-muted">{f.v.split(" — ").slice(1).join(" — ")}</span> : null}
                    </div>
                  ))
              ) : (
                <div className="px-4.5 py-4 text-meta text-muted">Nothing in this message was drafted as a line.</div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 border-t border-divider px-4.5 py-3">
              <Button variant="secondary" onClick={() => onOpen(msg.id)}>
                Open
              </Button>
              {(msg.actions ?? []).map((a) => (
                <Button key={a.id} variant={a.primary ? "primary" : "secondary"} disabled={!!a.why} title={a.why || undefined} onClick={() => ui.act(screen, a, msg.id)} className={a.primary ? "flex-1" : undefined}>
                  {a.l}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
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
  const { flags: FLAG, place, exportList, listIds, listCount, listTotals, loadForm, tones, look } = useKit();
  const v4 = look === "v4";
  const [asTable, setAsTable] = useState(false);
  const showCards = !!spec.cards && !(spec.cards.toggle && asTable);
  const showChat = v4 && !!spec.chat && !asTable;
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [local, setLocal] = useState<ListQuery>({ q: "", chip: "", gf: "", grp: true, sort: null, page: 1, size: 25, ids: filter?.ids ?? null, pd: "", parts: false, fx: {}, cf: {} });
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
    const shape = (form: FormSpec): FormSpec => {
      const known = new Set(form.header.map((f) => f.k));
      const given = Object.fromEntries(Object.entries(preset ?? {}).filter(([k]) => known.has(k)));
      return preset ? { ...form, init: { ...form.init, ...given } } : form;
    };
    if (spec.newForm) return ui.openForm(shape(spec.newForm));
    if (!spec.newFormLazy) return;
    ui.askForm(spec.newLabel ?? "New", () => askNew().finally(() => (newAsk.current = null)), shape);
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
     on a wider screen the extra columns arrive with the measurement.
     A search that finds nothing takes the table out of the page, and the
     table that comes back is a new element: watched through an effect, the
     observer stayed on the removed one — whose last width was 0 — so every
     list read one column wide until reloaded. A callback ref watches
     whichever table is mounted, and a width of 0 (a table leaving the page,
     a hidden tab) is never taken as the card's width. */
  const [avail, setAvail] = useState(760);
  const tableObserver = useRef<ResizeObserver | null>(null);
  const tableBox = useCallback((el: HTMLDivElement | null) => {
    tableObserver.current?.disconnect();
    tableObserver.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width);
      if (w > 0) setAvail(w);
    });
    ro.observe(el);
    tableObserver.current = ro;
  }, []);
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
  const [printing, setPrinting] = useState<string[] | null>(null);
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => sel[r.id]);
  const bulkOn = !!spec.bulk?.length;
  /* A row carries a checkbox where something can be done with a selection —
     a bulk action, or only reading what the ticked rows add up to. */
  const sumOn = !!spec.selectSum?.length;
  const selectOn = bulkOn || sumOn;
  /* Columns that are facts about the group are drawn once in its header while
     grouped, so the rows carry only what differs from line to line. */
  const headCols = gk && spec.groupHead ? spec.groupHead.map((k) => cols.find((c) => c.k === k)).filter((c): c is ColSpec => !!c) : [];
  /* With one godown open there is nothing for the header to tell apart, so it does not say it on every group. */
  const headShown = headCols.filter((c) => !(c.k === spec.godownKey && godowns.length <= 1));
  /* The group's own key is the header's first word, so while grouped its rows
     do not repeat it — a godown column reading "Bhiwandi" fourteen times under
     a header that says Bhiwandi is noise. */
  const lineCols = gk ? cols.filter((c) => !headCols.includes(c) && !gk.includes(c.k)) : cols;
  /* The longest badge each status and flags column will draw, over every row rather than this page, so widths hold still from page to page. */
  const badgeChars = lp.badgeChars;
  /* A row's ⋯ menu takes a narrow column of its own at the end. */
  const menuIds = spec.rowMenu ?? [];
  const menuOn = menuIds.length > 0;
  const fit = fitColumns({ cols: lineCols, avail: menuOn ? Math.max(0, avail - MENU_COL) : avail, check: selectOn, chosen: chosenCols, badgeChars, headExtra: 0 });
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

  /* WHAT THE TICKED ROWS ADD UP TO. Added up here while every ticked row is in
     the browser — a whole list, or a paged one ticked on this page — and asked
     of the server once a tick reaches past the page ("Select all", an order's
     "Select all"), because only the server holds those rows. */
  const chosenKey = chosen.slice().sort().join(",");
  const heldRows = server ? pageRows : rows;
  const heldIds = new Set(heldRows.flatMap((r) => [r.id, ...(r.sub ?? []).map((x) => x.id)]));
  /* Only what the ticked rows can take: a row's own actions say what applies to it. */
  const offers = bulkOffers(spec.bulk ?? [], heldRows, chosen);
  const allHeld = chosen.every((id) => heldIds.has(id));
  const localSum = sumOn && chosen.length > 0 && allHeld ? selectionTotals(spec, heldRows, chosen) : null;
  const needRemote = sumOn && chosen.length > 0 && !allHeld && !!server && !!listTotals;
  const queryKey = server ? JSON.stringify(listQueryParamsWithIds(query)) : "";
  const [remoteSum, setRemoteSum] = useState<{ key: string; counted: number; totals: SelectionTotal[] } | null>(null);
  useEffect(() => {
    if (!needRemote || !listTotals) return;
    let gone = false;
    const t = setTimeout(async () => {
      const res = await listTotals(spec.screen, JSON.parse(queryKey) as Record<string, string>, chosenKey.split(","));
      if (!gone && res.ok) setRemoteSum({ key: chosenKey, ...res.data });
    }, 250);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [needRemote, listTotals, spec.screen, queryKey, chosenKey]);
  const shownSum = localSum ?? (remoteSum && remoteSum.key === chosenKey ? remoteSum : null);
  const sumText = shownSum
    ? [
        ...shownSum.totals.map(selectionTotalText),
        ...(shownSum.counted < chosen.length ? [`${nf(chosen.length - shownSum.counted)} not in this period`] : []),
      ].join(" · ")
    : "Adding up…";

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
    if (server) go({ ...server.query, q: "", chip: "", gf: "", fx: {}, cf: {}, flag: "", page: 1, ids: null }, (p) => (p.delete("f"), p.delete("fl")));
    else {
      setLocal((l) => ({ ...l, q: "", chip: "", gf: "", fx: {}, cf: {}, flag: "", page: 1 }));
      if (filter) router.replace(home);
    }
  };
  /* "Nothing here yet. Entries appear as …" reads as a heading and the
     sentence that explains it, not as one bold paragraph. */
  const [emptyTitle] = splitFirstSentence(spec.noDataLine ?? "Nothing here yet.");
  /* A register read through a window: the period picker, and what to say when the period is empty or too long. */
  const win = server?.window ?? null;
  const pickCf = (k: string, f: ColFilter | null) => {
    const cf = { ...(query.cf ?? {}) };
    if (f) cf[k] = f;
    else delete cf[k];
    setQuery({ cf, page: 1 });
  };
  /* WHAT IS ON, IN SIGHT: a chip per filter the pop-up applied, the godown
     and a figure card tapped — each with its ×, and one Clear all. A narrowing
     hidden inside a pop-up is one somebody forgets they set. */
  const godownLabel = (v: string) => godowns.find((g) => g.v === v)?.l ?? v;
  const cfText = (k: string, f: ColFilter) => {
    const c = colOf(k);
    const blank = (v: string) => (v === "—" || v === "" ? "(Blank)" : v);
    const num = (v: number) => (c.t === "m" ? moneyText(c, v) : `${nf(v)}${c.u ? ` ${c.u}` : ""}`);
    return f.in
      ? f.in.length === 0
        ? "nothing"
        : `${blank(f.in[0])}${f.in.length > 1 ? ` + ${nf(f.in.length - 1)}` : ""}`
      : f.min != null && f.max != null
        ? `${num(f.min)} – ${num(f.max)}`
        : f.min != null
          ? `${num(f.min)} or more`
          : `up to ${num(f.max ?? 0)}`;
  };
  const statOf = (flag: string) => (lp.stats ?? []).find((x) => x.pick && "flag" in x.pick && x.pick.flag === flag)?.l;
  const onChips: { key: string; l: string; text: string; off: () => void }[] = [
    ...(gf ? [{ key: "gf", l: place.one.replace(/^./, (x) => x.toUpperCase()), text: godownLabel(gf), off: () => setQuery({ gf: "", page: 1 }) }] : []),
    ...Object.entries(query.fx)
      .filter(([k]) => !query.cf?.[k])
      .map(([k, v]) => ({ key: `fx:${k}`, l: colOf(k).l, text: v, off: () => pickFx(k, "") })),
    ...Object.entries(query.cf ?? {}).map(([k, f]) => ({ key: `cf:${k}`, l: colOf(k).l, text: cfText(k, f), off: () => pickCf(k, null) })),
    ...(query.flag ? [{ key: "flag", l: "Only", text: statOf(query.flag) ?? FLAG[query.flag]?.[0] ?? query.flag, off: () => setQuery({ flag: "", page: 1 }) }] : []),
  ];
  const cfRow = onChips.length ? (
    <div className={cx("flex flex-wrap items-center gap-1.5", v4 ? "mb-3" : "border-b border-divider px-4 py-2.5")}>
      {onChips.map((c) => (
        <span key={c.key} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-brand-softer bg-brand-soft pr-1 pl-3 text-xs text-brand-deep">
          <span className="text-brand-hover">{c.l}</span>
          <span className="max-w-[240px] truncate font-semibold">{c.text}</span>
          <button type="button" onClick={c.off} aria-label={`Remove the ${c.l} filter`} className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-brand-hover hover:bg-brand-softer">
            <ShellIcon name="close" size={12} />
          </button>
        </span>
      ))}
      <LinkButton onClick={() => setQuery({ cf: {}, fx: {}, gf: "", flag: "", page: 1 })}>Clear all</LinkButton>
    </div>
  ) : null;
  const pickFx = (k: string, v: string) => {
    const fx = { ...query.fx };
    if (v) fx[k] = v;
    else delete fx[k];
    setQuery({ fx, page: 1 });
  };
  /* A figure card tapped is the filter it stands for; tapped again, it lets go. */
  const pickStat = (p: StatPick) => {
    if ("chip" in p) return pickChip(query.chip === p.chip ? "" : p.chip);
    if ("flag" in p) return setQuery({ flag: query.flag === p.flag ? "" : p.flag, page: 1 });
    const cur = query.cf?.[p.k]?.in;
    pickCf(p.k, cur && cur.length === 1 && cur[0] === p.v ? null : { in: [p.v] });
  };
  /* What a draft in the pop-up would leave, before Apply: the server's count for a paged list, this one's for a whole one. */
  const queryNow = JSON.stringify(query);
  const countDraft = useCallback(
    async (cf: Record<string, ColFilter>, g: string) => {
      const next: ListQuery = { ...(JSON.parse(queryNow) as ListQuery), cf, fx: {}, gf: g, page: 1 };
      if (!server) return { n: queryRows(spec, rows, next, FLAG).list.length, of: rows.length };
      if (!listCount) return null;
      const res = await listCount(spec.screen, listQueryParamsWithIds(next));
      return res.ok ? res.data : null;
    },
    [queryNow, server, spec, rows, FLAG, listCount],
  );
  const pickChip = (v: string) => setQuery({ chip: v, page: 1 });

  const sortBy = (k: string) => {
    const on = view.srt && view.srt.k === k;
    setQuery({ sort: { k, d: on && view.srt!.d > 0 ? -1 : 1 } });
  };

  /* v4: the record's stage bar runs over this list's own status values, in
     the order the status vocabulary lists them — its lifecycle order. */
  const toneOrder = Object.keys(tones);
  const rank = (v: string) => {
    const i = toneOrder.indexOf(v);
    return i < 0 ? toneOrder.length : i;
  };
  const stages = spec.chips && chips.length >= 2 ? { key: spec.chips, values: chips.map((c) => c.v).sort((a, b) => rank(a) - rank(b)).slice(0, 7) } : undefined;

  const toolbar =
    lp.all > 0 || filter || win ? (
        <div className={cx("flex flex-wrap items-center gap-2.5", v4 ? "mb-3" : "border-b border-divider px-4 py-3")}>
          <div className="relative w-[300px] max-w-full">
            <ShellIcon name="search" size={16} className="pointer-events-none absolute top-2.25 left-2.5 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search this list" className="pr-7 pl-7.5" />
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
          <FilterPanel
            sections={lp.panel ?? []}
            cf={query.cf ?? {}}
            fx={query.fx}
            gf={gf}
            godowns={spec.godownKey ? godowns : null}
            placeOne={place.one}
            placeMany={place.many}
            count={countDraft}
            onApply={(cf, g) => setQuery({ cf, fx: {}, gf: g, page: 1 })}
          />
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

          {filter ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-brand bg-brand-soft pr-1 pl-2.5 text-meta font-medium text-brand-hover">
              From dashboard · {filter.label}
              <button onClick={() => (server ? go({ ...server.query, ids: null, page: 1 }, (p) => (p.delete("f"), p.delete("fl"))) : router.replace(home))} aria-label="Remove filter" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-control hover:bg-brand-softer">
                <ShellIcon name="close" size={14} />
              </button>
            </span>
          ) : null}
          <span className="flex-1" />
          {spec.cards?.toggle || (v4 && spec.chat) ? (
            <span role="group" aria-label="Show as" className="flex gap-0.5 rounded-[7px] bg-divider p-0.5">
              {[
                { v: false, l: spec.chat ? "Chat" : "Cards" },
                { v: true, l: "Table" },
              ].map((o) => (
                <button
                  key={o.l}
                  type="button"
                  aria-pressed={asTable === o.v}
                  onClick={() => setAsTable(o.v)}
                  className={cx("cursor-pointer rounded-[5px] px-2.5 py-1 text-meta", asTable === o.v ? "bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(20,20,30,0.08)]" : "font-medium text-muted hover:text-ink")}
                >
                  {o.l}
                </button>
              ))}
            </span>
          ) : null}
          {spec.groups ? (
            <button
              type="button"
              onClick={() => setQuery({ grp: !query.grp, page: 1 })}
              aria-pressed={!!gk}
              aria-label={`Group by ${spec.groups.map((k) => lowerFirst(colOf(k).l)).join(" · ")}`}
              title={`Group by ${spec.groups.map((k) => lowerFirst(colOf(k).l)).join(" · ")}`}
              className={cx(toolbarToggleClass(!!gk), "px-2")}
            >
              <Icon n="group" s={15} />
            </button>
          ) : null}
          {!showCards && !showChat && cols.length > 1 ? <ColumnsMenu cols={lineCols} fit={fit} chosen={chosenCols} onChoose={setChosenCols} /> : null}
          {spec.hidden.length ? (
            <span className="flex items-center gap-1 text-meta text-muted tabular-nums" title={`Not on your account: ${spec.hidden.map((x) => x.l).join(", ")}`}>
              <Icon n="lock" s={14} />
              {spec.hidden.length}
              <span className="sr-only"> column{spec.hidden.length > 1 ? "s" : ""} hidden</span>
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
            <IconButton label="Export as CSV" bordered onClick={exportCsv} className="h-9 w-9">
              <Icon n="dl" />
            </IconButton>
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
      {/* The figure cards: the server's, over every row the filters reach, and
          the status values — where there are a handful — as one Breakdown card. */}
      {(() => {
        const stats = lp.stats ?? [];
        const breakdown = v4 && chips.length >= 2 && chips.length <= MAX_TABS ? { total: lp.beforeChip, chips, value: chip, tones, onPick: pickChip } : null;
        /* A lone Total is the pager's number again, not a figure worth a card. */
        const worth = stats.length > 1 || (stats.length === 1 && !!breakdown) || stats.some((x) => x.l !== "Total");
        return lp.all > 0 && worth ? <StatRow stats={stats} filtered={!!lp.filtered} breakdown={breakdown} onPick={pickStat} /> : null;
      })()}
      {v4 ? toolbar : null}
      {v4 ? cfRow : null}

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
        {v4 ? null : cfRow}

        {spec.fold?.note && !query.parts && lp.all > 0 ? <div className="border-b border-divider px-4 py-2 text-meta text-muted">{spec.fold.note}</div> : null}

        {spec.scopedLine ? <div className="border-b border-divider bg-brand-soft/40 px-4 py-2 text-meta text-brand-hover">{spec.scopedLine}</div> : null}

        {win?.tooWide ? (
          <EmptyState
            icon={v4 ? <EmptyTile tone="warn" icon="lock" /> : undefined}
            title="That period is too long to show"
            body={`${nf(win.tooWide.n)} rows. Pick a shorter period.`}
          />
        ) : lp.all === 0 && win ? (
          <EmptyState icon={v4 ? <EmptyTile icon="search" /> : undefined} title={`Nothing in ${lowerFirst(win.label)}`} />
        ) : lp.all === 0 ? (
          <EmptyState
            icon={v4 ? <EmptyTile icon="file" /> : undefined}
            title={emptyTitle}
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
            icon={v4 ? <EmptyTile tone="muted" icon="search" /> : undefined}
            title="Nothing matches"
            action={
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className={cx("transition-opacity", pending && "pointer-events-none opacity-60")} aria-busy={pending || undefined}>
            {showChat && spec.chat ? (
              <ChatView chat={spec.chat} screen={spec.screen} rows={pageRows} onOpen={setOpenId} />
            ) : showCards && spec.cards ? (
              <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {pageRows.map((r) => {
                  const src = String(r.v[spec.cards!.img] ?? "");
                  return (
                    <button
                      key={r.id}
                      onClick={() => setOpenId(r.id)}
                      className={cx("flex cursor-pointer flex-col overflow-hidden border border-line bg-surface text-left hover:border-brand", v4 ? "rounded-[10px]" : "rounded-card")}
                    >
                      <span className={cx("flex items-center justify-center", spec.cards!.play ? "aspect-video bg-ink" : "aspect-[3/2] bg-canvas")}>
                        {spec.cards!.play && !src ? (
                          <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-lime text-ink">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M7 4v16l13-8z" />
                            </svg>
                          </span>
                        ) : src ? (
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
              {/* A person's own pick may be wider than the card: drawn whole, it scrolls sideways (`fit-columns.ts`). */}
              <table className="w-full table-fixed" style={{ minWidth: fit.total + (menuOn ? MENU_COL : 0) }}>
                <colgroup>
                  {selectOn ? <col style={{ width: CHECK_COL }} /> : null}
                  {shownCols.map((c) => (
                    <col key={c.k} style={{ width: fit.widths[c.k] }} />
                  ))}
                  {menuOn ? <col style={{ width: MENU_COL }} /> : null}
                </colgroup>
                <thead>
                  <tr>
                    {selectOn ? (
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
                          const grp = lp.groups[g] ?? { n: 0, agg: [], ids: [], head: {} };
                          let aggText = `${nf(grp.n)} ${grp.n === 1 ? "row" : "rows"}`;
                          aggsOf(spec.agg).forEach((a, i) => {
                            const got = grp.agg[i];
                            if (got == null) return;
                            aggText += ` · ${colOf(a.k).t === "m" ? moneyText(colOf(a.k), got.v) : nf(got.v)} ${a.l}`;
                            if (got.missing) aggText += ` (${nf(got.missing)} ${got.missing === 1 ? "row" : "rows"} ${a.missing})`;
                          });
                          const allSel = grp.ids.every((id) => sel[id]);
                          out.push(
                            <Tr key={`g:${g}`} className="bg-canvas">
                              <Td colSpan={shownCols.length + (selectOn ? 1 : 0) + (menuOn ? 1 : 0)} className="py-2 whitespace-normal">
                                <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                                  <span className={eyebrowClass}>{gk.map((k) => colOf(k).l).join(" · ")}</span>
                                  <span className="text-meta font-semibold text-ink">{g || "—"}</span>
                                  {headShown.map((c) => {
                                    const same = spec.groupHeadUnlessSame?.[c.k];
                                    if (same && grp.head[c.k] != null && String(grp.head[c.k]) === String(grp.head[same] ?? "")) return null;
                                    return <GroupFact key={c.k} c={c} v={grp.head[c.k]} strong={spec.groupHeadStrong?.includes(c.k)} />;
                                  })}
                                  <span className={cx("text-xs text-muted", headShown.length > 0 && "ml-auto")}>{aggText}</span>
                                  {spec.groupInvoice ? <InvoiceButtons v={grp.head[spec.groupInvoice]} row={r} screen={spec.screen} /> : null}
                                  {spec.groupPrint && grp.print ? (
                                    <NavLink
                                      href={grp.print}
                                      title={`${spec.groupPrint.l} · ${g || "—"}`}
                                      onClick={(e) => e.stopPropagation()}
                                      className={cx(
                                        "inline-flex h-8 items-center justify-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-meta font-medium text-body hover:bg-canvas",
                                        headShown.length === 0 && "ml-auto",
                                      )}
                                    >
                                      <Icon n="print" s={15} />
                                      {spec.groupPrint.l}
                                    </NavLink>
                                  ) : null}
                                  {spec.groupSel && selectOn ? (
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
                          {selectOn ? (
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
                              edge={!selectOn && i === 0 && tone ? EDGE[tone] : undefined}
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
                              {selectOn ? <Td /> : null}
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
                look={v4 ? "v4" : undefined}
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

      {selectOn ? (
        <SelectionBar count={chosen.length} onClear={() => setSel({})}>
          {sumOn ? (
            <>
              <span className="text-meta font-semibold whitespace-nowrap tabular-nums" aria-live="polite">
                {sumText}
              </span>
              <span className="h-[18px] w-px bg-body" />
            </>
          ) : null}
          {/* The header box takes this page; this takes everything the
              search, chips and godown filter leave, across every page. */}
          {chosen.length < total ? (
            <button
              onClick={selectAll}
              className={cx(
                "cursor-pointer text-meta whitespace-nowrap underline-offset-2 hover:underline",
                v4 ? "font-semibold text-brand-lime" : "text-line-strong hover:text-white",
              )}
            >
              Select all {nf(total)}
            </button>
          ) : null}
          {offers.map(({ b, label }) => (
            <Button key={b.id} variant="dark" size="sm" onClick={() => (b.client === "printInvoices" ? setPrinting(chosen) : ui.bulk(spec.screen, b, chosen, () => setSel({})))}>
              {label}
            </Button>
          ))}
          {bulkOn && chosen.length > 0 && !offers.length ? (
            <span className="text-meta whitespace-nowrap text-line-strong">Nothing can be done to {chosen.length === 1 ? "this row" : "these rows"} from here — open one to see why</span>
          ) : null}
        </SelectionBar>
      ) : null}

      {printing ? <PrintInvoicesModal lineIds={printing} onClose={() => setPrinting(null)} /> : null}
      {open ? <RecordDialog key={open.id} screen={spec} kind={label} row={open} onClose={closeRec} stages={v4 ? stages : undefined} /> : null}
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

function GroupFact({ c, v, strong }: { c: ColSpec; v: ListRow["v"][string] | undefined; strong?: boolean }) {
  const text = cellText(c, v);
  if (v == null || text === "" || text === "—") return null;
  if (c.t === "s") return <StatusBadge value={String(v)} />;
  if (c.t === "b") return <span className="text-meta font-semibold text-ink">{text}</span>;
  return (
    <span className="text-xs text-muted">
      {c.l} <span className={cx(strong ? "text-meta font-semibold text-ink" : "text-body", c.t === "mono" && "font-mono")}>{text}</span>
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
     value goes to the next line (globals.css), and badges that do not fit are
     clipped rather than pushing the row wider. */
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
