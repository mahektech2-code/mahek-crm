"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { C, DesignStyles, EASE, Hov, Icon } from "../(command)/ui";
import { ASK_BUTTON, crumbFor, DeskTabs, FounderHeader, FounderSidebar, QUICK_BUTTON, SEARCH_BOX, tabIsOn, TITLES, TitleBlock, WHATSAPP_TABS } from "../(command)/chrome";
import { AppFrame } from "@/components/shell/app-frame";
import type { ShellChrome } from "@/lib/command-centre/shell";
import type { SectionKey } from "@/lib/command-centre/types";

/* ---------------------------------------------------------------------------
 * The founder DESKS in the Command Centre's own furniture.
 *
 * Price lists and WhatsApp are working screens rather than sections of the
 * page — the WhatsApp switch, the template mapping, the rule editor, the
 * price-list editor — so they keep their own routes. What they no longer keep
 * is a different app around them: the header, the sidebar and the title block
 * are the Command Centre's, from `chrome.tsx`, so the sidebar's WhatsApp entry
 * does not walk somebody out of the design.
 *
 * The header's search, Quick action and Ask open overlays that live on the
 * Command Centre page, so from a desk they hand over to it: `/founder?q=…` and
 * `/founder?open=quick|ask`.
 * ------------------------------------------------------------------------- */

function deskOf(pathname: string): SectionKey | null {
  if (pathname.startsWith("/founder/whatsapp")) return "whatsapp";
  if (pathname.startsWith("/founder/price-lists")) return "prices";
  return null;
}

export function DeskFrame({
  chrome,
  allowed,
  children,
}: {
  chrome: ShellChrome;
  allowed: SectionKey[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = React.useState("");

  // A printed price sheet is the paper and nothing else.
  if (pathname.endsWith("/print")) return <>{children}</>;

  const desk = deskOf(pathname) ?? "whatsapp";
  const go = (s: SectionKey) => router.push(s === "company" ? "/founder" : `/founder?s=${s}`);
  const tabs = desk === "whatsapp" ? WHATSAPP_TABS : null;
  const current = tabs?.find((t) => tabIsOn(t, pathname));

  return (
    <div className="fcc-desk" style={{ position: "fixed", inset: 0, overflowX: "auto", overflowY: "hidden", zIndex: 1 }}>
      <DesignStyles />
      <style>{`
.fcc-desk{font-family:"Google Sans Flex",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums lining-nums;background:${C.canvas}}
.fcc-desk .fcc-chrome button,.fcc-desk .fcc-chrome input{font:inherit;color:inherit}
@media print{.fcc-desk{position:static!important;overflow:visible!important}}
`}</style>
      <AppFrame
        bleed
        fade={false}
        header={
          <div className="fcc-root fcc-chrome" style={{ display: "contents" }}>
            <FounderHeader
              switcherApps={chrome.switcherApps}
              user={chrome.user}
              liveCount={chrome.liveCount}
              onBell={() => go("inbox")}
              search={
                <form
                  style={{ position: "relative", flex: "1 1 320px", minWidth: 160, maxWidth: 400, margin: 0 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = q.trim();
                    if (t.length >= 2) router.push(`/founder?q=${encodeURIComponent(t)}`);
                  }}
                >
                  <span style={{ position: "absolute", left: 10, top: 9, color: C.muted, display: "flex" }}>
                    <Icon name="search" />
                  </span>
                  <Hov
                    as="input"
                    value={q}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
                    placeholder="Search customers, staff, price lists, orders, bills"
                    title="Press Enter to search the whole company"
                    style={SEARCH_BOX}
                    focus={{ background: C.white, borderColor: C.brand }}
                  />
                </form>
              }
              actions={
                <>
                  <Hov onClick={() => router.push("/founder?open=quick")} style={{ ...QUICK_BUTTON, flex: "none" }} hover={{ background: C.brandDark }}>
                    ＋ Quick action
                  </Hov>
                  <Hov onClick={() => router.push("/founder?open=ask")} style={ASK_BUTTON} hover={{ background: C.brandTint2 }}>
                    <Icon name="spark" size={15} />
                    Ask the company
                  </Hov>
                </>
              }
            />
          </div>
        }
        sidebar={
          <div className="fcc-root fcc-chrome" style={{ display: "flex", flex: "none", minHeight: 0 }}>
            <FounderSidebar active={desk} allowed={allowed} navCounts={chrome.navCounts} freshness={chrome.freshness} onGo={go} />
          </div>
        }
      >
        {tabs ? (
          <div className="fcc-root fcc-chrome" style={{ display: "contents" }}>
            <TitleBlock
              crumb={crumbFor(desk)}
              title={TITLES[desk][0]}
              subtitle={current?.subtitle ?? TITLES[desk][1]}
              below={<DeskTabs tabs={tabs} pathname={pathname} />}
            />
          </div>
        ) : null}
        <div style={{ padding: "20px 28px 48px 28px", animation: `fd-fade 160ms ${EASE}` }}>{children}</div>
      </AppFrame>
    </div>
  );
}
