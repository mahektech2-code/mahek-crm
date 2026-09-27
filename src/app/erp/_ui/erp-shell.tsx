"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { erpSearch, erpSetWorkingGodown, type ErpSearchHit } from "@/lib/actions/erp";
import { GodownPicker } from "./godown-picker";
import { Icon } from "./icons";
import { ErpUiProvider, useErpUi } from "./erp-ui";

/* ---------------------------------------------------------------------------
 * The ERP shell, from the design: a 56px header (wordmark, the way back to the
 * launcher, global search, the working-location picker, the person) and a
 * grouped sidebar that becomes a drawer under 1024px. Only screens the person
 * holds are drawn; the server decided which those are.
 * ------------------------------------------------------------------------- */

export type NavScreen = { key: string; label: string; href: string; count?: number };
export type NavGroup = { id: string; label: string; icon: string; single: boolean; screens: NavScreen[] };

export function ErpShell({
  nav,
  user,
  godowns,
  working,
  accountMenu,
  switcher,
  children,
}: {
  nav: NavGroup[];
  user: { name: string; title: string; initials: string };
  godowns: { id: string; name: string }[];
  working: { id: string; name: string } | null;
  accountMenu?: React.ReactNode;
  switcher?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <ErpUiProvider>
      <ShellInner nav={nav} user={user} godowns={godowns} working={working} accountMenu={accountMenu} switcher={switcher}>
        {children}
      </ShellInner>
    </ErpUiProvider>
  );
}

