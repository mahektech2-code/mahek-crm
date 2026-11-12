import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for My tasks: `enquiries.my-tasks`, always open to whoever holds the app. */
export default async function MyTasksModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "enquiries.my-tasks");
  return children;
}
