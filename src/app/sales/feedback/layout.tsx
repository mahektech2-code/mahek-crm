import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for Feedback: `sales.feedback`, always open to whoever holds the app. */
export default async function FeedbackModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "sales.feedback");
  return children;
}
