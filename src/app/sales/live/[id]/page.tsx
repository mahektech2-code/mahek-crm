import { notFound } from "next/navigation";
import { getConfig } from "@/lib/config/store";
import { dropInaccurateFixes } from "@/lib/engines/trail-gaps";
import { nowMs } from "@/lib/format";
import { today } from "@/lib/recompute";
import { liveOlaKey } from "@/lib/services/ola-key-service";
import { activityPointsForDay } from "@/lib/services/sales-service";
import { salesmanDay } from "@/lib/services/salesman-day-service";
import { SalesmanDayScreen } from "./salesman-day-screen";

export const metadata = { title: "Salesman's day — Sales Dashboard — MahekOne" };

/**
 * ONE SALESMAN'S WHOLE DAY, in a tab of its own.
 *
 * Today's list and the Live map's team rail open this in a new tab, which is
 * why it has no switcher: a manager closes the tab to get back to the team,
 * and a second way to change who is on screen would only make the URL lie
 * about what it shows. The map is his alone; the timeline beside it is every
 * punch, leg, stop, visit and act of the day, in order.
 *
 * Behind `sales.live` (the folder's layout) and narrowed by the manager's own
 * scope — `salesmanDay` answers null for somebody outside it, which is a 404
 * here rather than another man's day.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.day ?? "") ? query.day! : now;

  const [detail, config, olaMaps] = await Promise.all([salesmanDay(id, day), getConfig(), liveOlaKey()]);
  if (!detail) notFound();

  const accuracy = config["mbos.location.gpsAccuracyThresholdM"];
  const trail = dropInaccurateFixes(detail.trail, accuracy);
  /* The marks on his trail — every act with a position — are the Live map's own
     read, narrowed to him, so a pin here and a pin there are one row. */
  const activity = (await activityPointsForDay(day)).filter((a) => a.salesmanId === id);

  return (
    <SalesmanDayScreen
      key={`${id}:${day}`}
      day={day}
      isToday={day === now}
      today={now}
      detail={{ ...detail, trail }}
      activity={activity}
      olaMapsKey={olaMaps.key}
      olaKeysSpent={olaMaps.allSpent}
      nowMs={nowMs()}
      options={{
        gapMetres: config["mbos.location.trailGapMeters"],
        dwellRadiusMetres: config["mbos.location.dwellRadiusMeters"],
        dwellMinMinutes: config["mbos.location.dwellMinMinutes"],
        tripBreakMinutes: config["mbos.location.tripBreakMinutes"],
        staleAfterSeconds: config["mbos.location.activityFixMaxAgeSeconds"],
        pushSeconds: config["mbos.location.livePushSeconds"],
        pollSeconds: config["mbos.location.livePollSeconds"],
      }}
    />
  );
}
