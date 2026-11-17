import { fleetCounts } from "@/lib/services/admin-devices-view-service";
import { requirePlatformAdmin } from "../_shell/context";
import { HandsetsSection } from "../handsets-section";

/** Which MBOS build every salesman's phone is running, and how each one stands, read live. */
export default async function HandsetsPage() {
  await requirePlatformAdmin();
  return <HandsetsSection tabCounts={await fleetCounts()} />;
}
