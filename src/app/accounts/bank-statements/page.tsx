import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { allBankAccounts, bankPowers, homeView } from "@/lib/services/bank-statement-service";
import { HomeScreen } from "./home-screen";

export const metadata = { title: "Bank statement management — Accounts — MahekOne" };

export default async function Page({ searchParams }: { searchParams: Promise<{ upload?: string; new?: string }> }) {
  const params = await searchParams;
  const [view, day, config, accounts, powers] = await Promise.all([homeView(), today(), getConfig(), allBankAccounts(), bankPowers()]);
  return (
    <HomeScreen
      view={view}
      today={day}
      retentionDays={config["bankStatements.pdfRetentionDays"]}
      allAccounts={accounts}
      canRecord={powers.record}
      canConfirm={powers.confirm}
      openUpload={params.upload ?? null}
      startUpload={params.new === "1"}
    />
  );
}
