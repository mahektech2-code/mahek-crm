import { AppTasksPage } from "@/app/tasks/_ui/app-tasks-page";

export const metadata = { title: "My tasks - MahekOne Founder" };

/** The Founder app's own My tasks, as a desk in the Command Centre's frame. */
export default function FounderMyTasksPage() {
  return <AppTasksPage app="founder" className="max-w-[1200px]" />;
}
