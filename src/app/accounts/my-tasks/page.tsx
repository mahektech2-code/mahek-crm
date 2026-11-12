import { AppTasksPage } from "@/app/tasks/_ui/app-tasks-page";

export const metadata = { title: "My tasks - MahekOne Accounts" };

/** Accounts's own My tasks — its tasks and personal ones, always open to whoever holds the app. */
export default function MyTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <AppTasksPage app="accounts" searchParams={searchParams} />;
}
