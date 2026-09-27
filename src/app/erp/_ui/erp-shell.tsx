"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { CollapsibleNav, type NavRowGroup, type NavRowItem } from "@/components/shell/collapsible-nav";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { erpAsk, erpSearch, erpSetWorkingGodown, type ErpSearchHit } from "@/lib/actions/erp";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import { GodownPicker } from "./godown-picker";
import { Icon } from "./icons";
import { ErpUiProvider } from "./erp-ui";

/* ---------------------------------------------------------------------------
 * The ERP's shell, and it is the CRM's shell.
 *
 * It was drawn from the ERP's own design with its own header, its own
 * sidebar, its own toast and its own search — a second answer to every
 * question the CRM's shell already answers, in the same suite, a click apart.
 * Somebody moving between the two apps learned two layouts. So this is the
 * CRM's pattern with the ERP's content: the same frame, the same header row
 * (switcher, collapse, wordmark, search, then Feedback, shortcuts, the bell and
 * the account), the same `CollapsibleNav` in the same 216px column and the
 * same account menu on its floor. What is the ERP's own is the working
 * location, which sits where the CRM's Viewing switch sits and is drawn the
 * same way, because it answers the same kind of question — whose figures am
 * I looking at.
 * ------------------------------------------------------------------------- */

export type NavScreen = { key: string; label: string; href: string; count?: number };
export type NavGroup = { id: string; label: string; icon: string; single: boolean; screens: NavScreen[] };

/** Every sub-item carries its own icon, as the CRM's do. */
const SCREEN_ICON: Record<string, string> = {
  dashboard: "dashboard",
  alerts: "bell",
  rawMaterials: "flask",
  suppliers: "people",
  products: "can",
  customers: "person",
  godowns: "home",
  priceLists: "rupee",
  employees: "people",
  powers: "lock",
  refLists: "clipboard",
  requisitions: "clipboard",
  inward: "truck",
  testing: "beaker",
  register: "book",
  barcode: "scan",
  rmStock: "flask",
  rmLog: "history",
  sfgBatches: "beaker",
  sfgStock: "can",
  sfgLog: "history",
  fgFill: "can",
  fgStock: "box",
  fgLog: "history",
  packBatches: "box",
  packStock: "box",
  packLog: "history",
  transfers: "swap",
  rmLevels: "chart",
  fgLevels: "chart",
  reorderRm: "refresh",
  reorderFg: "refresh",
  orderInbox: "mail",
  orders: "clipboard",
  pendingOrders: "clock",
  readyOrders: "check",
  batchCodes: "scan",
  labels: "doc",
  orderDetails: "receipt",
  transport: "truck",
  pendingLr: "clock",
  trackLr: "pin",
  paidFreight: "rupee",
  requests: "chat",
  issueCn: "receipt",
  complaints: "warning",
  pendingCn: "clock",
  followup: "phone",
  pivot: "chart",
  credits: "wallet",
  expenses: "rupee",
  myCustomers: "people",
  videos: "play",
  settings: "settings",
};

/** The registry's group icons, in the shell set's names where it has one. */
const GROUP_ICON: Record<string, string> = { home: "dashboard", gear: "settings", file: "doc" };

/* The CRM's icon set first — so a shared idea (people, clock, rupee) is the
   same glyph in both apps — and the ERP's own for what the CRM never needed:
   flasks, cans, lorries. */
const SHELL_ICONS = new Set([
  "dashboard", "phone", "bell", "history", "rupee", "wallet", "doc", "eye", "person", "people", "warning",
  "chart", "target", "clipboard", "chat", "book", "search", "chevron", "chevronLeft", "close", "plus", "copy",
  "check", "alert", "menu", "grid", "settings", "signOut", "mail", "lock", "arrowRight", "tick", "clock",
]);

function renderIcon(name: string, size: number) {
  return SHELL_ICONS.has(name) ? <ShellIcon name={name} size={size} className="flex-none" /> : <Icon n={name} s={size} />;
}

const PINNED_GROUPS = new Set(["dashboard", "alerts"]);

const SHORTCUTS = [
  { what: "Focus search", key: "/" },
  { what: "Ask the ERP — end the search with a question mark", key: "?  Enter" },
  { what: "Close a drawer or dialog", key: "Esc" },
  { what: "Show this list", key: "?" },
];

