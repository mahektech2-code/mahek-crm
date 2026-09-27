"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  addNoteAction,
  askAction,
  clearMarkAction,
  figureAction,
  handOnAction,
  optionsAction,
  quickFormAction,
  quickRunAction,
  recordAction,
  runAction,
  searchAction,
  snoozeAction,
  tablePageAction,
  viewAsAction,
} from "./actions";
import { C, DesignStyles, EASE, Hov, Icon, PILL, Pulse, upper } from "./ui";
import { addDays } from "@/lib/format";
import { AppSwitcher } from "@/components/shell/app-switcher";
import type { AppDefinition } from "@/lib/apps";

/** 1 = Monday … 7 = Sunday, for a YYYY-MM-DD calendar date (Sakamoto). */
function isoWeekdayOf(iso: string): number {
  const y0 = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const T = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = m < 3 ? y0 - 1 : y0;
  const dow = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + T[m - 1]! + d) % 7; // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

function firstOfNextMonth(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
import type {
  ActSpec,
  Bar,
  CompanyPayload,
  FieldSpec,
  FigureDrawer,
  FormSpec,
  InboxItem,
  RecordView,
  Result,
  Row,
  SearchHit,
  SectionKey,
  SectionPayload,
  ShellData,
  Table,
  TablePage,
  ViewAs,
} from "@/lib/command-centre/types";

/* ---------------------------------------------------------------------------
 * THE FOUNDER COMMAND CENTRE — the Claude Design file "Founder Command
 * Centre.dc.html", drawn exactly, over real data.
 *
 * Every string, style and behaviour below is the design's. What the design
 * held as sample constants (COUNTS, FIGS, INBOX, SECTIONS…) arrives here from
 * the server, read from the owning apps; every button calls a server action
 * that runs the owning app's own function.
 * ------------------------------------------------------------------------- */

const NAV: { label: string; items: [SectionKey, string, string][] }[] = [
  { label: "Today", items: [["company", "Company", "home"], ["inbox", "Needs you", "bell"]] },
  {
    label: "Sell",
    items: [
      ["sales", "Sales & order book", "chart"],
      ["team", "Targets & performance", "people"],
      ["customers", "Customers", "store"],
      ["leads", "Leads, samples & distributors", "funnel"],
      ["enquiries", "Website enquiries", "globe"],
    ],
  },
  {
    label: "Operate",
    items: [
      ["calling", "Calling operations", "call"],
      ["field", "Field force", "pin"],
      ["service", "Service", "chat"],
      ["money", "Money", "money"],
    ],
  },
  { label: "Founder desks", items: [["prices", "Price lists", "tag"], ["whatsapp", "WhatsApp", "msg"]] },
  { label: "Organisation", items: [["people", "People & organisation", "id"], ["system", "Data operations & health", "pulse"]] },
];

const TITLES: Record<SectionKey, [string, string]> = {
  company: ["Company", "The headline for the period, a pulse across every section, and what needs you"],
  inbox: ["Needs you", "Every decision waiting on you, every alarm, and what you handed on"],
  sales: ["Sales & order book", "Every order from every source, and deciding them"],
  team: ["Targets & performance", "Setting and revising targets; everyone scored, ranked and explained"],
  customers: ["Customers", "Every customer and lead, the full record, and every change to an account"],
  leads: ["Leads, samples & distributors", "The three ladders, gates, samples and distributor appointments"],
  enquiries: ["Website enquiries", "The enquiries desk end to end"],
  calling: ["Calling operations", "The telecallers’ day: queues, calls, reminders, EOD and the call assistant"],
  field: ["Field force", "Where they are, attendance, visits, travel, expenses, leave and devices"],
  service: ["Service", "Complaints end to end"],
  money: ["Money", "Bills, receipts, outstanding, collections and credit notes — the whole accounts desk"],
  prices: ["Price lists", "The price-list desk end to end"],
  whatsapp: ["WhatsApp", "The switch, templates, automation, sends, replies and the tracker"],
  people: ["People & organisation", "Headcount, the employee master, reporting lines and the business calendar"],
  system: ["Data operations & health", "Every sync, import, repair and recompute, and how fresh the data is"],
};

const PERIOD_SECTIONS: SectionKey[] = ["company", "sales", "money", "customers", "leads", "service", "field", "whatsapp", "calling", "enquiries"];

const KIND: Record<string, [string, string]> = {
  Period: [C.brandTint, C.brandDark],
  Month: [C.blueTint, C.blue],
  Now: [C.soft, C.body],
};

const TONE: Record<string, [string, string, string]> = {
  bad: [C.bad, C.badTint, C.badTint],
  warn: [C.warn, C.warnTint, C.warnLine],
  good: [C.good, C.goodTint, C.goodTint],
  info: [C.brandDark, C.brandTint, C.brandTint2],
  muted: [C.muted, C.soft, C.soft],
};

const SEV: Record<string, [string, string]> = {
  Urgent: [C.bad, C.badTint],
  Soon: [C.warn, C.warnTint],
  Watch: [C.muted, C.soft],
};

type FormState = {
  spec: FormSpec;
  values: Record<string, string>;
  errors: Record<string, string>;
  busy: boolean;
  submit: (values: Record<string, string>) => Promise<Result>;
  onDone?: (r: Result) => void;
};

type Props = {
  section: SectionKey;
  shell: ShellData;
  canAct: boolean;
  /** Every web app this person opens, for the switcher every MahekOne header carries. Null with one app. */
  switcherApps: AppDefinition[] | null;
  company: CompanyPayload | null;
  payload: SectionPayload | null;
  quickItems: [string, string][];
  askSuggestions: string[];
};

export function CommandCentre({ section, shell, canAct, switcherApps, company, payload, quickItems, askSuggestions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const period = shell.period;
  const periodIn = React.useMemo(() => ({ key: period.key, from: period.from, to: period.to }), [period]);

  /* ---------------------------------------------------------------- toast */
  const [toast, setToast] = React.useState("");
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = React.useCallback((t: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  /* ----------------------------------------------------------- navigation */
  const href = React.useCallback(
    (s: SectionKey, p?: { key: string; from?: string; to?: string }) => {
      const pp = p ?? periodIn;
      const q = new URLSearchParams();
      if (s !== "company") q.set("s", s);
      if (pp.key !== "month") q.set("p", pp.key);
      if (pp.key === "custom") {
        if (pp.from) q.set("from", pp.from);
        if (pp.to) q.set("to", pp.to);
      }
      const qs = q.toString();
      return `/founder${qs ? `?${qs}` : ""}`;
    },
    [periodIn],
  );
  const go = React.useCallback((s: SectionKey) => startTransition(() => router.push(href(s))), [router, href]);

  /* -------------------------------------------------------------- overlays */
  const [drawer, setDrawer] = React.useState<{ loading: boolean; data: FigureDrawer | null; error?: string } | null>(null);
  const [rec, setRec] = React.useState<{ loading: boolean; data: RecordView | null; error?: string; ref: { section: SectionKey; table: string; id: string; subject: string } } | null>(null);
  const [confirm, setConfirm] = React.useState<{ title: string; body: string; label: string; danger: boolean; run: () => void } | null>(null);
  const [form, setForm] = React.useState<FormState | null>(null);
  const [askOpen, setAskOpen] = React.useState(false);
  const [askQ, setAskQ] = React.useState("");
  const [askThread, setAskThread] = React.useState<{ me: boolean; text: string; go?: SectionKey; goLabel?: string }[]>([]);
  const [asking, setAsking] = React.useState(false);
  const [viewAs, setViewAs] = React.useState<{ name: string; loading: boolean; data: ViewAs | null; error?: string } | null>(null);
  const [qa, setQa] = React.useState(false);
  const [done, setDone] = React.useState<Record<string, string>>({});
  const [inboxTab, setInboxTab] = React.useState("all");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirm) setConfirm(null);
      else if (form) setForm(null);
      else if (drawer) setDrawer(null);
      else if (rec) setRec(null);
      else if (viewAs) setViewAs(null);
      else if (askOpen) setAskOpen(false);
      else if (qa) setQa(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, form, drawer, rec, viewAs, askOpen, qa]);

  const openForm = React.useCallback((spec: FormSpec, submit: FormState["submit"], onDone?: FormState["onDone"]) => {
    setQa(false);
    setForm({ spec, values: { ...(spec.init ?? {}) }, errors: {}, busy: false, submit, onDone });
  }, []);

  /* ------------------------------------------------------------- figures */
  const openFigure = React.useCallback(
    async (s: SectionKey, key: string) => {
      setDrawer({ loading: true, data: null });
      const r = await figureAction(s, key, periodIn);
      setDrawer(r.ok ? { loading: false, data: r.data } : { loading: false, data: null, error: r.error });
    },
    [periodIn],
  );

  /* ------------------------------------------------------------- records */
  const openRecord = React.useCallback(
    async (s: SectionKey, table: string, id: string, subject: string) => {
      setRec({ loading: true, data: null, ref: { section: s, table, id, subject } });
      const r = await recordAction(s, table, id, periodIn);
      setRec({ loading: false, data: r.ok ? r.data : null, error: r.ok ? undefined : r.error, ref: { section: s, table, id, subject } });
    },
    [periodIn],
  );

  /* ------------------------------------------------------------- actions */
  const openViewAs = React.useCallback(async (s: SectionKey, id: string, name: string) => {
    setViewAs({ name, loading: true, data: null });
    const r = await viewAsAction(s, id);
    setViewAs(r.ok ? { name, loading: false, data: r.data } : { name, loading: false, data: null, error: r.error });
  }, []);

  const runAct = React.useCallback(
    (s: SectionKey, table: string, a: ActSpec, id: string, subject: string) => {
      const key = `${s}:${table}:${id}`;
      if (a.viewAs) return void openViewAs(s, id, subject);
      if (a.href) return void router.push(a.href);
      if (!canAct) return notify("Your access here is read-only · the founder or a manager-level delegate can do this");
      const execute = async (input: Record<string, string>): Promise<Result> => {
        const r = await runAction(s, table, a.key, id, input, periodIn);
        if (r.ok) {
          setDone((d) => ({ ...d, [key]: a.done }));
          notify(`${r.message ?? `${a.done} · ${subject}`} · audited as Founder`);
          setConfirm(null);
          router.refresh();
        }
        return r;
      };
      if (a.form) {
        return openForm({ ...a.form, title: a.form.title || `${a.label} — ${subject}` }, execute);
      }
      if (!a.confirm) {
        void execute({}).then((r) => {
          if (!r.ok) notify(r.error);
        });
        return;
      }
      setConfirm({
        title: `${a.label} — ${subject}?`,
        body: a.confirm,
        label: a.label,
        danger: a.tone === "bad",
        run: () => {
          void execute({}).then((r) => {
            if (!r.ok) {
              setConfirm(null);
              notify(r.error);
            }
          });
        },
      });
    },
    [canAct, notify, openForm, openViewAs, periodIn, router],
  );

  /* ---------------------------------------------------------- global search */
  const [gq, setGq] = React.useState("");
  const [gResults, setGResults] = React.useState<SearchHit[]>([]);
  React.useEffect(() => {
    const q = gq.trim();
    if (q.length < 2) return;
    let live = true;
    const t = setTimeout(async () => {
      const hits = await searchAction(q);
      if (live) setGResults(hits);
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [gq]);

  /* ---------------------------------------------------------- quick actions */
  const runQuick = React.useCallback(
    async (index: number) => {
      setQa(false);
      const r = await quickFormAction(index, periodIn);
      if (!r.ok) return notify(r.error);
      openForm(r.data, async (values) => {
        const out = await quickRunAction(index, values, periodIn);
        if (out.ok) {
          notify(`${out.message ?? "Done"} · audited as Founder`);
          router.refresh();
        }
        return out;
      });
    },
    [notify, openForm, periodIn, router],
  );

  /* ------------------------------------------------------------------- ask */
  const doAsk = React.useCallback(
    async (q: string) => {
      setAskQ("");
      setAskThread((t) => [...t, { me: true, text: q }]);
      setAsking(true);
      const r = await askAction(q, periodIn);
      setAsking(false);
      setAskThread((t) => [...t, r.ok ? { me: false, text: r.data.text, go: r.data.go, goLabel: r.data.goLabel } : { me: false, text: r.error }]);
    },
    [periodIn],
  );

  /* -------------------------------------------------------------- the inbox */
  const inbox = shell.inbox;
  const live = inbox.filter((i) => !i.handed && !i.snoozed);
  const urgent = live.filter((i) => i.sev === "Urgent");

  const T = TITLES[section];
  const crumb = section === "company" ? "Command Centre" : `Command Centre · ${NAV.find((g) => g.items.some((i) => i[0] === section))?.label ?? ""}`;
  const periodView = period.views.find((v) => v.key === period.key) ?? period.views[2]!;

  return (
    <div className="fcc-root" style={{ position: "fixed", inset: 0, overflowX: "auto", overflowY: "hidden", zIndex: 1 }}>
      <DesignStyles />
      <div style={{ height: "100vh", minWidth: 1100, display: "flex", flexDirection: "column", overflow: "hidden", background: C.canvas }}>
        {/* ------------------------------------------------------------ header */}
        <header
          style={{ height: 56, flex: "none", position: "relative", zIndex: 3, background: C.white, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 16, padding: "0 24px" }}
        >
          {switcherApps ? (
            <span style={{ display: "flex", alignItems: "center", flex: "none", marginRight: -4 }}>
              <AppSwitcher apps={switcherApps} current="founder" />
            </span>
          ) : null}
          <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
            <span style={{ width: 16, height: 16, background: C.brand, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
              <span style={{ width: 6, height: 6, background: C.lime, borderRadius: 1, display: "block" }} />
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.ink, whiteSpace: "nowrap" }}>
              MAHEK <span style={{ color: C.brand }}>COMMAND CENTRE</span>
            </span>
          </span>
          <span style={{ width: 1, height: 22, background: C.soft, flex: "none" }} />
          <span style={{ position: "relative", flex: "1 1 320px", minWidth: 160, maxWidth: 400 }}>
            <span style={{ position: "absolute", left: 10, top: 9, color: C.muted, display: "flex" }}>
              <Icon name="search" />
            </span>
            <Hov
              as="input"
              value={gq}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGq(e.target.value)}
              placeholder="Search customers, staff, price lists, orders, bills"
              style={{ width: "100%", height: 34, padding: "0 12px 0 32px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.canvas, fontSize: 14, color: C.ink }}
              focus={{ background: C.white, borderColor: C.brand }}
            />
            {gq.trim().length >= 2 && gResults.length > 0 ? (
              <div
                style={{ position: "absolute", top: 40, left: 0, right: 0, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, boxShadow: "0 8px 24px rgba(22,22,22,0.12)", overflow: "hidden", animation: `fd-fade 120ms ${EASE}` }}
              >
                {gResults.map((r) => (
                  <Hov
                    key={`${r.kind}:${r.ref.id}`}
                    onClick={() => {
                      setGq("");
                      setGResults([]);
                      void openRecord(r.ref.section, r.ref.table, r.ref.id, r.name);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", border: "none", borderTop: `1px solid ${C.canvas}`, background: C.white, cursor: "pointer", textAlign: "left" }}
                    hover={{ background: C.canvas }}
                  >
                    <span style={{ ...upper, width: 72, flex: "none" }}>{r.kind}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink }}>{r.name}</span>
                      <span style={{ display: "block", fontSize: 12, color: C.muted }}>{r.meta}</span>
                    </span>
                  </Hov>
                ))}
              </div>
            ) : gq.trim().length >= 2 && gResults.length === 0 ? null : null}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ position: "relative", flex: "none" }}>
            <Hov
              onClick={() => setQa((v) => !v)}
              style={{ height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${C.brand}`, background: C.brand, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.white, cursor: "pointer" }}
              hover={{ background: C.brandDark }}
            >
              ＋ Quick action
            </Hov>
            {qa ? (
              <div
                style={{ position: "absolute", top: 40, right: 0, width: 280, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, boxShadow: "0 8px 24px rgba(22,22,22,0.12)", padding: "6px 0", animation: `fd-fade 120ms ${EASE}` }}
              >
                <div style={{ ...upper, padding: "6px 14px" }}>Start from anywhere</div>
                {quickItems.map((q, i) => (
                  <Hov
                    key={q[0]}
                    onClick={() => void runQuick(i)}
                    style={{ display: "block", width: "100%", padding: "9px 14px", border: "none", background: C.white, cursor: "pointer", textAlign: "left" }}
                    hover={{ background: C.canvas }}
                  >
                    <span style={{ display: "block", fontSize: 14, color: C.ink }}>{q[0]}</span>
                    <span style={{ display: "block", fontSize: 12, color: C.muted }}>{q[1]}</span>
                  </Hov>
                ))}
              </div>
            ) : null}
          </span>
          <Hov
            onClick={() => setAskOpen(true)}
            style={{ height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${C.brandTint2}`, background: C.brandTint, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.brandDark, cursor: "pointer", flex: "none" }}
            hover={{ background: C.brandTint2 }}
          >
            <Icon name="spark" size={15} />
            Ask the company
          </Hov>
          <Hov
            onClick={() => go("inbox")}
            title="Needs you"
            style={{ position: "relative", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, color: C.muted, cursor: "pointer", flex: "none" }}
            hover={{ background: C.canvas, color: C.body }}
          >
            <Icon name="bell" />
            {live.length > 0 ? (
              <span style={{ position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: C.bad, color: C.white, fontSize: 11, fontWeight: 500, lineHeight: "16px", textAlign: "center" }}>
                {live.length}
              </span>
            ) : null}
          </Hov>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
            <span style={{ width: 28, height: 28, borderRadius: 4, background: C.brandTint, color: C.brandDark, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {shell.user.initials}
            </span>
            <span style={{ lineHeight: "14px" }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: C.ink, whiteSpace: "nowrap" }}>{shell.user.name}</span>
              <span style={{ ...upper, display: "block", whiteSpace: "nowrap" }}>{shell.user.hatLabel}</span>
            </span>
          </span>
        </header>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* ------------------------------------------------------------ nav */}
          <aside style={{ width: 232, flex: "none", background: C.white, borderRight: `1px solid ${C.line}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <nav style={{ flex: 1, overflowY: "auto", padding: "8px 6px 16px 6px" }}>
              {NAV.map((g) => {
                const items = g.items.filter(([k]) => shell.allowed.includes(k));
                if (!items.length) return null;
                return (
                  <div key={g.label}>
                    <div style={{ ...upper, padding: "14px 12px 6px 12px" }}>{g.label}</div>
                    {items.map(([k, label, ic]) => {
                      const on = section === k;
                      const c = shell.navCounts[k] ?? 0;
                      return (
                        <Hov
                          key={k}
                          onClick={() => go(k)}
                          title={label}
                          style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, width: "100%", height: 36, padding: "0 10px", border: "none", borderRadius: 6, background: "transparent", cursor: "pointer", fontSize: 14, textAlign: "left", color: on ? C.brandDark : C.body, fontWeight: on ? 500 : 400, marginBottom: 1 }}
                          hover={on ? undefined : { background: C.canvas }}
                        >
                          <span style={on ? { position: "absolute", inset: 0, background: C.brandTint, borderRadius: 6, borderLeft: `3px solid ${C.brand}`, display: "block" } : { display: "none" }} />
                          <span style={{ position: "relative", zIndex: 1, display: "flex", flex: "none" }}>
                            <Icon name={ic} />
                          </span>
                          <span style={{ position: "relative", zIndex: 1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                          {c > 0 ? (
                            <span
                              style={{ position: "relative", zIndex: 1, minWidth: 20, height: 18, padding: "0 6px", borderRadius: 9, fontSize: 11, fontWeight: 600, lineHeight: "18px", textAlign: "center", flex: "none", background: k === "inbox" ? C.bad : C.warnTint, color: k === "inbox" ? C.white : C.warnInk }}
                            >
                              {c}
                            </span>
                          ) : null}
                        </Hov>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
            <div style={{ flex: "none", borderTop: `1px solid ${C.soft}`, padding: "10px 12px" }}>
              <div style={upper}>Data freshness</div>
              <button
                onClick={() => (shell.allowed.includes("system") ? go("system") : undefined)}
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left" }}
              >
                <span
                  style={{ width: 7, height: 7, borderRadius: "50%", background: shell.freshness.tone === "good" ? C.good : shell.freshness.tone === "bad" ? C.bad : C.warn, display: "block", flex: "none", animation: shell.freshness.tone === "good" ? undefined : "fd-pulse 2s ease-in-out infinite" }}
                />
                <span style={{ fontSize: 13, color: C.ink }}>{shell.freshness.line}</span>
              </button>
            </div>
          </aside>

          {/* ------------------------------------------------------------ main */}
          <main style={{ flex: 1, minWidth: 0, overflowY: "auto", position: "relative" }}>
            <div style={{ position: "sticky", top: 0, zIndex: 2, background: C.canvas, borderBottom: `1px solid ${C.soft}`, padding: "16px 28px 14px 28px" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>{crumb}</div>
                  <div style={{ fontSize: 26, lineHeight: "32px", fontWeight: 600, color: C.ink, marginTop: 2 }}>{T[0]}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                    <span style={{ fontSize: 14, color: C.muted }}>{T[1]}</span>
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 8px", borderRadius: 11, background: C.white, border: `1px solid ${C.soft}`, fontSize: 12, color: C.body, whiteSpace: "nowrap" }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.good, display: "block" }} />
                      Company-wide · every customer
                    </span>
                  </div>
                </div>
                {PERIOD_SECTIONS.includes(section) ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                    <div style={{ display: "flex", gap: 2, padding: 3, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6 }}>
                      {period.views.map((p) => {
                        const on = p.key === period.key;
                        return (
                          <button
                            key={p.key}
                            onClick={() => {
                              if (p.key === "custom") {
                                openForm(
                                  {
                                    title: "Custom range",
                                    sub: "Any start and end date · compared with the equal span before it",
                                    submit: "Apply",
                                    fields: [
                                      { k: "from", label: "From", type: "date", req: true },
                                      { k: "to", label: "To", type: "date", req: true },
                                    ],
                                    init: { from: `${period.today.slice(0, 7)}-01`, to: period.today },
                                  },
                                  async (v) => {
                                    const fe: Record<string, string> = {};
                                    if (!v.from) fe.from = "From is needed";
                                    if (!v.to) fe.to = "To is needed";
                                    if (v.from && v.to && v.to < v.from) fe.to = "The end is before the start";
                                    if (Object.keys(fe).length) return { ok: false, error: "", fieldErrors: fe };
                                    startTransition(() => router.push(href(section, { key: "custom", from: v.from, to: v.to })));
                                    return { ok: true };
                                  },
                                );
                              } else {
                                startTransition(() => router.push(href(section, { key: p.key })));
                              }
                            }}
                            style={{ height: 28, padding: "0 10px", border: "none", borderRadius: 4, background: on ? C.brand : "transparent", color: on ? C.white : C.body, fontSize: 13, fontWeight: on ? 500 : 400, cursor: "pointer", whiteSpace: "nowrap" }}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 13, color: C.body }}>{periodView.dates}</div>
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ padding: "20px 28px 48px 28px", animation: `fd-fade 160ms ${EASE}`, opacity: pending ? 0.55 : 1, transition: `opacity 120ms ${EASE}` }}>
              {section === "company" && company ? (
                <CompanyView
                  company={company}
                  live={live}
                  urgent={urgent.length}
                  canSeeInbox={shell.allowed.includes("inbox")}
                  goInbox={() => go("inbox")}
                  goTeam={() => go("team")}
                  openFigure={(k) => void openFigure("company", k)}
                />
              ) : null}

              {section === "inbox" ? (
                <InboxView
                  items={inbox}
                  tab={inboxTab}
                  setTab={setInboxTab}
                  go={go}
                  handOn={(i) => {
                    if (i.handed) {
                      void clearMarkAction(i.id, "take-back").then((r) => {
                        notify(r.ok ? r.message ?? "Taken back" : r.error);
                        router.refresh();
                      });
                      return;
                    }
                    openForm(
                      {
                        title: "Hand this on",
                        sub: i.title,
                        submit: "Hand on",
                        fields: [
                          { k: "to", label: "Hand to", type: "person", search: "staff", req: true, ph: "Search staff by name" },
                          { k: "note", label: "Note for them", type: "area", ph: "Please confirm against Friday’s statement" },
                        ],
                      },
                      async (v) => {
                        const r = await handOnAction(i.id, v.to ?? "", v.note ?? "");
                        if (r.ok) {
                          notify(r.message ?? "Handed on");
                          router.refresh();
                        }
                        return r;
                      },
                    );
                  }}
                  snooze={(i) => {
                    if (i.snoozed) {
                      void clearMarkAction(i.id, "wake").then((r) => {
                        notify(r.ok ? r.message ?? "Woken" : r.error);
                        router.refresh();
                      });
                      return;
                    }
                    const t = period.today;
                    // Date arithmetic on the business date's own calendar
                    // string — `addDays` names no clock, so no zone can move it.
                    const add = (n: number) => addDays(t, n);
                    const dow = isoWeekdayOf(t);
                    const nextMonday = add(8 - dow);
                    const firstNext = firstOfNextMonth(t);
                    openForm(
                      {
                        title: "Snooze this",
                        sub: i.title,
                        submit: "Snooze",
                        consequence: "Only you stop seeing it. It returns by itself on the day you pick, and it leaves for good if its condition clears.",
                        fields: [
                          {
                            k: "until",
                            label: "Until",
                            type: "select",
                            req: true,
                            // The design's four choices, each a real date — and a
                            // day offered twice (tomorrow IS next Monday on a
                            // Sunday) is offered once, under its first name.
                            options: [
                              { v: add(1), l: "Tomorrow" },
                              { v: add(3), l: "In 3 days" },
                              { v: nextMonday, l: "Next Monday" },
                              { v: firstNext, l: `1 ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(firstNext.slice(5, 7)) - 1]}` },
                            ].filter((o, idx, all) => all.findIndex((x) => x.v === o.v) === idx),
                          },
                          { k: "why", label: "Why", type: "text", req: true, ph: "Waiting on Friday’s statement" },
                        ],
                        init: { until: add(1) },
                      },
                      async (v) => {
                        const r = await snoozeAction(i.id, v.until ?? "", v.why ?? "");
                        if (r.ok) {
                          notify(r.message ?? "Snoozed");
                          router.refresh();
                        }
                        return r;
                      },
                    );
                  }}
                />
              ) : null}

              {payload && section !== "company" && section !== "inbox" ? (
                <SectionView
                  section={section}
                  payload={payload}
                  periodIn={periodIn}
                  done={done}
                  openFigure={(k) => void openFigure(section, k)}
                  openRecord={(t, id, subject) => void openRecord(section, t, id, subject)}
                  runAct={(t, a, id, subject) => runAct(section, t, a, id, subject)}
                  onCallout={(c) => {
                    if (c.go) go(c.go);
                    else if (c.href) router.push(c.href);
                    else if (c.figure) void openFigure(section, c.figure);
                  }}
                />
              ) : null}
            </div>
          </main>
        </div>

        {/* ------------------------------------------------------------ drawer */}
        {drawer ? (
          <Overlay onClose={() => setDrawer(null)} width={560}>
            <FigureDrawerView
              d={drawer}
              close={() => setDrawer(null)}
              goSection={(s) => {
                setDrawer(null);
                go(s);
              }}
              notify={notify}
            />
          </Overlay>
        ) : null}

        {/* ------------------------------------------------------------ record */}
        {rec ? (
          <Overlay onClose={() => setRec(null)} width={600}>
            <RecordDrawer
              rec={rec}
              close={() => setRec(null)}
              addNote={() => {
                const target = rec.data?.noteTarget;
                if (!target) return;
                openForm(
                  { title: "Add a note", sub: rec.data!.title, submit: "Add note", fields: [{ k: "n", label: "Note", type: "area", req: true, ph: "Spoke to the owner — cheque on Friday" }] },
                  async (v) => {
                    const r = await addNoteAction(target.kind, target.id, v.n ?? "");
                    if (r.ok) {
                      notify(`Note added to ${rec.data!.title}`);
                      void openRecord(rec.ref.section, rec.ref.table, rec.ref.id, rec.ref.subject);
                    }
                    return r;
                  },
                );
              }}
              runAct={(a) => {
                const ref = rec.ref;
                setRec(null);
                runAct(ref.section, ref.table, a, ref.id, rec.data?.title ?? ref.subject);
              }}
              open={(url) => router.push(url)}
            />
          </Overlay>
        ) : null}

        {/* ----------------------------------------------------------- confirm */}
        {confirm ? (
          <div
            onClick={() => setConfirm(null)}
            style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,22,22,0.45)", display: "flex", alignItems: "center", justifyContent: "center", animation: `fd-fade 150ms ${EASE}` }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ width: 480, maxWidth: "calc(100vw - 48px)", background: C.white, borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)", overflow: "hidden" }}
            >
              <div style={{ padding: "20px 22px" }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>{confirm.title}</div>
                <div style={{ fontSize: 14, lineHeight: "21px", color: C.body, marginTop: 8 }}>{confirm.body}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Recorded as you, under the Founder hat, with the state before and after.</div>
              </div>
              <div style={{ padding: "12px 22px", borderTop: `1px solid ${C.soft}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  onClick={() => setConfirm(null)}
                  style={{ height: 36, padding: "0 16px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 14, fontWeight: 500, color: C.body, cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  onClick={confirm.run}
                  style={{ height: 36, padding: "0 16px", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, color: C.white, cursor: "pointer", background: confirm.danger ? C.bad : C.brand }}
                >
                  {confirm.label}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* -------------------------------------------------------------- form */}
        {form ? <FormModal form={form} setForm={setForm} /> : null}

        {/* --------------------------------------------------------------- ask */}
        {askOpen ? (
          <Overlay onClose={() => setAskOpen(false)} width={520}>
            <div style={{ flex: "none", padding: "18px 22px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 20, fontWeight: 600, color: C.ink }}>Ask the company</span>
                <span style={{ display: "block", fontSize: 13, color: C.muted, marginTop: 2 }}>
                  Answers are read from the figures on this dashboard, company-wide, for {periodView.dates.split(",")[0]}.
                </span>
              </span>
              <CloseX onClick={() => setAskOpen(false)} />
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
              {askThread.length === 0 ? (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, marginBottom: 8 }}>Try asking</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {askSuggestions.map((q) => (
                      <Hov
                        key={q}
                        onClick={() => void doAsk(q)}
                        style={{ padding: "10px 12px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 6, fontSize: 14, color: C.ink, cursor: "pointer", textAlign: "left" }}
                        hover={{ borderColor: C.brand, background: C.canvas }}
                      >
                        {q}
                      </Hov>
                    ))}
                  </div>
                </div>
              ) : null}
              {askThread.map((m, i) => (
                <div
                  key={i}
                  style={
                    m.me
                      ? { alignSelf: "flex-end", maxWidth: "85%", padding: "10px 12px", borderRadius: "10px 10px 2px 10px", background: C.brand, color: C.white }
                      : { alignSelf: "flex-start", maxWidth: "90%", padding: "10px 12px", borderRadius: "10px 10px 10px 2px", background: C.canvas, border: `1px solid ${C.soft}`, color: C.ink }
                  }
                >
                  <span style={{ display: "block", fontSize: 14, lineHeight: "21px" }}>{m.text}</span>
                  {m.go ? (
                    <button
                      onClick={() => {
                        setAskOpen(false);
                        go(m.go!);
                      }}
                      style={{ marginTop: 8, border: "none", background: "none", color: C.brand, fontSize: 13, fontWeight: 500, cursor: "pointer", padding: 0 }}
                    >
                      {m.goLabel} →
                    </button>
                  ) : null}
                </div>
              ))}
              {asking ? (
                <div style={{ alignSelf: "flex-start", width: "60%" }}>
                  <Pulse />
                </div>
              ) : null}
            </div>
            <div style={{ flex: "none", padding: "12px 22px", borderTop: `1px solid ${C.soft}`, display: "flex", gap: 8 }}>
              <Hov
                as="input"
                value={askQ}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAskQ(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Enter" && askQ.trim().length >= 3) void doAsk(askQ.trim());
                }}
                placeholder={askSuggestions[0]}
                style={{ flex: 1, minWidth: 0, height: 38, padding: "0 12px", border: `1px solid ${C.line}`, borderRadius: 4, fontSize: 14 }}
                focus={{ borderColor: C.brand }}
              />
              <button
                onClick={() => askQ.trim().length >= 3 && void doAsk(askQ.trim())}
                style={{ height: 38, padding: "0 16px", border: "none", background: C.brand, borderRadius: 4, fontSize: 14, fontWeight: 500, color: C.white, cursor: "pointer" }}
              >
                Ask
              </button>
            </div>
          </Overlay>
        ) : null}

        {/* ----------------------------------------------------------- view as */}
        {viewAs ? (
          <Overlay onClose={() => setViewAs(null)} width={640}>
            <div style={{ flex: "none", padding: "12px 22px", background: C.brandDeep, color: C.white, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.lime, display: "block", flex: "none" }} />
              <span style={{ flex: 1, fontSize: 13 }}>Viewing as {viewAs.name} · read-only · anything you do is done as you</span>
              <button
                onClick={() => setViewAs(null)}
                style={{ height: 28, padding: "0 10px", border: "1px solid rgba(255,255,255,0.3)", background: "transparent", borderRadius: 4, color: C.white, fontSize: 13, cursor: "pointer" }}
              >
                Stop viewing
              </button>
            </div>
            <div style={{ flex: "none", padding: "16px 22px", borderBottom: `1px solid ${C.soft}` }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.ink }}>{viewAs.data?.name ?? viewAs.name}</div>
              <div style={{ fontSize: 14, color: C.muted, marginTop: 2 }}>{viewAs.loading ? "Reading their day…" : viewAs.error ?? viewAs.data?.role}</div>
              <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
                {(viewAs.data?.stats ?? []).map((x) => (
                  <span key={x.l} style={{ display: "block" }}>
                    <span style={{ ...upper, display: "block" }}>{x.l}</span>
                    <span style={{ display: "block", fontSize: 18, fontWeight: 600, color: C.ink }}>{x.v}</span>
                  </span>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px" }}>
              {viewAs.loading ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Pulse />
                  <Pulse w="70%" />
                  <Pulse w="85%" />
                </div>
              ) : viewAs.data ? (
                <>
                  {viewAs.data.held ? (
                    <div style={{ padding: "10px 12px", background: C.warnTint, border: `1px solid ${C.warnLine}`, borderRadius: 6, fontSize: 13, color: C.warnInk, marginBottom: 14 }}>{viewAs.data.held}</div>
                  ) : null}
                  <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, marginBottom: 8 }}>{viewAs.data.listLabel}</div>
                  <div style={{ border: `1px solid ${C.soft}`, borderRadius: 6, overflow: "hidden" }}>
                    {viewAs.data.rows.length === 0 ? (
                      <div style={{ padding: "18px 14px", fontSize: 14, color: C.muted }}>Nothing on their list today.</div>
                    ) : (
                      viewAs.data.rows.map((r) => (
                        <div key={r.n} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderTop: `1px solid ${C.canvas}` }}>
                          <span style={{ width: 22, fontSize: 13, fontWeight: 600, color: C.muted, flex: "none" }}>{r.n}</span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink }}>{r.name}</span>
                            <span style={{ display: "block", fontSize: 12, color: C.muted }}>{r.why}</span>
                          </span>
                          <span
                            style={{ fontSize: 12, fontWeight: 500, padding: "2px 8px", borderRadius: 10, display: r.tag ? "inline-block" : "none", background: r.tagTone === "now" ? C.brandTint : C.goodTint, color: r.tagTone === "now" ? C.brandDark : C.good }}
                          >
                            {r.tag}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </Overlay>
        ) : null}

        {toast ? (
          <div
            style={{ position: "fixed", right: 24, bottom: 24, zIndex: 40, display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: C.brandDeep, color: C.white, borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)", fontSize: 14, animation: `fd-fade 150ms ${EASE}` }}
          >
            <span style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(198,255,52,0.2)", color: C.lime, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>✓</span>
            {toast}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ================================================================= parts */

function CloseX({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 32, height: 32, border: "none", background: "transparent", color: C.muted, cursor: "pointer", fontSize: 18, flex: "none" }}>
      ✕
    </button>
  );
}

function Overlay({ onClose, width, children }: { onClose: () => void; width: number; children: React.ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(22,22,22,0.35)", display: "flex", justifyContent: "flex-end", animation: `fd-fade 150ms ${EASE}` }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width, maxWidth: "calc(100vw - 48px)", height: "100%", background: C.white, boxShadow: "0 8px 24px rgba(22,22,22,0.12)", display: "flex", flexDirection: "column", animation: `fd-drawer 200ms ${EASE}` }}
      >
        {children}
      </div>
    </div>
  );
}

function barsOf(bars: Bar[], gap = 2, radius = 2) {
  const max = Math.max(1, ...bars.map((b) => b.h));
  return bars.map((b, i) => (
    <span
      key={i}
      title={b.tip}
      style={{ flex: 1, height: `${Math.max(b.h > 0 ? 4 : 0, Math.round((b.h / max) * 100))}%`, borderRadius: radius, display: "block", background: b.current ? C.brand : C.brandTint2, marginLeft: i ? gap - 2 : 0 }}
    />
  ));
}

/* --------------------------------------------------------------- company */

function CompanyView({
  company,
  live,
  urgent,
  canSeeInbox,
  goInbox,
  goTeam,
  openFigure,
}: {
  company: CompanyPayload;
  live: InboxItem[];
  urgent: number;
  canSeeInbox: boolean;
  goInbox: () => void;
  goTeam: () => void;
  openFigure: (k: string) => void;
}) {
  const soon = live.filter((i) => i.sev === "Soon").length;
  const watch = live.filter((i) => i.sev === "Watch").length;
  const top = live.find((i) => i.sev === "Urgent") ?? live[0];
  const chip = (label: string, tone: "u" | "s" | "w") => (
    <span
      key={label}
      style={{ height: 24, padding: "0 8px", borderRadius: 12, fontSize: 12, fontWeight: 500, lineHeight: "24px", whiteSpace: "nowrap", background: tone === "u" ? C.badTint : C.white, color: tone === "u" ? C.bad : tone === "s" ? C.warnInk : C.body, border: `1px solid ${tone === "u" ? C.badTint : C.warnLine}` }}
    >
      {label}
    </span>
  );
  const pace = company.pace;
  return (
    <div>
      {canSeeInbox ? (
        <Hov
          onClick={goInbox}
          style={{ display: "flex", alignItems: "center", gap: 16, width: "100%", padding: "16px 20px", border: `1px solid ${C.warnLine}`, background: C.warnTint, borderRadius: 8, cursor: "pointer", textAlign: "left" }}
          hover={{ borderColor: C.warn }}
        >
          <span style={{ width: 40, height: 40, borderRadius: "50%", background: C.white, border: `1px solid ${C.warnLine}`, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", color: C.warnInk }}>
            <Icon name="bell" />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 16, fontWeight: 600, color: C.ink }}>
              {live.length === 0 ? "Nothing needs you" : `${live.length} ${live.length === 1 ? "thing needs" : "things need"} you${urgent ? `, ${urgent} urgent` : ""}`}
            </span>
            <span style={{ display: "block", fontSize: 14, color: C.body, marginTop: 2 }}>{top ? top.title : "Nothing is waiting"}</span>
          </span>
          <span style={{ display: "flex", gap: 6, flex: "none" }}>
            {chip(`${urgent} urgent`, "u")}
            {chip(`${soon} soon`, "s")}
            {chip(`${watch} to watch`, "w")}
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.brand, flex: "none" }}>Open →</span>
        </Hov>
      ) : null}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "28px 0 12px 0" }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>The period</span>
        <span style={{ fontSize: 13, color: C.muted }}>Follows the period · with GST · click any figure for how it is counted</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12 }}>
        {company.cards.map((c) => (
          <Hov
            key={c.key}
            onClick={() => openFigure(c.key)}
            style={{ display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "stretch", width: "100%", minWidth: 0, padding: 16, background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, cursor: "pointer", textAlign: "left", transition: `border-color 120ms ${EASE}` }}
            hover={{ borderColor: C.brand }}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span title={c.label} style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {c.label}
              </span>
              <span style={{ fontSize: 11, fontWeight: 500, padding: "1px 7px", borderRadius: 9, background: C.brandTint, color: C.brandDark, flex: "none" }}>Period</span>
            </span>
            <span style={{ display: "block", fontSize: 26, lineHeight: "32px", fontWeight: 600, color: C.ink, marginTop: 8, letterSpacing: "-0.01em" }}>{c.value}</span>
            <span style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: c.chgGood === null ? C.muted : c.chgGood ? C.good : C.bad }}>{c.chg}</span>
              <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{c.prevLine}</span>
            </span>
            <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 2 }}>{c.lyLine}</span>
            <span style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 28, marginTop: 12 }}>{barsOf(c.bars)}</span>
            {c.note ? <span style={{ display: "block", fontSize: 12, lineHeight: "17px", color: C.warnInk, marginTop: 8 }}>{c.note}</span> : null}
          </Hov>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.35fr) minmax(0,1fr)", gap: 16, marginTop: 16 }}>
        <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>{pace.title}</span>
            <span style={{ fontSize: 12, fontWeight: 500, padding: "2px 8px", borderRadius: 10, background: C.soft, color: C.body }}>{pace.badge}</span>
          </div>
          <div style={{ display: "flex", gap: 28, marginTop: 14 }}>
            {pace.figures.map((p) => (
              <span key={p.label} style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, color: C.muted }}>{p.label}</span>
                <span style={{ display: "block", fontSize: 22, lineHeight: "28px", fontWeight: 600, margin: "2px 0", color: p.tone === "bad" ? C.bad : p.tone === "warn" ? C.warnInk : C.ink }}>{p.value}</span>
                <span style={{ display: "block", fontSize: 12, color: C.muted }}>{p.sub}</span>
              </span>
            ))}
          </div>
          <div style={{ position: "relative", height: 10, background: C.soft, borderRadius: 5, marginTop: 16 }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, pace.donePct)}%`, background: C.brand, borderRadius: 5, display: "block" }} />
            <span
              style={{ position: "absolute", left: `${Math.min(100, pace.donePct)}%`, top: 0, bottom: 0, width: `${Math.max(0, Math.min(100, pace.projectedPct) - Math.min(100, pace.donePct))}%`, background: C.brandTint2, borderRadius: "0 5px 5px 0", display: "block" }}
            />
            {pace.hasTarget ? <span style={{ position: "absolute", left: `${Math.min(99, pace.targetPct)}%`, top: -4, width: 2, height: 18, background: C.ink, display: "block" }} /> : null}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginTop: 6 }}>
            <span>{pace.leftLine}</span>
            <span>{pace.rightLine}</span>
          </div>
          <div style={{ borderTop: `1px solid ${C.soft}`, marginTop: 16, paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, marginBottom: 8 }}>{company.moversTitle}</div>
            {company.movers.length === 0 ? (
              <div style={{ fontSize: 14, color: C.muted, padding: "6px 0" }}>Nothing moved between the two periods.</div>
            ) : (
              (() => {
                const mMax = Math.max(...company.movers.map((m) => Math.abs(m.d)), 1);
                return company.movers.map((m) => (
                  <div key={`${m.kind}:${m.name}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0" }}>
                    <span style={{ ...upper, width: 80, flex: "none" }}>{m.kind}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                    <span style={{ width: 120, height: 6, background: C.canvas, borderRadius: 3, position: "relative", flex: "none" }}>
                      <span
                        style={{ position: "absolute", top: 0, bottom: 0, left: m.d >= 0 ? "50%" : `${50 - (Math.abs(m.d) / mMax) * 50}%`, width: `${(Math.abs(m.d) / mMax) * 50}%`, borderRadius: 3, display: "block", background: m.d >= 0 ? C.good : C.bad }}
                      />
                    </span>
                    <span style={{ width: 84, textAlign: "right", fontSize: 14, fontWeight: 600, flex: "none", color: m.d >= 0 ? C.good : C.bad }}>{m.val}</span>
                  </div>
                ));
              })()
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>As of now</span>
              <span style={{ fontSize: 12, color: C.muted }}>{company.nowAsOf}</span>
            </div>
            {company.now.map((r) => (
              <Hov
                key={r.key}
                onClick={() => openFigure(r.key)}
                style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 18px", border: "none", borderTop: `1px solid ${C.canvas}`, background: C.white, cursor: "pointer", textAlign: "left" }}
                hover={{ background: C.canvas }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, color: C.ink }}>{r.label}</span>
                  <span style={{ display: "block", fontSize: 12, color: r.warn ? C.warnInk : C.muted, marginTop: 1 }}>{r.sub}</span>
                </span>
                <span style={{ fontSize: 17, fontWeight: 600, color: C.ink, flex: "none" }}>{r.value}</span>
              </Hov>
            ))}
          </div>
          <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "14px 18px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>Top of the team</span>
              <button onClick={goTeam} style={{ border: "none", background: "none", color: C.brand, fontSize: 13, fontWeight: 500, cursor: "pointer", padding: 0 }}>
                {company.teamAllLabel}
              </button>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{company.topTeamMonthLine}</div>
            {company.topTeam.length === 0 ? (
              <div style={{ fontSize: 14, color: C.muted, padding: "9px 0", borderTop: `1px solid ${C.canvas}`, marginTop: 6 }}>Nobody holds a published target for this month yet.</div>
            ) : (
              company.topTeam.map((t) => (
                <div key={t.rank + t.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: `1px solid ${C.canvas}`, marginTop: 6 }}>
                  <span style={{ width: 22, fontSize: 13, fontWeight: 600, color: C.muted, flex: "none" }}>{t.rank}</span>
                  <span style={{ width: 30, height: 30, borderRadius: "50%", background: C.brandTint, color: C.brandDark, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{t.initials}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink }}>{t.name}</span>
                    <span style={{ display: "block", fontSize: 12, color: C.muted }}>{t.role}</span>
                  </span>
                  <span style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>{t.score}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {company.unattributed ? (
        <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "14px 18px", marginTop: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ width: 32, height: 32, borderRadius: "50%", background: C.warnTint, color: C.warnInk, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontWeight: 600 }}>!</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }}>{company.unattributed.line}</span>
          <Hov
            onClick={() => openFigure("unattr")}
            style={{ height: 32, padding: "0 12px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.body, cursor: "pointer", flex: "none" }}
            hover={{ background: C.canvas }}
          >
            {company.unattributed.button}
          </Hov>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- inbox */

function InboxView({
  items,
  tab,
  setTab,
  go,
  handOn,
  snooze,
}: {
  items: InboxItem[];
  tab: string;
  setTab: (t: string) => void;
  go: (s: SectionKey) => void;
  handOn: (i: InboxItem) => void;
  snooze: (i: InboxItem) => void;
}) {
  const live = items.filter((i) => !i.handed && !i.snoozed);
  const handed = items.filter((i) => i.handed);
  const snoozed = items.filter((i) => i.snoozed);
  const byTab =
    tab === "all" ? live : tab === "handed" ? handed : tab === "snoozed" ? snoozed : live.filter((i) => i.sev.toLowerCase() === tab);
  const tabs: [string, string, number][] = [
    ["all", "Needs you", live.length],
    ["urgent", "Critical", live.filter((i) => i.sev === "Urgent").length],
    ["soon", "High", live.filter((i) => i.sev === "Soon").length],
    ["watch", "Medium", live.filter((i) => i.sev === "Watch").length],
    ["handed", "Handed on", handed.length],
    ["snoozed", "Snoozed", snoozed.length],
  ];
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {tabs.map(([k, l, n]) => {
          const on = tab === k;
          return (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 34, padding: "0 12px", borderRadius: 17, cursor: "pointer", fontSize: 14, fontWeight: on ? 500 : 400, border: `1px solid ${on ? C.brand : C.line}`, background: on ? C.brandTint : C.white, color: on ? C.brandDark : C.body }}
            >
              {l}
              <span style={{ fontSize: 12, fontWeight: 600, color: on ? C.brandDark : C.muted }}>{n}</span>
            </button>
          );
        })}
      </div>
      {byTab.length === 0 ? (
        <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "48px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>Nothing here needs you</div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 4 }}>Items appear on their own when a rule fires, and leave when it clears.</div>
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {byTab.map((i) => (
          <div key={i.id} style={{ display: "flex", alignItems: "stretch", gap: 14, background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
            <span style={{ width: 4, flex: "none", background: SEV[i.sev]![0], display: "block" }} />
            <span style={{ flex: 1, minWidth: 0, padding: "14px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", padding: "1px 7px", borderRadius: 9, background: SEV[i.sev]![1], color: i.sev === "Soon" ? C.warnInk : SEV[i.sev]![0] }}
                >
                  {i.sev}
                </span>
                <span style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>{i.area}</span>
                <span style={{ fontSize: 12, color: C.muted }}>· since {i.since}</span>
              </span>
              <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: C.ink, marginTop: 4 }}>{i.title}</span>
              <span style={{ display: "block", fontSize: 14, lineHeight: "20px", color: C.body, marginTop: 2 }}>{i.why}</span>
              {i.handed || i.snoozed ? (
                <span style={{ display: "block", fontSize: 13, color: C.brandDark, marginTop: 4 }}>
                  {i.handed ? `Handed to ${i.handed.to} · ${i.handed.note || "no note"}` : `Snoozed until ${i.snoozed!.until} · ${i.snoozed!.why}`}
                </span>
              ) : null}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none", padding: "0 16px" }}>
              <Hov onClick={() => handOn(i)} style={{ height: 32, padding: "0 10px", border: "none", background: "transparent", fontSize: 13, color: C.muted, cursor: "pointer" }} hover={{ color: C.ink }}>
                {i.handed ? "Take back" : "Hand on"}
              </Hov>
              <Hov onClick={() => snooze(i)} style={{ height: 32, padding: "0 10px", border: "none", background: "transparent", fontSize: 13, color: C.muted, cursor: "pointer" }} hover={{ color: C.ink }}>
                {i.snoozed ? "Wake now" : "Snooze"}
              </Hov>
              <Hov
                onClick={() => go(i.go)}
                style={{ height: 34, padding: "0 14px", border: `1px solid ${C.brand}`, background: C.brand, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.white, cursor: "pointer", whiteSpace: "nowrap" }}
                hover={{ background: C.brandDark }}
              >
                {i.action}
              </Hov>
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 13, color: C.muted, marginTop: 14 }}>
        Items are derived from live rules, not stored. They clear on their own when the condition does. A snooze is yours only, and an item returns on the day you picked.
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- section */

function SectionView({
  section,
  payload,
  periodIn,
  done,
  openFigure,
  openRecord,
  runAct,
  onCallout,
}: {
  section: SectionKey;
  payload: SectionPayload;
  periodIn: { key: string; from?: string; to?: string };
  done: Record<string, string>;
  openFigure: (k: string) => void;
  openRecord: (table: string, id: string, subject: string) => void;
  runAct: (table: string, a: ActSpec, id: string, subject: string) => void;
  onCallout: (c: SectionPayload["callouts"][number]) => void;
}) {
  const n = payload.metrics.length;
  return (
    <div>
      {payload.callouts.map((c, i) => {
        const t = TONE[c.tone] ?? TONE.warn!;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", marginBottom: 12, background: t[1], border: `1px solid ${t[2]}`, borderRadius: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: t[0], flex: "none", display: "block" }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: "20px", color: C.ink }}>{c.text}</span>
            {c.act ? (
              <Hov
                onClick={() => onCallout(c)}
                style={{ height: 32, padding: "0 12px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.body, cursor: "pointer", flex: "none", whiteSpace: "nowrap" }}
                hover={{ background: C.canvas }}
              >
                {c.act}
              </Hov>
            ) : null}
          </div>
        );
      })}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(Math.max(n, 1), 5)},minmax(0,1fr))`, gap: 12 }}>
        {payload.metrics.map((m) => (
          <Hov
            key={m.key}
            onClick={() => openFigure(m.key)}
            style={{ display: "flex", flexDirection: "column", justifyContent: "flex-start", minWidth: 0, padding: "14px 16px", background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, cursor: "pointer", textAlign: "left" }}
            hover={{ borderColor: C.brand }}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
              <span style={{ fontSize: 11, fontWeight: 500, padding: "1px 7px", borderRadius: 9, flex: "none", background: KIND[m.kind]![0], color: KIND[m.kind]![1] }}>{m.kind}</span>
            </span>
            <span
              style={{ display: "block", fontSize: 24, lineHeight: "30px", fontWeight: 600, marginTop: 8, letterSpacing: "-0.01em", color: m.tone === "bad" ? C.bad : m.tone === "warn" ? C.warnInk : m.tone === "good" ? C.good : C.ink }}
            >
              {m.value}
            </span>
            <span style={{ display: "block", fontSize: 12, lineHeight: "17px", color: C.muted, marginTop: 4 }}>{m.sub}</span>
          </Hov>
        ))}
      </div>
      {payload.tables.map((t) => (
        <TableCard key={t.key} section={section} table={t} periodIn={periodIn} done={done} openRecord={openRecord} runAct={runAct} />
      ))}
      <div style={{ fontSize: 13, color: C.muted, marginTop: 14, lineHeight: "19px" }}>{payload.foot}</div>
    </div>
  );
}

function TableCard({
  section,
  table,
  periodIn,
  done,
  openRecord,
  runAct,
}: {
  section: SectionKey;
  table: Table;
  periodIn: { key: string; from?: string; to?: string };
  done: Record<string, string>;
  openRecord: (table: string, id: string, subject: string) => void;
  runAct: (table: string, a: ActSpec, id: string, subject: string) => void;
}) {
  const [page, setPage] = React.useState<TablePage>(table.page);
  const [q, setQ] = React.useState(table.page.q);
  const [loading, setLoading] = React.useState(false);
  const reqId = React.useRef(0);

  const load = React.useCallback(
    async (patch: { q?: string; page?: number; size?: number }) => {
      const next = { q: patch.q ?? q, page: patch.page ?? page.page, size: patch.size ?? page.size };
      const mine = ++reqId.current;
      setLoading(true);
      const r = await tablePageAction(section, table.key, periodIn, next.q, next.page, next.size);
      if (mine !== reqId.current) return;
      setLoading(false);
      if (r.ok) setPage(r.data);
    },
    [q, page.page, page.size, section, table.key, periodIn],
  );

  React.useEffect(() => {
    if (q === page.q) return;
    const t = setTimeout(() => void load({ q, page: 1 }), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const acts = table.acts ?? [];
  const hasActs = acts.length > 0;
  const noun = table.noun;
  const pluralNoun = table.plural ?? (noun === "enquiry" ? "enquiries" : noun === "salesman" ? "salesmen" : noun === "person" ? "people" : `${noun}s`);
  const many = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? noun : pluralNoun}`;
  const paged = page.total > 25;
  const pages = Math.max(1, Math.ceil(page.count / page.size));
  const from = (page.page - 1) * page.size;
  const tpl = table.cols.map((c) => c[1]).join(" ") + (hasActs ? ` ${table.actW ?? "190px"}` : "");
  const minW = table.min ?? 760;

  const pageNums: number[] = [];
  [1, page.page - 1, page.page, page.page + 1, pages].forEach((x) => {
    if (x >= 1 && x <= pages && !pageNums.includes(x)) pageNums.push(x);
  });
  pageNums.sort((a, b) => a - b);

  return (
    <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, marginTop: 16, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 16, fontWeight: 600, color: C.ink }}>{table.title}</span>
          <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 1 }}>{table.hint}</span>
        </span>
        {paged ? (
          <span style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}>
            <span style={{ fontSize: 13, color: C.body, whiteSpace: "nowrap" }}>{q.trim().length >= 2 && page.q.trim() === q.trim() ? `${many(page.count)} match "${q.trim()}"` : many(page.total)}</span>
            <Hov
              as="input"
              value={q}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
              placeholder={`Search ${many(page.total)}`}
              style={{ width: 240, height: 32, padding: "0 10px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.canvas, fontSize: 13 }}
              focus={{ background: C.white, borderColor: C.brand }}
            />
          </span>
        ) : null}
      </div>
      <div style={{ overflowX: "auto", opacity: loading ? 0.6 : 1, transition: `opacity 120ms ${EASE}` }}>
        <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, padding: "9px 18px", background: C.canvas, borderBottom: `1px solid ${C.soft}`, minWidth: minW }}>
          {table.cols.concat(hasActs ? [["", ""]] : []).map((c, i) => (
            <span key={i} style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, textAlign: c[2] ? "right" : "left", whiteSpace: "nowrap" }}>
              {c[0]}
            </span>
          ))}
        </div>
        {page.rows.map((r: Row, ri: number) => {
          const key = `${section}:${table.key}:${r.id}`;
          const doneWord = done[key] ?? r.done;
          const rowActs = r.acts ? acts.filter((a) => r.acts!.includes(a.key)) : acts;
          const subject = r.cells[0]?.t ?? table.rec;
          return (
            <Hov
              as="div"
              key={r.id}
              onClick={() => openRecord(table.key, r.id, subject)}
              style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, alignItems: "center", width: "100%", minWidth: minW, padding: "11px 18px", border: "none", borderTop: ri ? `1px solid ${C.canvas}` : "none", background: C.white, cursor: "pointer", textAlign: "left" }}
              hover={{ background: C.canvas }}
            >
              {r.cells.map((cell, ci) => {
                const right = !!table.cols[ci]?.[2];
                const pill = cell.pill ? PILL[cell.pill] : null;
                return (
                  <span key={ci} style={{ minWidth: 0, textAlign: right ? "right" : "left" }}>
                    <span
                      style={
                        pill
                          ? { display: "inline-block", fontSize: 12, fontWeight: 500, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap", background: pill[0], color: pill[1] }
                          : { display: "block", fontSize: 14, color: C.ink, fontWeight: ci === 0 ? 500 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                      }
                    >
                      {cell.t}
                    </span>
                    {cell.sub ? <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 1 }}>{cell.sub}</span> : null}
                  </span>
                );
              })}
              {hasActs ? (
                <span style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  {doneWord ? (
                    <span style={{ fontSize: 12, fontWeight: 500, padding: "3px 8px", borderRadius: 10, whiteSpace: "nowrap", background: C.goodTint, color: C.good }}>
                      {done[key] ? `${doneWord} by you` : doneWord}
                    </span>
                  ) : (
                    rowActs.map((a, ai) => (
                      <button
                        key={a.key}
                        onClick={(e) => {
                          e.stopPropagation();
                          runAct(table.key, a, r.id, subject);
                        }}
                        style={{ height: 30, padding: "0 10px", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", border: `1px solid ${ai === 0 ? C.brand : C.line}`, background: ai === 0 ? C.brand : C.white, color: ai === 0 ? C.white : a.tone === "bad" ? C.bad : C.body }}
                      >
                        {a.label}
                      </button>
                    ))
                  )}
                </span>
              ) : null}
            </Hov>
          );
        })}
        {page.count === 0 ? (
          <div style={{ padding: "32px 18px", textAlign: "center", fontSize: 14, color: C.muted }}>
            {page.q.trim().length >= 2 ? "Nothing matches that. Try a name, a city or a number." : `No ${pluralNoun} right now.`}
          </div>
        ) : null}
      </div>
      {paged ? (
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 18px", borderTop: `1px solid ${C.soft}`, background: C.white, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: C.body, whiteSpace: "nowrap" }}>
            {page.count ? `Showing ${(from + 1).toLocaleString("en-IN")}–${Math.min(from + page.size, page.count).toLocaleString("en-IN")} of ${many(page.count)}` : `No ${pluralNoun} match`}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: C.muted }}>Rows</span>
            {[25, 50, 100].map((z) => (
              <button
                key={z}
                onClick={() => void load({ size: z, page: 1 })}
                style={{ height: 26, padding: "0 8px", borderRadius: 4, border: `1px solid ${page.size === z ? C.brand : C.line}`, background: page.size === z ? C.brandTint : C.white, color: page.size === z ? C.brandDark : C.body, fontSize: 12, fontWeight: page.size === z ? 600 : 400, cursor: "pointer" }}
              >
                {z}
              </button>
            ))}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => page.page > 1 && void load({ page: page.page - 1 })}
            style={{ height: 28, padding: "0 10px", borderRadius: 4, border: `1px solid ${C.line}`, background: C.white, fontSize: 13, cursor: page.page > 1 ? "pointer" : "not-allowed", color: page.page > 1 ? C.body : C.faint }}
          >
            ‹ Previous
          </button>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {pageNums.map((x, k) => (
              <React.Fragment key={x}>
                {k && x - pageNums[k - 1]! > 1 ? (
                  <button style={{ minWidth: 28, height: 28, border: "none", background: "transparent", color: C.muted, fontSize: 13, cursor: "default" }}>…</button>
                ) : null}
                <button
                  onClick={() => void load({ page: x })}
                  style={{ minWidth: 28, height: 28, padding: "0 6px", borderRadius: 4, border: `1px solid ${x === page.page ? C.brand : "transparent"}`, background: x === page.page ? C.brandTint : "transparent", color: x === page.page ? C.brandDark : C.body, fontSize: 13, fontWeight: x === page.page ? 600 : 400, cursor: "pointer" }}
                >
                  {x.toLocaleString("en-IN")}
                </button>
              </React.Fragment>
            ))}
          </span>
          <button
            onClick={() => page.page < pages && void load({ page: page.page + 1 })}
            style={{ height: 28, padding: "0 10px", borderRadius: 4, border: `1px solid ${C.line}`, background: C.white, fontSize: 13, cursor: page.page < pages ? "pointer" : "not-allowed", color: page.page < pages ? C.body : C.faint }}
          >
            Next ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- drawer */

