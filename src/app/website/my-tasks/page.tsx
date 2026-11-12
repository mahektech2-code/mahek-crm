import { AppTasksPage } from "@/app/tasks/_ui/app-tasks-page";

export const metadata = { title: "My tasks - MahekOne Website" };

/** Website's own My tasks — its tasks and personal ones, always open to whoever holds the app. */
export default function MyTasksPage() {
  return <AppTasksPage app="website" />;
}
