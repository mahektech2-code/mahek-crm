import "server-only";
import { listUserApps } from "@/lib/access";
import { webApps, type AppDefinition } from "@/lib/apps";
import { hatForHeader } from "@/lib/hat-for-header";
import { inboxFor } from "./inbox";
import { initials } from "./format";
import type { founderAccess } from "./access";
import type { InboxItem, NavCounts, Tone } from "./types";

/* ---------------------------------------------------------------------------
 * What the header and the sidebar need, read ONCE for the Command Centre page
 * and for the two founder desks. The desks draw the same furniture, so the
 * counts on the sidebar and the bell have to come from the same reading — a
 * WhatsApp badge that said 2 on the page and 0 on the desk beside it is a
 * sidebar nobody trusts.
 * ------------------------------------------------------------------------- */

export type ShellChrome = {
  user: { name: string; initials: string; hatLabel: string };
  switcherApps: AppDefinition[] | null;
  inbox: InboxItem[];
  liveCount: number;
  navCounts: NavCounts;
  freshness: { tone: Tone; line: string };
};

export async function shellChrome(access: Awaited<ReturnType<typeof founderAccess>>): Promise<ShellChrome> {
  const [apps, inbox, hat, freshness] = await Promise.all([
    listUserApps(access.user.id),
    access.allowed.includes("inbox") ? inboxFor(access.user.id) : Promise.resolve([] as InboxItem[]),
    hatForHeader(access.user, "founder"),
    import("./freshness")
      .then((m) => m.freshnessSummary())
      .catch(() => ({ tone: "muted" as Tone, line: "Freshness could not be read", staleCount: 0 })),
  ]);

  const live = inbox.filter((i) => !i.handed && !i.snoozed);
  const navCounts: NavCounts = { inbox: live.length };
  for (const i of live) if (i.go !== "company" && i.go !== "inbox") navCounts[i.go] = (navCounts[i.go] ?? 0) + 1;
  if ("staleCount" in freshness && freshness.staleCount) navCounts.system = Math.max(navCounts.system ?? 0, freshness.staleCount);

  return {
    user: { name: access.user.name, initials: initials(access.user.name), hatLabel: `${hat.label} · Founder` },
    switcherApps: apps.length > 1 ? webApps(apps) : null,
    inbox,
    liveCount: live.length,
    navCounts,
    freshness: { tone: freshness.tone, line: freshness.line },
  };
}
