import { getConfig } from "@/lib/config/store";
import { orgChart } from "@/lib/services/org-service";
import { OrgScreen } from "./org-screen";

export const metadata = { title: "Org chart — HRMS — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ leavers?: string; view?: string }>;
}) {
  const { leavers, view } = await searchParams;
  const includeLeavers = leavers === "1";
  const [chart, config] = await Promise.all([orgChart(includeLeavers), getConfig()]);
  // In the URL rather than in state: an edit calls router.refresh(), and a
  // view chosen in a component would snap back to the default underneath it.
  return (
    <OrgScreen
      chart={chart}
      includeLeavers={includeLeavers}
      view={view === "list" ? "list" : "tree"}
      company={config["people.companyName"]}
    />
  );
}
