import { documents } from "@/lib/services/sales-service";
import { DocumentsScreen } from "./documents-screen";

export const metadata = { title: "Documents — Sales Dashboard — MahekOne" };

export default async function Page() {
  return <DocumentsScreen rows={await documents()} />;
}
