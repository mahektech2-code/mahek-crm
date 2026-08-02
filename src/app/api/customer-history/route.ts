import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { customerTimeline } from "@/lib/queries";

/**
 * The last few interactions for the call panel. Fetched when the panel opens
 * rather than prefetched for every queue row — prefetching cost one round trip
 * per customer for panels that mostly never get opened.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ history: [] }, { status: 401 });

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ history: [] }, { status: 400 });

  const timeline = await customerTimeline(customerId);
  return NextResponse.json({
    history: timeline.slice(0, 3).map((t) => ({
      kind: t.kind,
      at: t.at.toISOString(),
      actor: t.actor,
      content: t.content,
    })),
  });
}
