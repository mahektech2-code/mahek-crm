"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AccountMenu } from "@/components/shell/account-menu";
import { HeaderLead } from "@/components/shell/header-lead";
import type { AppDefinition } from "@/lib/apps";
import { C, DensityProvider, LBL, LockerOverlays, Segmented, initials } from "./kit";
import { LkIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE LOCKER'S SHELL, drawn to the design: a white header with the switcher,
 * the collapse and "MAHEK ONE › Locker", the search across everything the
 * person may open ("/" focuses it), the density switch, the approvals bell and
 * the account; and the sidebar of grouped sections — the vault's group in its
 * own violet — that collapses to a rail of icons.
 * ------------------------------------------------------------------------- */

export type NavItem = { href: string; label: string; icon: string; count?: number; over?: boolean; warn?: boolean; match?: string[] };
export type NavGroup = { label: string; vault?: boolean; items: NavItem[] };

type Hit = { href: string; name: string; meta: string };
type HitGroup = { label: string; vault?: boolean; items: Hit[] };

export function LockerShell({
  nav,
  user,
  hat,
  apps,
  bell,
  vault,
  banner,
  children,
}: {
  nav: NavGroup[];
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string; title: string };
  hat: { label: string; sentence: string };
  apps: AppDefinition[];
  bell: { count: number; href: string };
  vault: boolean;
  /** Emergency access in force: the red bar everybody sees. */
  banner: { line: string } | null;
  children: React.ReactNode;
}) {
  const [rail, setRail] = useState(true);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HitGroup[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    try {
      const r = localStorage.getItem("lk.rail");
      const d = localStorage.getItem("lk.density");
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser's own storage, which the server cannot see */
      if (r === "0") setRail(false);
      if (d === "compact") setDensity("compact");
    } catch {
      /* private window: defaults stand */
    }
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") setQ("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/locker/search?q=${encodeURIComponent(needle)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { groups: [] }))
        .then((j: { groups: HitGroup[] }) => setHits(j.groups))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const open = q.trim().length >= 2;
  const toggleRail = () => {
    const v = !rail;
    try {
      localStorage.setItem("lk.rail", v ? "1" : "0");
    } catch {}
    setRail(v);
  };
  const isOn = (it: NavItem) => {
    const hrefs = [it.href, ...(it.match ?? [])];
    return hrefs.some((h) => (h === "/locker" ? pathname === "/locker" : pathname === h || pathname.startsWith(h + "/")));
  };
  /* The most specific match wins, so "All assets" is not lit on a category page. */
  const all = nav.flatMap((g) => g.items);
  const lit = all.filter(isOn).sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <LockerOverlays>
      <DensityProvider value={density}>
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: C.canvas, color: C.body, fontFamily: "'Google Sans Flex',system-ui,-apple-system,'Segoe UI',sans-serif", fontSize: 14, lineHeight: "20px", fontVariantNumeric: "tabular-nums" }}>
          {banner ? (
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "0 24px", height: 40, background: C.red, color: "#FFFFFF", fontSize: 13, fontWeight: 500 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FFFFFF", animation: "lk-pulse 1.4s ease-in-out infinite" }} />
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{banner.line}</span>
              <Link href="/locker/emergency" style={{ height: 28, padding: "0 12px", border: "1px solid rgba(255,255,255,0.6)", borderRadius: 4, color: "#FFFFFF", fontSize: 13, fontWeight: 500, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
                View emergency access
              </Link>
            </div>
          ) : null}
          <header style={{ height: 56, flex: "none", background: "#FFFFFF", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 12, padding: "0 16px", position: "relative", zIndex: 8 }}>
            <HeaderLead apps={apps} current="locker" collapsed={!rail} onToggleSidebar={toggleRail} href="/locker" label="MAHEK ONE" />
            <span style={{ color: "#C2C8D2" }}>›</span>
            <Link href="/locker" style={{ fontSize: 15, fontWeight: 600, color: C.brand, textDecoration: "none" }}>
              Locker
            </Link>
            <span style={{ position: "relative", width: 400, marginLeft: 16, flex: "0 1 400px", minWidth: 160 }}>
              <span style={{ position: "absolute", left: 10, top: 9, color: C.muted, display: "flex" }}>
                <LkIcon name="search" />
              </span>
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={vault ? "Search assets, logins…   /" : "Search assets…   /"}
                className="lk-gsearch"
                style={{ width: "100%", height: 34, padding: "0 12px 0 32px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.soft, fontSize: 14, color: C.ink }}
              />
              {open ? (
                <div style={{ position: "absolute", top: 40, left: 0, right: 0, background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, boxShadow: "0 8px 24px rgba(26,30,40,0.12)", overflow: "hidden", animation: "lk-pop 150ms cubic-bezier(0.2,0,0.2,1)" }}>
                  {(hits ?? []).map((g) => (
                    <div key={g.label}>
                      <div style={{ ...LBL, fontSize: 11, padding: "8px 12px 4px 12px", background: g.vault ? C.v50 : C.canvas, color: g.vault ? C.v700 : C.muted }}>{g.label}</div>
                      {g.items.map((r) => (
                        <button
                          key={r.href}
                          type="button"
                          onClick={() => {
                            setQ("");
                            setHits(null);
                            router.push(r.href);
                          }}
                          className="lk-hover"
                          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px", border: "none", borderTop: `1px solid ${C.soft}`, background: "#FFFFFF", cursor: "pointer", textAlign: "left" }}
                        >
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                            <span style={{ display: "block", fontSize: 12, color: C.muted }}>{r.meta}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {hits && !hits.length ? <div style={{ padding: "14px 12px", fontSize: 13, color: C.muted }}>Nothing you can open matches “{q}”.</div> : null}
                  {!hits ? <div style={{ padding: "14px 12px", fontSize: 13, color: C.muted }}>Searching…</div> : null}
                </div>
              ) : null}
            </span>
            <span style={{ flex: 1 }} />
            <Segmented
              dark
              opts={[
                { key: "comfortable", label: "Comfortable" },
                { key: "compact", label: "Compact" },
              ]}
              value={density}
              onPick={(k) => {
                try {
                  localStorage.setItem("lk.density", k);
                } catch {}
                setDensity(k);
              }}
            />
            <Link
              href={bell.href}
              title="Approvals and notifications"
              style={{ position: "relative", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.line}`, background: "#FFFFFF", borderRadius: 4, color: C.body, flex: "none" }}
            >
              <LkIcon name="bell" size={18} />
              {bell.count > 0 ? (
                <span style={{ position: "absolute", top: -5, right: -5, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: C.red, color: "#FFFFFF", fontSize: 11, fontWeight: 600, lineHeight: "18px", textAlign: "center" }}>{bell.count}</span>
              ) : null}
            </Link>
            <AccountMenu user={user} hat={hat} variant="header" />
          </header>

          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <aside style={{ width: rail ? 240 : 64, flex: "none", background: "#FFFFFF", borderRight: `1px solid ${C.line}`, display: "flex", flexDirection: "column", minHeight: 0, transition: "width 200ms cubic-bezier(0.2,0,0.2,1)" }}>
              <nav aria-label="Locker sections" style={{ flex: 1, overflowY: "auto", padding: "8px 8px 16px 8px" }}>
                {nav.map((g) => (
                  <div key={g.label} style={{ marginTop: 10 }}>
                    {rail ? (
                      <div style={{ padding: "6px 10px 4px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: g.vault ? C.v500 : C.muted }}>{g.vault ? "◈ " + g.label : g.label}</div>
                    ) : (
                      <div style={{ height: 1, background: g.vault ? C.v100 : C.line2, margin: "6px 10px" }} />
                    )}
                    {g.items.map((it) => {
                      const on = lit === it.href;
                      const v = !!g.vault;
                      return (
                        <Link
                          key={it.href}
                          href={it.href}
                          title={it.label}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "100%",
                            height: 36,
                            padding: rail ? "0 10px" : 0,
                            justifyContent: rail ? "flex-start" : "center",
                            borderRadius: 4,
                            background: on ? (v ? C.v50 : C.brandSoft) : "transparent",
                            boxShadow: on ? `inset 3px 0 0 ${v ? C.v700 : C.brand}` : "none",
                            color: on ? (v ? C.v900 : C.brandInk) : v ? C.v700 : C.body,
                            fontSize: 14,
                            fontWeight: on ? 500 : 400,
                            position: "relative",
                            textDecoration: "none",
                          }}
                        >
                          <span style={{ display: "flex", flex: "none" }}>
                            <LkIcon name={it.icon} size={20} />
                          </span>
                          {rail ? <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>{it.label}</span> : null}
                          {it.warn && rail ? (
                            <span title="Governs flammable and hazardous storage" style={{ fontSize: 12, color: C.red }}>
                              ⚠
                            </span>
                          ) : null}
                          {it.count ? (
                            <span
                              style={{
                                minWidth: 20,
                                height: 18,
                                padding: "0 6px",
                                borderRadius: 9,
                                fontSize: 11,
                                fontWeight: 600,
                                lineHeight: "18px",
                                textAlign: "center",
                                background: it.over ? C.redSoft : C.amberSoft,
                                color: it.over ? C.red : C.amber,
                                ...(rail ? {} : { position: "absolute", top: 2, right: 6, minWidth: 16, height: 16, lineHeight: "16px", padding: "0 4px" }),
                              }}
                            >
                              {it.count.toLocaleString("en-IN")}
                            </span>
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </nav>
              <div style={{ flex: "none", borderTop: `1px solid ${C.line2}`, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 32, height: 32, borderRadius: "50%", background: C.brandSoft, color: C.brandInk, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{initials(user.name)}</span>
                  {rail ? (
                    <span style={{ minWidth: 0, lineHeight: "16px" }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{user.name}</span>
                      <span style={{ display: "block", fontSize: 12, color: C.muted }}>{user.title || user.role}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            </aside>
            <main id="lk-main" style={{ flex: 1, minWidth: 0, overflow: "auto", position: "relative" }}>
              {children}
            </main>
          </div>
        </div>
      </DensityProvider>
    </LockerOverlays>
  );
}
