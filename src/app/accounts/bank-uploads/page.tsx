import { today } from "@/lib/recompute";
import { bankAccounts, historyView, type HistoryFilter } from "@/lib/services/bank-statement-service";
import { getConfig } from "@/lib/config/store";
import { HistoryScreen } from "./history-screen";

export const metadata = { title: "Upload history — Bank statement management — Accounts — MahekOne" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  const filter: HistoryFilter = {
    account: p.account || null,
    period: p.period === "last" || p.period === "all" ? p.period : "month",
    by: p.by || null,
    q: p.q || null,
  };
  const [view, day, accounts, config] = await Promise.all([historyView(filter), today(), bankAccounts(), getConfig()]);
  return <HistoryScreen view={view} filter={filter} today={day} accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} retentionDays={config["bankStatements.pdfRetentionDays"]} />;
}