function useWidth(): number {
  const [w, setW] = useState(1440);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function ShellInner({
  nav,
  user,
  godowns,
  working,
  accountMenu,
  switcher,
  children,
}: {
  nav: NavGroup[];
  user: { name: string; title: string; initials: string };
  godowns: { id: string; name: string }[];
  working: { id: string; name: string } | null;
  accountMenu?: React.ReactNode;
  switcher?: React.ReactNode;
  children: React.ReactNode;
}) {
  const vw = useWidth();
  const narrow = vw < 1024;
  const phone = vw < 640;
  const path = usePathname();
  const ui = useErpUi();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const current = nav.find((g) => g.screens.some((s) => (s.href === "/erp" ? path === "/erp" : path === s.href || path.startsWith(s.href + "/"))));
  const [openMods, setOpenMods] = useState<Record<string, boolean>>(() => (current ? { [current.id]: true } : {}));

  const header = (
    <header style={{ height: 56, flex: "none", position: "relative", zIndex: 7, background: "#FFFFFF", borderBottom: "1px solid #DDE1E8", display: "flex", alignItems: "center", gap: 12, padding: "0 16px" }}>
      {narrow ? (
        <button onClick={() => setNavOpen((o) => !o)} title="Menu" style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #DDE1E8", background: "#FFFFFF", borderRadius: 4, color: "#3D4453", cursor: "pointer", flex: "none" }}>
          <Icon n="menu" s={18} />
        </button>
      ) : null}
      <Link href="/erp" title="ERP dashboard" style={{ display: "flex", alignItems: "center", gap: 8, flex: "none", textDecoration: "none" }}>
        <span style={{ width: 16, height: 16, background: "#6835FB", borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <span style={{ width: 6, height: 6, background: "#C6FF34", borderRadius: 1, display: "block" }} />
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: "#161616", whiteSpace: "nowrap" }}>
          MAHEK <span style={{ color: "#6835FB" }}>ERP</span>
        </span>
      </Link>
      {switcher ?? (
        <Link href="/apps" title="Other MahekOne apps" style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #EDEFF3", borderRadius: 4, color: "#6B7385", flex: "none" }}>
          <Icon n="grid" />
        </Link>
      )}
      {!phone ? <GlobalSearch /> : null}
      <span style={{ flex: 1 }} />
      {godowns.length ? (
        <GodownPicker
          value={working?.id ?? ""}
          label={working?.name ?? "Choose a working location"}
          tint
          items={godowns.map((g) => ({ v: g.id, l: g.name }))}
          placeholder={`Search ${godowns.length} godowns you are assigned to`}
          onPick={(id) => {
            if (!id) return;
            void erpSetWorkingGodown(id).then((res) => {
              ui.toast(res.ok ? res.message ?? "Working location changed" : res.error);
              if (res.ok) router.refresh();
            });
          }}
        />
      ) : (
        <span title="Ask an ERP administrator to assign you to a godown" style={{ fontSize: 13, color: "#8A5C05", whiteSpace: "nowrap" }}>
          No godown assigned
        </span>
      )}
      {/* The shared account menu is the person: name, level, password and sign-out. */}
      {accountMenu ?? (
        <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
          <span style={{ width: 30, height: 30, borderRadius: 4, background: "#F1ECFF", color: "#5223E0", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{user.initials}</span>
          {!phone ? (
            <span style={{ lineHeight: "14px" }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#161616", whiteSpace: "nowrap" }}>{user.name}</span>
              <span style={{ display: "block", fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385", whiteSpace: "nowrap" }}>{user.title}</span>
            </span>
          ) : null}
        </span>
      )}
    </header>
  );

  const itemStyle = (on: boolean, indent: boolean): React.CSSProperties => ({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    height: 34,
    padding: indent ? "0 10px 0 38px" : "0 10px",
    border: "none",
    borderRadius: 6,
    background: on ? "#F1ECFF" : "transparent",
    boxShadow: on ? "inset 3px 0 0 #6835FB" : "none",
    color: on ? "#5223E0" : "#3D4453",
    fontSize: indent ? 13 : 14,
    fontWeight: on ? 500 : 400,
    cursor: "pointer",
    textAlign: "left",
    textDecoration: "none",
  });
  const isOn = (href: string) => (href === "/erp" ? path === "/erp" : path === href || path.startsWith(href + "/"));

  const sidebar = (
    <>
      {narrow && navOpen ? <div onClick={() => setNavOpen(false)} style={{ position: "fixed", inset: "56px 0 0 0", zIndex: 5, background: "rgba(22,22,22,0.35)" }} /> : null}
      <aside
        style={
          narrow
            ? { position: "fixed", left: 0, top: 56, bottom: 0, zIndex: 6, width: 260, background: "#FFFFFF", borderRight: "1px solid #DDE1E8", display: "flex", flexDirection: "column", transform: navOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 200ms cubic-bezier(0.2,0,0.2,1)", boxShadow: navOpen ? "0 8px 24px rgba(22,22,22,0.12)" : "none" }
            : { width: 240, flex: "none", background: "#FFFFFF", borderRight: "1px solid #DDE1E8", display: "flex", flexDirection: "column", minHeight: 0 }
        }
      >
        <nav style={{ flex: 1, overflowY: "auto", padding: "10px 8px 16px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
          {nav.map((g) => {
            const open = !!openMods[g.id] || current?.id === g.id;
            const n = g.screens.reduce((t, s) => t + (s.count ?? 0), 0);
            if (g.single) {
              const s = g.screens[0];
              return (
                <Link key={g.id} href={s.href} onClick={() => setNavOpen(false)} style={itemStyle(isOn(s.href), false)}>
                  <span style={{ display: "flex", color: "#6B7385" }}>
                    <Icon n={g.icon} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
                  {n > 0 ? <Count n={n} /> : null}
                </Link>
              );
            }
            return (
              <div key={g.id}>
                <button onClick={() => setOpenMods((m) => ({ ...m, [g.id]: !open }))} style={itemStyle(false, false)}>
                  <span style={{ display: "flex", color: "#6B7385" }}>
                    <Icon n={g.icon} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
                  {n > 0 && !open ? <Count n={n} /> : null}
                  <span style={{ display: "flex", color: "#C2C8D2" }}>
                    <Icon n={open ? "down" : "chev"} s={14} />
                  </span>
                </button>
                {open ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, margin: "1px 0 4px 0" }}>
                    {g.screens.map((s) => (
                      <Link key={s.key} href={s.href} onClick={() => setNavOpen(false)} style={itemStyle(isOn(s.href), true)}>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                        {s.count ? <Count n={s.count} /> : null}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );

  return (
    <AppFrame header={header} sidebar={sidebar} floor={false} bleed>
      {children}
    </AppFrame>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span style={{ minWidth: 20, height: 18, padding: "0 6px", borderRadius: 9, background: "#FDF6E7", color: "#8A5C05", fontSize: 11, fontWeight: 600, lineHeight: "18px", textAlign: "center" }}>
      {n > 999 ? "999+" : n}
    </span>
  );
}

/** Header search. `/` focuses it, as in the design. */
function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ErpSearchHit[]>([]);
  const [asked, setAsked] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null)?.tagName ?? "";
      if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") {
        e.preventDefault();
        ref.current?.focus();
      }
      if (e.key === "Escape") setQ("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
  return (
    <span style={{ position: "relative", flex: "1 1 360px", minWidth: 160, maxWidth: 440 }}>
      <span style={{ position: "absolute", left: 10, top: 9, color: "#6B7385", display: "flex" }}>
        <Icon n="search" />
      </span>
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search customers, orders, lots, PRs, bills, LRs   /"
        style={{ width: "100%", height: 34, padding: "0 12px 0 32px", border: "1px solid #DDE1E8", borderRadius: 4, background: "#F7F8FA", fontSize: 14, color: "#161616" }}
      />
      {openRes ? (
        <div style={{ position: "absolute", top: 40, left: 0, right: 0, background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: 6, boxShadow: "0 8px 24px rgba(22,22,22,0.12)", overflow: "hidden", zIndex: 10, animation: "erp-fade 120ms cubic-bezier(0.2,0,0.2,1)" }}>
          {hits.map((r) => (
            <button
              key={`${r.kind}:${r.href}`}
              onClick={() => {
                setQ("");
                router.push(r.href);
              }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", border: "none", borderTop: "1px solid #F7F8FA", background: "#FFFFFF", cursor: "pointer", textAlign: "left" }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385", width: 84, flex: "none" }}>{r.kind}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#161616" }}>{r.name}</span>
                <span style={{ display: "block", fontSize: 12, color: "#6B7385" }}>{r.meta}</span>
              </span>
            </button>
          ))}
          {!hits.length ? (
            <div style={{ padding: "14px 12px", fontSize: 13, color: "#6B7385" }}>
              Nothing you can open matches “{q}”. Try a customer, order no, lot, PR, bill or LR.
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
