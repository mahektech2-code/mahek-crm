import { fleetCounts } from "@/lib/services/admin-devices-view-service";
import { requirePlatformAdmin } from "../_shell/context";
import { FactoryHandsetsSection } from "../factory-handsets-section";

/** Every factory phone, as it last described itself, read live. */
export default async function FactoryHandsetsPage() {
  await requirePlatformAdmin();
  return <FactoryHandsetsSection tabCounts={await fleetCounts()} />;
}
