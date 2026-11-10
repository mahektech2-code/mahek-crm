import { redirect } from "next/navigation";
import { founderAccess } from "@/lib/command-centre/access";
import { readPeriodState } from "@/lib/command-centre/period";
import { marginLines, marginRules, MARGIN_LINE_CAP } from "@/lib/services/margin-service";
import { ADMIN } from "@/lib/admin-routes";
import { MarginsDesk } from "./margins-desk";

export const metadata = { title: "Margins - Founder Command Centre - MahekOne" };

/**
 * THE FOUNDER'S MARGINS DESK — one entry under Sell, six sub-tabs, read off
 * the ERP's billed and dispatched lines for the period and the equal span
 * before it. The page reads; the desk adds up, filters and draws, so a figure
 * on one tab and the line under it come from the same rows.
 */
export default async function MarginsPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; from?: string; to?: string; v?: string }>;
}) {
  const params = await searchParams;
  const access = await founderAccess();
  if (!access.allowed.includes("margins")) redirect("/founder");

  const period = await readPeriodState(params.p, { from: params.from, to: params.to });
  const [cur, prev, rules] = await Promise.all([
    marginLines(period.from, period.to),
    marginLines(period.compareFrom, period.compareTo),
    marginRules(),
  ]);

  return (
    <MarginsDesk
      key={`${period.key}|${period.from}|${period.to}`}
      period={period}
      cur={cur.lines}
      prev={prev.tooWide ? null : prev.lines}
      tooWide={cur.tooWide}
      cap={MARGIN_LINE_CAP}
      rules={rules}
      rulesHref={access.level === "admin" ? ADMIN.settingsFor("reports", "margins") : null}
      initialView={params.v ?? null}
    />
  );
}
