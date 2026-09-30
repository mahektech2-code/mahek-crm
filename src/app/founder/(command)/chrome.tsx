"use client";

import * as React from "react";
import Link from "next/link";
import { C, Hov, Icon, upper } from "./ui";
import { AppSwitcher } from "@/components/shell/app-switcher";
import type { AppDefinition } from "@/lib/apps";
import type { NavCounts, SectionKey, Tone } from "@/lib/command-centre/types";

/* ---------------------------------------------------------------------------
 * The Command Centre's furniture — the header and the sidebar — as ONE copy.
 *
 * The Command Centre page draws them, and so do the two founder desks (price
 * lists and WhatsApp), which are real working screens of their own rather
 * than sections of the page. The desks used to sit in the older top-bar shell,
 * so opening WhatsApp from the sidebar walked out of the design into a
 * different-looking app. Two copies of this would drift within a release; the
 * half that drifts is the one somebody is looking at.
 *
 * What differs between the two callers is only what the header's search, Quick
 * action and Ask the company DO — overlays on the page, a hop back to it from a
 * desk — so those are slots, and the frame itself is the same everywhere.
 * ------------------------------------------------------------------------- */

export const NAV: { label: string; items: [SectionKey, string, string][] }[] = [
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

export const TITLES: Record<SectionKey, [string, string]> = {
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

/** "Command Centre · Founder desks" — the group a section sits in. */
export function crumbFor(section: SectionKey): string {
  if (section === "company") return "Command Centre";
  return `Command Centre · ${NAV.find((g) => g.items.some((i) => i[0] === section))?.label ?? ""}`;
}

export type ChromeUser = { name: string; initials: string; hatLabel: string };

export function FounderHeader({
  switcherApps,
  user,
  liveCount,
  onBell,
  search,
  actions,
}: {
  switcherApps: AppDefinition[] | null;
  user: ChromeUser;
  /** Live items in Needs you — the red count on the bell. */
  liveCount: number;
  onBell: () => void;
  /** The search box, with whatever it opens. */
  search: React.ReactNode;
  /** Quick action and Ask the company, with whatever they open. */
  actions: React.ReactNode;
}) {
  return (
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
      {search}
      <span style={{ flex: 1 }} />
      {actions}
      <Hov
        onClick={onBell}
        title="Needs you"
        style={{ position: "relative", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, color: C.muted, cursor: "pointer", flex: "none" }}
        hover={{ background: C.canvas, color: C.body }}
      >
        <Icon name="bell" />
        {liveCount > 0 ? (
          <span style={{ position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: C.bad, color: C.white, fontSize: 11, fontWeight: 500, lineHeight: "16px", textAlign: "center" }}>
            {liveCount}
          </span>
        ) : null}
      </Hov>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        <span style={{ width: 28, height: 28, borderRadius: 4, background: C.brandTint, color: C.brandDark, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {user.initials}
        </span>
        <span style={{ lineHeight: "14px" }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: C.ink, whiteSpace: "nowrap" }}>{user.name}</span>
          <span style={{ ...upper, display: "block", whiteSpace: "nowrap" }}>{user.hatLabel}</span>
        </span>
      </span>
    </header>
  );
}

/** The search box's look, shared so the desk's box is the page's box. */
export const SEARCH_BOX: React.CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 12px 0 32px",
  border: `1px solid ${C.line}`,
  borderRadius: 4,
  background: C.canvas,
  fontSize: 14,
  color: C.ink,
};

export const QUICK_BUTTON: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: `1px solid ${C.brand}`,
  background: C.brand,
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 500,
  color: C.white,
  cursor: "pointer",
};

export const ASK_BUTTON: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  border: `1px solid ${C.brandTint2}`,
  background: C.brandTint,
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 500,
  color: C.brandDark,
  cursor: "pointer",
  flex: "none",
};

