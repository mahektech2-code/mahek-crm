import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { notificationFeed } from "@/lib/queries";

/**
 * The bell, asked again. `NotificationCenter` polls this every few seconds
 * from every MahekOne tab, so it is one indexed read of the person's own rows
 * and nothing else — no scope, no app, because a notification is addressed to
 * a PERSON, not to a screen.
 *
 * `no-store`: a cached answer here is a notification that arrives late.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "signed_out" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const feed = await notificationFeed(user.id);
  return NextResponse.json(feed, { headers: { "cache-control": "no-store" } });
}
