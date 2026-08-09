import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { RecordScreen } from "./record-screen";

export const metadata = { title: "Record a payment — MahekOne" };

export default async function Page() {
  const [{ allowed }, config, day] = await Promise.all([
    checkCapability("payment.confirm"),
    getConfig(),
    today(),
  ]);

  return (
    <RecordScreen
      // Whoever can confirm money is recording it as already seen. Everybody
      // else is reporting it, and the form says so before it is saved rather
      // than afterwards in a toast.
      confirmsOnSave={allowed}
      today={day}
      modes={config["payments.modes"]}
      referenceRequiredModes={config["payments.referenceRequiredModes"]}
      allowOnAccount={config["payments.allowOnAccountRemainder"]}
    />
  );
}