export function ErpShell({
  nav,
  user,
  hat,
  godowns,
  working,
  notifications,
  apps,
  voice = false,
  ask = false,
  children,
}: {
  nav: NavGroup[];
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string };
  hat: { label: string; sentence: string };
  godowns: { id: string; name: string }[];
  working: { id: string; name: string } | null;
  notifications: Notification[];
  /* The apps to switch between. Data, not a rendered switcher: an element
     built on the server and dropped into this header tripped React's key
     check on every render, which the CRM avoids by building its own. */
  apps: AppDefinition[];
  voice?: boolean;
  ask?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const toRow = (s: NavScreen, fallback: string): NavRowItem => ({
    href: s.href,
    label: s.label,
    icon: SCREEN_ICON[s.key] ?? fallback,
    exact: s.href === "/erp",
  });
  const pinned: NavRowItem[] = nav.filter((g) => PINNED_GROUPS.has(g.id)).flatMap((g) => g.screens.map((s) => toRow(s, g.icon)));
  const groups: NavRowGroup[] = nav
    .filter((g) => !PINNED_GROUPS.has(g.id))
    .map((g) => {
      const icon = GROUP_ICON[g.icon] ?? g.icon;
      return { label: g.label, icon, items: g.screens.map((s) => toRow(s, icon)) };
    });
  const counts = new Map(nav.flatMap((g) => g.screens.map((s) => [s.href, s.count ?? 0] as const)));

  return (
    <ToastProvider>
      <ErpUiProvider voice={voice}>
        <AppFrame
          header={
            <header className="z-30 flex h-14 flex-none items-center gap-5 border-b border-line bg-surface px-4">
              <div className="flex w-[216px] flex-none items-center gap-2">
                {apps.length > 1 ? <AppSwitcher apps={apps} current="erp" /> : null}
                <button
                  onClick={() => setCollapsed((c) => !c)}
                  title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
                >
                  <ShellIcon name="menu" size={18} />
                </button>
                <Link href="/erp" className="flex items-center gap-2 no-underline hover:no-underline">
                  <span className="flex h-4 w-4 flex-none items-center justify-center rounded-[3px] bg-brand">
                    <span className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
                  </span>
                  <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">MAHEK ERP</span>
                </Link>
              </div>

              <ErpSearch ask={ask} />

              <div className="flex-1" />

              <div className="flex items-center gap-2">
                <WorkingAt godowns={godowns} working={working} />
                <FeedbackButton />
                <button
                  onClick={() => setShortcutsOpen(true)}
                  title="Keyboard shortcuts"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] font-medium text-muted hover:bg-canvas hover:text-body"
                >
                  ?
                </button>
                <NotificationBell notifications={notifications} />
                <span className="mx-1 h-6 w-px bg-divider" />
                <AccountMenu user={user} hat={hat} variant="header" />
              </div>
            </header>
          }
          sidebar={
            <aside
              className={cx(
                "flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150",
                collapsed ? "w-14" : "w-[216px]",
              )}
            >
              <CollapsibleNav
                storageKey="erp.nav.open"
                ariaLabel="ERP sections"
                pinned={pinned}
                groups={groups}
                countFor={(item) => counts.get(item.href) ?? 0}
                railed={collapsed}
                renderIcon={renderIcon}
                /* Alerts are the one queue that is red whatever it counts: an
                   open alert is something the ERP could not explain. */
                badgeToneFor={(item) => (item.href === "/erp/alerts" ? "danger" : "warn")}
              />
              <div className="flex flex-none items-center border-t border-divider px-2 py-2">
                <AccountMenu user={user} hat={hat} variant="sidebar" collapsed={collapsed} />
              </div>
            </aside>
          }
        >
          {children}
        </AppFrame>

        <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts" width={460}>
          <div className="flex flex-col">
            {SHORTCUTS.map((s) => (
              <div key={s.what} className="flex items-center justify-between border-b border-divider py-2.5 last:border-0">
                <span className="text-sm text-body">{s.what}</span>
                <kbd className="rounded-[4px] border border-line bg-canvas px-2 py-0.5 font-mono text-xs text-body">{s.key}</kbd>
              </div>
            ))}
          </div>
        </Modal>
      </ErpUiProvider>
    </ToastProvider>
  );
}

