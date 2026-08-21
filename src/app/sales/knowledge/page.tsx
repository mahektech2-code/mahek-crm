import { courses } from "@/lib/services/sales-service";
import { KnowledgeScreen } from "./knowledge-screen";

export const metadata = { title: "Knowledge — Sales Dashboard — MahekOne" };

export default async function Page() {
  return <KnowledgeScreen rows={await courses()} />;
}
