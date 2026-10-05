import { designationRoster } from "@/lib/services/erp-designation-service";
import { requirePlatformAdmin } from "../_shell/context";
import { DesignationsScreen } from "./designations-screen";

export default async function DesignationsPage() {
  await requirePlatformAdmin();
  const roster = await designationRoster();
  return <DesignationsScreen roster={roster} />;
}
