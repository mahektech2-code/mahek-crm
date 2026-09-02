import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { visitsList } from "@/lib/services/sales-service";
import { VisitsScreen } from "./visits-screen";

export const metadata = { title: "Visits — Sales Dashboard — MahekOne" };

/**
 * Every visit logged on a day.
 *
 * The design's subtitle carries the rule that matters: **an unverified visit
 * still counts as work — it needs a word from you.** The handset saves a visit
 * whatever the checklist says, because refusing teaches people to stop logging
 * them and then the office knows nothing rather than something imperfect. What
 * it records instead is WHY it could not be verified, and that sentence is the
 * column a manager reads.
 *
 * An off-plan visit is treated the same way: it is ordinary — a shop that
 * called, a walk-in on the way past — and it carries the reason the salesman
 * gave rather than a flag implying he went wandering.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; show?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;

  const [all, config] = await Promise.all([visitsList(day), getConfig()]);
  const show = ["all", "unverified", "offplan"].includes(params.show ?? "")
    ? params.show!
    : "all";

  return (
    <VisitsScreen
      day={day}
      longDay={longDay(day)}
      all={all}
      show={show}
      mismatchThresholdM={config["mbos.location.visitMismatchM"]}
    />
  );
}

function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
