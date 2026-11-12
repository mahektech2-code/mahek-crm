import { AppTasksPage } from "@/app/tasks/_ui/app-tasks-page";

export const metadata = { title: "My tasks - MahekOne CRM" };

/**
 * TeleCRM's own My tasks: the same rows as the Tasks app, narrowed to the ones
 * whose work happens in the CRM (and personal ones). What is waiting in other
 * apps is counted and named, so nothing is invisible from here.
 */
export default function CrmTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <AppTasksPage app="crm" searchParams={searchParams} />;
}
