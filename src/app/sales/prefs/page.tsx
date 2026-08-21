import { fieldSettings } from "@/lib/services/sales-service";
import { SettingsScreen } from "./settings-screen";

export const metadata = { title: "Field settings — Sales Dashboard — MahekOne" };

export default async function Page() {
  const groups = await fieldSettings();
  return <SettingsScreen groups={groups} />;
}
