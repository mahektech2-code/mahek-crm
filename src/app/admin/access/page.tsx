import { APPS, type AppId } from "@/lib/apps";
import { listAccess } from "@/lib/services/access-service";
import { requirePlatformAdmin } from "../_shell/context";
import { AccessScreen } from "./access-screen";

export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  const ctx = await requirePlatformAdmin();
  const [{ app }, rows] = await Promise.all([searchParams, listAccess()]);
  const onlyApp = APPS.some((a) => a.id === app) ? (app as AppId) : null;
  return (
    <AccessScreen
      rows={rows}
      /* The LEVEL on the account, never the label beside it — a label is a
         sentence somebody may reword, and nothing may be decided from one. */
      isAdmin={ctx.user.role === "admin"}
      onlyApp={onlyApp}
    />
  );
}
