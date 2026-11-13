import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { pendingApprovals } from "@/lib/locker/vault-service";
import { PageHead } from "../_ui/kit";
import { btnStyle } from "@/lib/locker/style";
import { ApprovalsScreen } from "./approvals-screen";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.approvals");
  const [data, access] = await Promise.all([pendingApprovals(user.id), lockerAccess(user.id)]);
  return (
    <>
      <PageHead
        crumb="Locker · My work"
        title="Approvals"
        sub="Requests that need your decision. Restricted reveals and emergency access always need a second person — never the one who asked."
        actions={
          access.vault ? (
            <Link href="/locker/emergency" style={btnStyle("d")}>
              Start emergency access
            </Link>
          ) : null
        }
      />
      <ApprovalsScreen data={data} />
    </>
  );
}
