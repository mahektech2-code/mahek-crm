import { migrationStatus } from "@/lib/services/admin-platform-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { MigrationsTab } from "../platform-real";

export default async function DatabasePage() {
  await requirePlatformAdmin();
  return (
    <AdminPage title="Database" subtitle="Whether this database's schema is up to date with the code, read from Drizzle's own record.">
      <MigrationsTab data={{ migrations: await migrationStatus() }} />
    </AdminPage>
  );
}
