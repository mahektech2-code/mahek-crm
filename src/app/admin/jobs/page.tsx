import { jobHealth, queueOwners } from "@/lib/services/admin-platform-service";
import { today } from "@/lib/queries";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { JobsTab } from "../platform-real";

export default async function JobsPage() {
  await requirePlatformAdmin();
  const [jobs, queues] = await Promise.all([jobHealth(), queueOwners(await today())]);
  return (
    <AdminPage
      title="Jobs"
      subtitle="Scheduled work and how it has gone, the one-off jobs somebody runs by hand, and rebuilding a Call Log that is older than the release."
    >
      <JobsTab data={{ jobs, queues }} />
    </AdminPage>
  );
}