function FigureDrawerView({
  d,
  close,
  goSection,
  notify,
}: {
  d: { loading: boolean; data: FigureDrawer | null; error?: string };
  close: () => void;
  goSection: (s: SectionKey) => void;
  notify: (t: string) => void;
}) {
  const f = d.data;
  const exportRows = () => {
    if (!f) return;
    const text =
      `"${f.title}","${f.value}"\n"How it is counted","${f.def.replace(/"/g, '""')}"\n` +
      f.facts.map((x) => `"${x.label}","${x.value.replace(/"/g, '""')}"`).join("\n") +
      "\n\nRecord,Detail,Value\n" +
      f.rows.map((r) => [r.a, r.b, r.c].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" }));
    const el = document.createElement("a");
    el.href = url;
    el.download = `command-centre-${f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
    el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`Exported ${f.rows.length} rows with the period and definition`);
  };
  return (
    <>
      <div style={{ flex: "none", padding: "18px 22px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>{f?.kind ?? (d.loading ? "Reading" : "Figure")}</span>
          <span style={{ display: "block", fontSize: 20, fontWeight: 600, color: C.ink, marginTop: 2 }}>{f?.title ?? (d.loading ? <Pulse w="50%" h={20} /> : "Could not be read")}</span>
          <span style={{ display: "block", fontSize: 28, lineHeight: "34px", fontWeight: 600, color: C.ink, marginTop: 6 }}>{f?.value ?? (d.loading ? <Pulse w="35%" h={28} /> : "—")}</span>
        </span>
        <CloseX onClick={close} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
        {d.error ? <div style={{ padding: 14, background: C.badTint, borderRadius: 6, fontSize: 14, color: C.bad }}>{d.error}</div> : null}
        {f ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12 }}>
              {f.facts.map((x) => (
                <span key={x.label} style={{ display: "block", padding: "10px 12px", background: C.canvas, borderRadius: 6 }}>
                  <span style={{ ...upper, display: "block" }}>{x.label}</span>
                  <span style={{ display: "block", fontSize: 14, color: C.ink, marginTop: 2 }}>{x.value}</span>
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, margin: "20px 0 6px 0" }}>How it is counted</div>
            <div style={{ fontSize: 14, lineHeight: "21px", color: C.body }}>{f.def}</div>
            <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, margin: "20px 0 8px 0" }}>{f.barsLabel}</div>
            {f.bars.length ? (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 80 }}>{barsOf(f.bars, 4, 3)}</div>
            ) : null}
            <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, margin: "20px 0 8px 0" }}>{f.rowsLabel}</div>
            {f.rows.length === 0 ? (
              <div style={{ padding: 14, background: C.canvas, borderRadius: 6, fontSize: 14, lineHeight: "20px", color: C.body }}>
                {f.noRowsLine ?? "No list on this dashboard holds the records behind this figure yet. The definition above is how it is counted."}
              </div>
            ) : (
              <div style={{ border: `1px solid ${C.soft}`, borderRadius: 6, overflow: "hidden" }}>
                {f.rows.map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderTop: `1px solid ${C.canvas}` }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14, color: C.ink }}>{r.a}</span>
                      <span style={{ display: "block", fontSize: 12, color: C.muted }}>{r.b}</span>
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: C.ink, flex: "none" }}>{r.c}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : d.loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Pulse />
            <Pulse w="80%" />
            <Pulse w="60%" />
          </div>
        ) : null}
      </div>
      <div style={{ flex: "none", borderTop: `1px solid ${C.soft}`, padding: "12px 22px", display: "flex", gap: 10, justifyContent: "flex-end" }}>
        {f && f.rows.length ? (
          <button onClick={exportRows} style={{ height: 34, padding: "0 14px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.body, cursor: "pointer" }}>
            Export these rows
          </button>
        ) : null}
        <button
          onClick={() => (f?.section ? goSection(f.section) : close())}
          style={{ height: 34, padding: "0 14px", border: `1px solid ${C.brand}`, background: C.brand, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.white, cursor: "pointer" }}
        >
          {f?.sectionLabel ?? "Done"}
        </button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- record */

function RecordDrawer({
  rec,
  close,
  addNote,
  runAct,
  open,
}: {
  rec: { loading: boolean; data: RecordView | null; error?: string; ref: { subject: string } };
  close: () => void;
  addNote: () => void;
  runAct: (a: ActSpec) => void;
  open: (url: string) => void;
}) {
  const r = rec.data;
  return (
    <>
      <div style={{ flex: "none", padding: "18px 22px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>{r?.kind ?? "Record · Command Centre"}</span>
          <span style={{ display: "block", fontSize: 20, fontWeight: 600, color: C.ink, marginTop: 2 }}>{r?.title ?? rec.ref.subject}</span>
          <span style={{ display: "block", fontSize: 14, color: C.muted, marginTop: 2 }}>{r?.sub ?? (rec.loading ? "Reading the record…" : "")}</span>
        </span>
        <CloseX onClick={close} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
        {rec.error ? <div style={{ padding: 14, background: C.badTint, borderRadius: 6, fontSize: 14, color: C.bad }}>{rec.error}</div> : null}
        {rec.loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Pulse />
            <Pulse w="80%" />
            <Pulse w="60%" />
          </div>
        ) : null}
        {r ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10 }}>
              {r.fields.map((f) => (
                <span key={f.label} style={{ display: "block", padding: "10px 12px", background: C.canvas, borderRadius: 6, minWidth: 0 }}>
                  <span style={{ ...upper, display: "block" }}>{f.label}</span>
                  <span style={{ display: "block", fontSize: 14, color: C.ink, marginTop: 2 }}>{f.value}</span>
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, margin: "22px 0 8px 0" }}>Timeline</div>
            {r.timeline.length === 0 ? <div style={{ fontSize: 14, color: C.muted, paddingBottom: 14 }}>Nothing has happened on this record yet.</div> : null}
            {r.timeline.map((e, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "0 0 14px 0" }}>
                <span style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none", width: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.brand, display: "block", marginTop: 6 }} />
                  <span style={{ flex: 1, width: 1, background: C.soft, display: "block", marginTop: 4 }} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, color: C.ink }}>{e.what}</span>
                  <span style={{ display: "block", fontSize: 12, color: C.muted }}>{e.when}</span>
                </span>
              </div>
            ))}
            <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, margin: "8px 0 8px 0" }}>Who changed what</div>
            <div style={{ border: `1px solid ${C.soft}`, borderRadius: 6, overflow: "hidden" }}>
              {r.audit.length === 0 ? <div style={{ padding: "10px 12px", fontSize: 14, color: C.muted }}>No recorded changes.</div> : null}
              {r.audit.map((u, i) => (
                <div key={i} style={{ padding: "10px 12px", borderTop: `1px solid ${C.canvas}` }}>
                  <span style={{ display: "block", fontSize: 14, color: C.ink }}>{u.what}</span>
                  <span style={{ display: "block", fontSize: 12, color: C.muted }}>{u.who}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div style={{ flex: "none", borderTop: `1px solid ${C.soft}`, padding: "12px 22px", display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {r?.href ? (
          <button onClick={() => open(r.href!.url)} style={{ height: 34, padding: "0 14px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.body, cursor: "pointer" }}>
            {r.href.label}
          </button>
        ) : null}
        <button
          onClick={addNote}
          disabled={!r}
          style={{ height: 34, padding: "0 14px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.body, cursor: r ? "pointer" : "not-allowed" }}
        >
          Add a note
        </button>
        {(r?.acts ?? []).map((a, ai) => (
          <button
            key={a.key}
            onClick={() => runAct(a)}
            style={{ height: 34, padding: "0 14px", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer", border: `1px solid ${ai === 0 ? C.brand : C.line}`, background: ai === 0 ? C.brand : C.white, color: ai === 0 ? C.white : a.tone === "bad" ? C.bad : C.body }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ form */

function FormModal({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState | null>> }) {
  const f = form.spec;
  const visible = (x: FieldSpec) => !x.when || x.when.in.includes(form.values[x.when.k] ?? "");
  const set = (k: string, v: string) =>
    setForm((s) => (s ? { ...s, values: { ...s.values, [k]: v }, errors: { ...s.errors, [k]: "" } } : s));
  const submit = async () => {
    const errs: Record<string, string> = {};
    for (const x of f.fields) {
      if (!visible(x)) continue;
      const v = String(form.values[x.k] ?? "").trim();
      if (x.req && !v) errs[x.k] = `${x.label} is needed`;
      else if (x.type === "money" && v && !(parseFloat(v.replace(/[^0-9.]/g, "")) > 0)) errs[x.k] = "Enter an amount above zero";
    }
    if (Object.keys(errs).length) return setForm((s) => (s ? { ...s, errors: errs } : s));
    const values: Record<string, string> = {};
    for (const x of f.fields) if (visible(x)) values[x.k] = form.values[x.k] ?? "";
    setForm((s) => (s ? { ...s, busy: true } : s));
    const r = await form.submit(values);
    if (r.ok) {
      setForm(null);
      form.onDone?.(r);
    } else {
      setForm((s) =>
        s ? { ...s, busy: false, errors: { ...(r.fieldErrors ?? {}), ...(r.fieldErrors && Object.keys(r.fieldErrors).length ? {} : { __form: r.error }) } } : s,
      );
    }
  };
  const inputStyle = (bad: boolean): React.CSSProperties => ({ width: "100%", height: 38, padding: "0 10px", border: `1px solid ${bad ? C.bad : C.line}`, borderRadius: 4, fontSize: 14, background: C.white });
  return (
    <div
      onClick={() => !form.busy && setForm(null)}
      style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,22,22,0.45)", display: "flex", alignItems: "center", justifyContent: "center", animation: `fd-fade 150ms ${EASE}` }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520, maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 64px)", background: C.white, borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ flex: "none", padding: "18px 22px 14px 22px", borderBottom: `1px solid ${C.soft}` }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>{f.title}</div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 2 }}>{f.sub ?? ""}</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          {f.fields.filter(visible).map((x) => {
            const bad = !!form.errors[x.k];
            const value = form.values[x.k] ?? "";
            return (
              <label key={x.k} style={{ display: "block" }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, marginBottom: 5 }}>
                  {x.label + (x.req ? "" : x.cond ? ` · ${x.cond}` : " · optional")}
                </span>
                {x.type === "area" ? (
                  <textarea
                    value={value}
                    onChange={(e) => set(x.k, e.target.value)}
                    placeholder={x.ph ?? ""}
                    style={{ ...inputStyle(bad), height: 88, padding: "8px 10px", resize: "vertical" }}
                  />
                ) : x.type === "select" ? (
                  <select value={value} onChange={(e) => set(x.k, e.target.value)} style={inputStyle(bad)}>
                    {!x.req || !value ? <option value="">{x.options?.length ? "Choose…" : "Nothing to choose from"}</option> : null}
                    {(x.options ?? []).map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.l}
                      </option>
                    ))}
                  </select>
                ) : x.type === "customer" || x.type === "person" || x.type === "product" ? (
                  <SearchPick field={x} value={value} bad={bad} onPick={(v) => set(x.k, v)} />
                ) : (
                  <Hov
                    as="input"
                    value={value}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(x.k, e.target.value)}
                    placeholder={x.ph ?? ""}
                    type={x.type === "date" ? "date" : x.type === "number" ? "number" : "text"}
                    style={inputStyle(bad)}
                    focus={{ borderColor: C.brand }}
                  />
                )}
                {bad ? <span style={{ display: "block", fontSize: 13, color: C.bad, marginTop: 4 }}>{form.errors[x.k]}</span> : null}
                {x.hint ? <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 4 }}>{x.hint}</span> : null}
              </label>
            );
          })}
          {f.consequence ? (
            <div style={{ padding: "10px 12px", background: C.brandTint, border: `1px solid ${C.brandTint2}`, borderRadius: 6, fontSize: 13, lineHeight: "19px", color: C.brandDeep }}>{f.consequence}</div>
          ) : null}
          {form.errors.__form ? <div style={{ padding: "10px 12px", background: C.badTint, borderRadius: 6, fontSize: 13, color: C.bad }}>{form.errors.__form}</div> : null}
        </div>
        <div style={{ flex: "none", padding: "12px 22px", borderTop: `1px solid ${C.soft}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={() => setForm(null)}
            disabled={form.busy}
            style={{ height: 36, padding: "0 16px", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 14, fontWeight: 500, color: C.body, cursor: "pointer" }}
          >
            Cancel
          </button>
          <Hov
            onClick={() => void submit()}
            disabled={form.busy}
            style={{ height: 36, padding: "0 16px", border: "none", background: C.brand, borderRadius: 4, fontSize: 14, fontWeight: 500, color: C.white, cursor: form.busy ? "wait" : "pointer", opacity: form.busy ? 0.7 : 1 }}
            hover={{ background: C.brandDark }}
          >
            {form.busy ? "Working…" : f.submit ?? "Save"}
          </Hov>
        </div>
      </div>
    </div>
  );
}

/** A searchable pick for a customer, a person or a product — real rows, searched on the server. */
function SearchPick({ field, value, bad, onPick }: { field: FieldSpec; value: string; bad: boolean; onPick: (v: string) => void }) {
  const [q, setQ] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [opts, setOpts] = React.useState<{ v: string; l: string }[]>([]);
  const [open, setOpen] = React.useState(false);
  const kind = field.type === "product" ? "product" : field.search ?? (field.type === "person" ? "staff" : "any");
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await optionsAction(kind, q);
      if (live) setOpts(r);
    }, 160);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, open, kind]);
  return (
    <span style={{ position: "relative", display: "block" }}>
      <Hov
        as="input"
        value={open ? q : value ? label || "Picked" : ""}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
        placeholder={field.ph ?? (kind === "product" ? "Search the catalogue" : "Search by name")}
        style={{ width: "100%", height: 38, padding: "0 10px", border: `1px solid ${bad ? C.bad : C.line}`, borderRadius: 4, fontSize: 14, background: C.white }}
        focus={{ borderColor: C.brand }}
      />
      {open ? (
        <span
          style={{ position: "absolute", top: 42, left: 0, right: 0, zIndex: 5, maxHeight: 220, overflowY: "auto", background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, boxShadow: "0 8px 24px rgba(22,22,22,0.12)" }}
        >
          {opts.length === 0 ? (
            <span style={{ display: "block", padding: "9px 12px", fontSize: 13, color: C.muted }}>
              {kind !== "staff" && kind !== "caller" && kind !== "salesman" && q.trim().length < 2 ? "Keep typing to search." : "Nothing matches that."}
            </span>
          ) : (
            opts.map((o) => (
              <Hov
                key={o.v}
                as="span"
                onMouseDown={() => {
                  onPick(o.v);
                  setLabel(o.l);
                  setOpen(false);
                }}
                style={{ display: "block", padding: "9px 12px", fontSize: 14, color: C.ink, cursor: "pointer", borderTop: `1px solid ${C.canvas}` }}
                hover={{ background: C.canvas }}
              >
                {o.l}
              </Hov>
            ))
          )}
        </span>
      ) : null}
    </span>
  );
}
