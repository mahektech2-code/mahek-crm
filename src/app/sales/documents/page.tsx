import { documentPeople, documents } from "@/lib/services/sales-service";
import { DocumentsScreen } from "./documents-screen";

export const metadata = { title: "Documents — Sales Dashboard — MahekOne" };

export default async function Page() {
  const [rows, people] = await Promise.all([documents(), documentPeople()]);
  return <DocumentsScreen rows={rows} people={people} />;
}
