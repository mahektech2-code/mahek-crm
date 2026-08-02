import { requireUser } from "@/lib/auth";
import { listHelpArticles } from "@/lib/queries";
import { HelpScreen } from "./help-screen";

export const metadata = { title: "Help center — MahekOne CRM" };

export default async function HelpPage() {
  const user = await requireUser();
  const articles = await listHelpArticles();

  return (
    <HelpScreen
      role={user.role}
      articles={articles.map((a) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        role: a.role,
        isScript: a.isScript,
        scriptBody: a.scriptBody,
        body: a.body,
        updatedOn: a.updatedOn,
      }))}
    />
  );
}
