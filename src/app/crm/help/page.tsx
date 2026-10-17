import { requireUser } from "@/lib/auth";
import { levelInApp } from "@/lib/access-control";
import { listHelpArticles } from "@/lib/queries";
import { calendarDate } from "@/lib/business-date";
import { HelpScreen } from "./help-screen";

export const metadata = { title: "Help center - MahekOne CRM" };

export default async function HelpPage() {
  const user = await requireUser();
  const articles = await listHelpArticles();

  return (
    <HelpScreen
      /* The CRM level, not `users.role` — the widest level held in any app,
         which put a telecaller who managed Reports on the managers' articles. */
      role={(await levelInApp(user, "crm")) ?? "associate"}
      articles={articles.map((a) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        roles: a.roles,
        isScript: a.type === "call_script",
        scriptBody: a.scriptBody,
        body: a.body,
        updatedOn: calendarDate(a.updatedAt),
      }))}
    />
  );
}
