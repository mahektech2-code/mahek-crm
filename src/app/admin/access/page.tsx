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
      /* Read off the GRANTS, never the label beside a level — a label is a
         sentence somebody may reword, and nothing may be decided from one.
         `users.role` would give the same answer today, since it now derives
         `admin` for a platform administrator alone, but it is a cache of the
         grants and the context already asked the grants themselves. The page
         gate above means this is always true here; it is passed rather than
         assumed so the screen stays read-only if that gate ever loosens. */
      isPlatformAdmin={ctx.isPlatformAdmin}
      onlyApp={onlyApp}
    />
  );
}
