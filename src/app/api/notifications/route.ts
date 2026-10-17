import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { APP_IDS } from "@/lib/apps";
import { notificationFeed } from "@/lib/queries";

/**
 * The bell, asked again. `NotificationCenter` polls this every few seconds
 * from every MahekOne tab, so it is a few indexed reads of the person's own
 * rows and nothing else — no scope, because a notification is addressed to a
 * PERSON.
 *
 * `?app=` is the app the tab is showing, and narrows the list and the badge to
 * that app's notifications (and general ones). It grants nothing: every row
 * read is still the caller's own, so an unknown or missing app is simply
 * "every app".
 *
 * `no-store`: a cached answer here is a notification that arrives late.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "signed_out" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const asked = new URL(request.url).searchParams.get("app");
  const app = asked && (APP_IDS as readonly string[]).includes(asked) ? asked : null;
  const feed = await notificationFeed(user.id, app);
  return NextResponse.json(feed, { headers: { "cache-control": "no-store" } });
}
