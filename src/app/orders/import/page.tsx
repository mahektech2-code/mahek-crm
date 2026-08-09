import { importState } from "@/lib/services/bill-import-service";
import { ImportScreen } from "./import-screen";

export const metadata = { title: "Sheet import — Accounts — MahekOne" };

export default async function Page() {
  return <ImportScreen state={await importState()} />;
}