export function FounderSidebar({
  active,
  allowed,
  navCounts,
  freshness,
  onGo,
}: {
  active: SectionKey;
  allowed: readonly SectionKey[];
  navCounts: NavCounts;
  freshness: { tone: Tone; line: string };
  onGo: (s: SectionKey) => void;
}) {
  return (
    <aside style={{ width: 232, flex: "none", background: C.white, borderRight: `1px solid ${C.line}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <nav style={{ flex: 1, overflowY: "auto", padding: "8px 6px 16px 6px" }}>
        {NAV.map((g) => {
          const items = g.items.filter(([k]) => allowed.includes(k));
          if (!items.length) return null;
          return (
            <div key={g.label}>
              <div style={{ ...upper, padding: "14px 12px 6px 12px" }}>{g.label}</div>
              {items.map(([k, label, ic]) => {
                const on = active === k;
                const c = navCounts[k] ?? 0;
                return (
                  <Hov
                    key={k}
                    onClick={() => onGo(k)}
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
          onClick={() => (allowed.includes("system") ? onGo("system") : undefined)}
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left" }}
        >
          <span
            style={{ width: 7, height: 7, borderRadius: "50%", background: freshness.tone === "good" ? C.good : freshness.tone === "bad" ? C.bad : C.warn, display: "block", flex: "none", animation: freshness.tone === "good" ? undefined : "fd-pulse 2s ease-in-out infinite" }}
          />
          <span style={{ fontSize: 13, color: C.ink }}>{freshness.line}</span>
        </button>
      </div>
    </aside>
  );
}

/** The sticky block every screen opens with: where you are, what it is, what it covers. */
export function TitleBlock({
  crumb,
  title,
  subtitle,
  right,
  below,
}: {
  crumb: string;
  title: string;
  subtitle: React.ReactNode;
  right?: React.ReactNode;
  below?: React.ReactNode;
}) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 2, background: C.canvas, borderBottom: `1px solid ${C.soft}`, padding: below ? "16px 28px 0 28px" : "16px 28px 14px 28px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>{crumb}</div>
          <div style={{ fontSize: 26, lineHeight: "32px", fontWeight: 600, color: C.ink, marginTop: 2 }}>{title}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ fontSize: 14, color: C.muted }}>{subtitle}</span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 8px", borderRadius: 11, background: C.white, border: `1px solid ${C.soft}`, fontSize: 12, color: C.body, whiteSpace: "nowrap" }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.good, display: "block" }} />
              Company-wide · every customer
            </span>
          </div>
        </div>
        {right}
      </div>
      {below}
    </div>
  );
}

export type DeskTab = { href: string; label: string; exact?: boolean; subtitle?: string };

/** WhatsApp is one section with three working pages behind it; the tabs join them. */
export const WHATSAPP_TABS: DeskTab[] = [
  { href: "/founder?s=whatsapp", label: "Overview" },
  {
    href: "/founder/whatsapp",
    label: "Setup",
    exact: true,
    subtitle:
      "Whether messages go to customers through the WhatsApp API at all is decided here, and only here. Off, every screen copies and pastes exactly as before.",
  },
  {
    href: "/founder/whatsapp/automation",
    label: "Automation",
    subtitle: "Rules that send the approved templates on their own — when each one fires, how often, and the hours anything may go out.",
  },
  {
    href: "/founder/whatsapp/contacts",
    label: "Contacts & DND",
    subtitle:
      "Every customer and whether WhatsApp messages may go to them. A customer on DND gets no message by any path — automatic or by hand — while calls carry on as before.",
  },
  {
    href: "/founder/whatsapp/messages",
    label: "Messages",
    subtitle:
      "Every message, and how far it got — sent, delivered, read and replied. Receipts come from WhatsApp itself for messages sent through the API; a message pasted by hand only has the person's confirmation.",
  },
];

/** The Overview tab is the Command Centre section itself, so it is "on" there and nowhere else. */
export function tabIsOn(tab: DeskTab, pathname: string): boolean {
  if (tab.href.includes("?")) return pathname === "/founder";
  return tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
}

export function DeskTabs({ tabs, pathname }: { tabs: DeskTab[]; pathname: string }) {
  return (
    <nav style={{ display: "flex", gap: 4, marginTop: 12 }}>
      {tabs.map((t) => {
        const on = tabIsOn(t, pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            style={{
              marginBottom: -1,
              padding: "8px 12px 10px 12px",
              borderBottom: `2px solid ${on ? C.brand : "transparent"}`,
              fontSize: 14,
              fontWeight: on ? 500 : 400,
              color: on ? C.brandDark : C.muted,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
