import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getFollowUpPanel } from "@/lib/services/payment-followup-service";
import { previewPaymentReminder } from "@/lib/services/whatsapp-service";

/**
 * Everything the follow-up modal needs, in one round trip: the account, and
 * what the stage's reminder would say. Loaded when the modal opens rather than
 * prefetched for every row behind it — most rows are never opened.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ panel: null }, { status: 401 });

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ panel: null }, { status: 400 });

  try {
    const panel = await getFollowUpPanel(customerId);
    if (!panel) return NextResponse.json({ panel: null }, { status: 200 });
    const message = await previewPaymentReminder(customerId, panel.stage);
    return NextResponse.json({ panel, message });
  } catch {
    // Out of scope, or gone. The modal says so rather than showing an error.
    return NextResponse.json({ panel: null }, { status: 200 });
  }
}
