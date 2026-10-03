import { notificationLog } from "@/lib/services/admin-platform-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { NotificationsTab } from "../platform-real";

export default async function NotificationsPage() {
  await requirePlatformAdmin();
  return (
    <AdminPage title="Notifications" subtitle="What the platform has sent, to whom, and whether they have read it.">
      <NotificationsTab data={{ notifications: await notificationLog() }} />
    </AdminPage>
  );
}