/** Where this person is working — the CRM's Viewing switch, holding a godown. */
function WorkingAt({ godowns, working }: { godowns: { id: string; name: string }[]; working: { id: string; name: string } | null }) {
  const router = useRouter();
  const { push } = useToast();
  if (!godowns.length) {
    return (
      <span
        title="Ask an ERP administrator to assign you to a godown"
        className="flex h-7.5 items-center rounded-[4px] border border-dashed border-warn-line px-2 text-[13px] whitespace-nowrap text-warn-ink"
      >
        No godown assigned
      </span>
    );
  }
  return (
    <div className="flex h-7.5 items-center gap-1.5 rounded-[4px] border border-dashed border-line-strong pr-1 pl-2">
      <span className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">Working at</span>
      <GodownPicker
        look="chip"
        value={working?.id ?? ""}
        label={working?.name ?? "Choose one"}
        items={godowns.map((g) => ({ v: g.id, l: g.name }))}
        placeholder={`Search ${godowns.length} godowns you are assigned to`}
        onPick={(id) => {
          if (!id) return;
          void erpSetWorkingGodown(id).then((res) => {
            if (res.ok) {
              push(res.message ?? "Working location changed");
              router.refresh();
            } else push(res.error, "error");
          });
        }}
      />
    </div>
  );
}

/** Header search, drawn as the CRM's. `/` focuses it; a question ending in ? is asked of the ERP. */
function ErpSearch({ ask }: { ask: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ErpSearchHit[]>([]);
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<{ q: string; text: string; records: { label: string; href: string }[]; readAt: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const runAsk = () => {
    const question = q.trim();
    if (question.length < 3 || thinking) return;
    setThinking(true);
    void erpAsk(question).then((r) => {
      setThinking(false);
      setAnswer(r.ok ? { q: question, text: r.answer.answer, records: r.answer.records, readAt: r.answer.readAt } : { q: question, text: r.error, records: [], readAt: "" });
    });
  };
  const ref = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const clear = () => {
    setQ("");
    setAnswer(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null)?.tagName ?? "";
      if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") {
        e.preventDefault();
        ref.current?.focus();
      }
      if (e.key === "Escape") clear();
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) clear();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => {
      void erpSearch(term).then((r) => {
        setHits(r);
        setAsked(term);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const openRes = q.trim().length >= 2 && asked === q.trim();
  const go = (href: string) => {
    clear();
    router.push(href);
  };
  return (
    <div ref={wrapRef} className="relative w-[400px] min-w-0">
      <ShellIcon name="search" size={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAnswer(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ask && q.trim().endsWith("?")) runAsk();
        }}
        placeholder={ask ? "Search, or ask a question ending in ?" : "Search customers, orders, lots, PRs, bills, LRs…"}
        className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-ink outline-none focus:border-brand focus:bg-surface"
      />
      {openRes || answer || thinking ? (
        <div className="animate-fade-in absolute top-10 left-0 z-40 w-full overflow-hidden rounded-[6px] border border-line bg-surface py-1.5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          {ask ? (
            answer ? (
              <div role="status" className="border-b border-divider bg-brand-soft/40 px-3 py-2.5">
                <div className="text-[11px] font-medium tracking-[0.04em] text-[#5223E0] uppercase">Ask the ERP · {answer.q}</div>
                <div className="mt-1 text-sm leading-5 text-ink">{answer.text}</div>
                {answer.records.map((r) => (
                  <button key={r.href + r.label} onClick={() => go(r.href)} className="block w-full cursor-pointer py-1 text-left text-[13px] text-brand hover:underline">
                    {r.label} →
                  </button>
                ))}
                {answer.readAt ? (
                  <div className="mt-1 text-[11px] text-muted">
                    Read from the ERP at {new Date(answer.readAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} · answers only, it cannot change anything
                  </div>
                ) : null}
              </div>
            ) : (
              <button
                onClick={runAsk}
                disabled={thinking || q.trim().length < 3}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-[7px] text-left text-sm text-[#5223E0] hover:bg-canvas disabled:cursor-default"
              >
                <Icon n="spark" />
                {thinking ? "Reading the ERP…" : `Ask the ERP: “${q.trim()}”`}
              </button>
            )
          ) : null}
          {openRes && !answer && hits.length ? (
            <div className={cx(ask && "mt-1.5 border-t border-divider")}>
              {hits.map((r) => (
                <button
                  key={`${r.kind}:${r.href}`}
                  onClick={() => go(r.href)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                    <span className="block truncate text-[13px] text-muted">{r.meta}</span>
                  </span>
                  <span className="flex-none text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{r.kind}</span>
                </button>
              ))}
            </div>
          ) : null}
          {openRes && !answer && !hits.length ? (
            <div className="px-3 py-5 text-center text-sm text-muted">
              Nothing you can open matches “{q}”. Try a customer, order no, lot, PR, bill or LR{ask ? ", or ask it as a question" : ""}.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
