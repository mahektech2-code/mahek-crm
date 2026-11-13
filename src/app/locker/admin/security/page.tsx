import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { currentKekVersion, vaultReady } from "@/lib/locker/crypto";
import { lockerSettingsRow } from "@/lib/locker/service";
import { PageHead } from "../../_ui/kit";
import { SecurityScreen } from "./security-screen";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.settings");
  const s = await lockerSettingsRow();
  return (
    <>
      <PageHead
        crumb="Locker · Admin"
        title="Security"
        sub="How each level of secret is revealed, how often passwords change, and how emergency access works. Two rules are not settings: a restricted reveal always needs a second person, and emergency access is never started and approved by the same person."
      />
      <SecurityScreen settings={s} vault={{ ready: vaultReady(), kekVersion: currentKekVersion(), explicit: !!process.env.LOCKER_KEK }} />
    </>
  );
}
