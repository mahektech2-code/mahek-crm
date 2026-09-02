import { deviceBindings } from "@/lib/services/sales-service";
import { NotifyScreen } from "./notify-screen";

export const metadata = { title: "Send a notification — Sales Dashboard — MahekOne" };

export default async function Page() {
  const rows = await deviceBindings();
  const people = rows.map((r) => ({
    id: r.salesmanId,
    name: r.salesmanName,
    hasPush: !!r.hasPushToken,
  }));

  return <NotifyScreen people={people} />;
}
