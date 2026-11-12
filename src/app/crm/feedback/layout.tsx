import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for Feedback: `crm.feedback`, always open to whoever holds the app. */
export default async function FeedbackModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.feedback");
  return children;
}
