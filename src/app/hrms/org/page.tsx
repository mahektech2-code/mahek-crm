import { orgChart } from "@/lib/services/org-service";
import { OrgScreen } from "./org-screen";

export const metadata = { title: "Org chart — HRMS — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ leavers?: string }>;
}) {
  const { leavers } = await searchParams;
  const includeLeavers = leavers === "1";
  const chart = await orgChart(includeLeavers);
  return <OrgScreen chart={chart} includeLeavers={includeLeavers} />;
}
