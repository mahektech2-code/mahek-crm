import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { opensTheBook } from "@/app/api/book-door";
import { getFollowUpPanel } from "@/lib/services/payment-followup-service";
import { previewPaymentReminders } from "@/lib/services/whatsapp-service";
import { messagesForCustomer, ruleOutlookFor } from "@/lib/services/whatsapp-tracker-service";

/**
 * Everything the follow-up modal needs, in one round trip: the account, and
 * what the stage's reminder would say. Loaded when the modal opens rather than
 * prefetched for every row behind it — most rows are never opened.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ panel: null }, { status: 401 });

  /* A screen this belongs to, first — see `book-door.ts`. */
  if (!(await opensTheBook(user.id))) {
    return NextResponse.json({ panel: null }, { status: 403 });
  }

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ panel: null }, { status: 400 });

  try {
    const panel = await getFollowUpPanel(customerId);
    if (!panel) return NextResponse.json({ panel: null }, { status: 200 });
    const [reminders, messages, rules] = await Promise.all([
      previewPaymentReminders(customerId, panel.stage),
      messagesForCustomer(customerId, 15),
      ruleOutlookFor(customerId, "payment"),
    ]);
    // The conversation so far and the rules that will act next, beside the
    // message about to be sent — so nobody sends by hand what a rule just sent.
    // Every approved payment template, each as it would go, and the one to
    // open on — the team picks which reminder this customer gets.
    return NextResponse.json({
      panel,
      reminders: reminders.options,
      defaultTemplateId: reminders.defaultTemplateId,
      whatsapp: { messages, rules },
    });
  } catch {
    // Out of scope, or gone. The modal says so rather than showing an error.
    return NextResponse.json({ panel: null }, { status: 200 });
  }
}
