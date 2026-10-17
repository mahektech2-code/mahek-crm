import { requireHireScreen } from "@/lib/hire/access";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { lockedWhy } from "@/lib/hire/roles";
import { openRoles, searchFilterOptions } from "@/lib/hire/services/talent";
import { PageHead } from "../_ui/kit";
import { SearchScreen } from "./search-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Search" };

export default async function SearchPage() {
  const ctx = await requireHireScreen("search");
  const [opts, roles, ai] = await Promise.all([searchFilterOptions(ctx), openRoles(), aiState()]);
  return (
    <>
      <PageHead
        title="Search"
        sub={`Search every past candidate in plain words. Do-not-contact and retention rules are applied before results are shown.${ai.on ? "" : " AI is unavailable, so this matches words rather than meaning."}`}
      />
      <SearchScreen roles={opts.roles} locations={opts.locations} openRoles={roles.map((r) => ({ key: r.key, title: r.title }))} canAct={ctx.can("addCandidate")} why={lockedWhy("addCandidate")} />
    </>
  );
}
