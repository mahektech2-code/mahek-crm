import { redirect } from "next/navigation";
import { founderAccess } from "@/lib/command-centre/access";
import { readPeriodState } from "@/lib/command-centre/period";
import { providerFor } from "@/lib/command-centre/registry";
import { companyPayload, SECTION_TITLE } from "@/lib/command-centre/company";
import { inboxFor } from "@/lib/command-centre/inbox";
import { QUICK_ITEMS } from "@/lib/command-centre/quick";
import { ASK_SUGGESTIONS } from "@/lib/command-centre/ask";
import { initials } from "@/lib/command-centre/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { isSectionKey, type CompanyPayload, type NavCounts, type SectionKey, type SectionPayload, type Tone } from "@/lib/command-centre/types";
import { CommandCentre } from "./command-centre";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const { s } = await searchParams;
  const title = isSectionKey(s) ? SECTION_TITLE[s] : "Company";
  return { title: `${title} - Founder Command Centre - MahekOne` };
}

/**
 * The Founder Command Centre — one page, fifteen sections, addressed
 * `/founder?s=<section>&p=<period>`. Everything on it is read on the server
 * from the owning apps' services; the client only draws it and calls back.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; p?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const access = await founderAccess();
  if (!access.allowed.length) redirect("/apps");

  const wanted: SectionKey = isSectionKey(params.s) ? params.s : "company";
  const section = access.allowed.includes(wanted) ? wanted : access.allowed[0]!;
  if (section !== wanted && params.s) redirect(`/founder?s=${section}`);

  const period = await readPeriodState(params.p, { from: params.from, to: params.to });
  const ctx = { period, userId: access.user.id };

  const [apps, inbox, hat, freshness, company, payload] = await Promise.all([
    listUserApps(access.user.id),
    access.allowed.includes("inbox") ? inboxFor(access.user.id) : Promise.resolve([]),
    hatForHeader(access.user, "founder"),
    import("@/lib/command-centre/freshness")
      .then((m) => m.freshnessSummary())
      .catch(() => ({ tone: "muted" as Tone, line: "Freshness could not be read", staleCount: 0 })),
    section === "company" ? companyPayload(period) : Promise.resolve(null as CompanyPayload | null),
    section !== "company" && section !== "inbox"
      ? providerFor(section).then((p) => p.section(ctx))
      : Promise.resolve(null as SectionPayload | null),
  ]);

  const live = inbox.filter((i) => !i.handed && !i.snoozed);
  const navCounts: NavCounts = { inbox: live.length };
  for (const i of live) if (i.go !== "company" && i.go !== "inbox") navCounts[i.go] = (navCounts[i.go] ?? 0) + 1;
  if ("staleCount" in freshness && freshness.staleCount) navCounts.system = Math.max(navCounts.system ?? 0, freshness.staleCount);

  return (
    <CommandCentre
      key={`${section}|${period.key}|${period.from}|${period.to}`}
      section={section}
      shell={{
        user: { name: access.user.name, initials: initials(access.user.name), hatLabel: `${hat.label} · Founder` },
        period,
        navCounts,
        freshness: { tone: freshness.tone, line: freshness.line },
        inbox,
        allowed: access.allowed,
      }}
      canAct={access.level !== "associate"}
      switcherApps={apps.length > 1 ? webApps(apps) : null}
      company={company}
      payload={payload}
      quickItems={QUICK_ITEMS}
      askSuggestions={ASK_SUGGESTIONS}
    />
  );
}
