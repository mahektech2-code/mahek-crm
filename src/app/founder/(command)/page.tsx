import { redirect } from "next/navigation";
import { founderAccess } from "@/lib/command-centre/access";
import { readPeriodState } from "@/lib/command-centre/period";
import { providerFor } from "@/lib/command-centre/registry";
import { companyPayload, SECTION_TITLE } from "@/lib/command-centre/company";
import { shellChrome } from "@/lib/command-centre/shell";
import { QUICK_ITEMS } from "@/lib/command-centre/quick";
import { ASK_SUGGESTIONS } from "@/lib/command-centre/ask";
import { isSectionKey, type CompanyPayload, type SectionKey, type SectionPayload } from "@/lib/command-centre/types";
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
 *
 * `q` and `open` are how a founder DESK hands over what somebody did in the
 * shared header there — typed a search, pressed Quick action or Ask — since
 * those open overlays that live on this page.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; p?: string; from?: string; to?: string; q?: string; open?: string }>;
}) {
  const params = await searchParams;
  const access = await founderAccess();
  if (!access.allowed.length) redirect("/apps");

  const wanted: SectionKey = isSectionKey(params.s) ? params.s : "company";
  const section = access.allowed.includes(wanted) ? wanted : access.allowed[0]!;
  if (section !== wanted && params.s) redirect(`/founder?s=${section}`);

  const period = await readPeriodState(params.p, { from: params.from, to: params.to });
  const ctx = { period, userId: access.user.id };

  const [chrome, company, payload] = await Promise.all([
    shellChrome(access),
    section === "company" ? companyPayload(period) : Promise.resolve(null as CompanyPayload | null),
    section !== "company" && section !== "inbox"
      ? providerFor(section).then((p) => p.section(ctx))
      : Promise.resolve(null as SectionPayload | null),
  ]);

  const open = params.open === "quick" || params.open === "ask" ? params.open : undefined;

  return (
    <CommandCentre
      key={`${section}|${period.key}|${period.from}|${period.to}`}
      section={section}
      shell={{
        user: chrome.user,
        period,
        navCounts: chrome.navCounts,
        freshness: chrome.freshness,
        inbox: chrome.inbox,
        allowed: access.allowed,
      }}
      canAct={access.level !== "associate"}
      switcherApps={chrome.switcherApps}
      company={company}
      payload={payload}
      quickItems={QUICK_ITEMS}
      askSuggestions={ASK_SUGGESTIONS}
      initial={params.q || open ? { q: params.q?.slice(0, 80), open } : undefined}
    />
  );
}
