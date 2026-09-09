import { deviceBindings } from "@/lib/services/sales-service";
import { pushReadiness, recentPushFailures } from "@/lib/mbos/push";
import { NotifyScreen } from "./notify-screen";

export const metadata = { title: "Send a notification — Sales Dashboard — MahekOne" };

export default async function Page() {
  const [rows, readiness, failures] = await Promise.all([
    deviceBindings(),
    /*
     * Whether push can reach anybody at all, and what has recently failed.
     *
     * This is the screen where somebody writes a message BY HAND and presses
     * send, so it is the one screen where "nothing arrived" is noticed — and
     * until now the only thing it could say was how many handsets had no
     * token. It could not say that push was switched off, that no project id
     * was configured, or that the last nine messages came back
     * `DeviceNotRegistered`. Sending into that silence and being told
     * "notification sent" is how a feature is believed to work for months.
     */
    pushReadiness(),
    recentPushFailures(8),
  ]);

  const people = rows.map((r) => ({
    id: r.salesmanId,
    name: r.salesmanName,
    hasPush: !!r.hasPushToken,
  }));

  return (
    <NotifyScreen
      people={people}
      readiness={{ ok: readiness.ok, why: readiness.why, reachable: readiness.reachable }}
      failures={failures.map((f) => ({
        id: f.id,
        errorCode: f.errorCode ?? "unknown",
        errorDetail: f.errorDetail,
        sentAt: f.sentAt.toISOString(),
      }))}
    />
  );
}
