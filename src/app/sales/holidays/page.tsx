import { today } from "@/lib/recompute";
import { holidays } from "@/lib/services/sales-service";
import { HolidaysScreen } from "./holidays-screen";

export const metadata = { title: "Holidays — Sales Dashboard — MahekOne" };

export default async function Page() {
  const day = await today();
  const rows = await holidays(Number(day.slice(0, 4)));

  return <HolidaysScreen holidays={rows} todayIso={day} />;
}
