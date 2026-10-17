import { NextResponse } from "next/server";
import { canOpen, canOpenModule, listUserModules } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { getCustomer } from "@/lib/queries";
import { customerInformation } from "@/lib/services/customer-info-service";

/**
 * What a shop pin on Territory's map opens into: the same customer record
 * data the CRM record page reads, at the depth a manager glancing at a pin
 * actually needs — not the whole Information tab.
 *
 * `getCustomer` for the profile (contact, kind, status, outstanding, the
 * two account managers, the stored next step) and `customerInformation` for
 * the history (purchase cycle, recent calls) — the same two reads the CRM
 * record page and its Information tab already make, so a manager on the
 * Sales Dashboard is never shown a number derived a different way.
 *
 * `customerInformation` runs the scope check (`assertCustomerInScope`); a
 * refusal is caught here the same way `/api/customer-info` catches it — out
 * of scope or gone both answer `{ customer: null }` rather than an error, so
 * a pin a manager may not read is absent to them, never a crash.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ customer: null }, { status: 401 });

  /*
   * THE DOOR FIRST. This route sat behind a signed-in session and nothing
   * else, so anybody with any MahekOne login — a ledger clerk, an HR associate
   * — could read a customer's profile, outstanding and recent calls by id
   * wherever `assertCustomerInScope` happened to answer yes, which for an
   * account whose widest level is a manager is a whole team's book.
   *
   * Two apps draw the pin that calls it: the Sales Dashboard on its maps,
   * lists and search, and the CRM's Samples desk through the shared samples
   * screen. Holding the Sales Dashboard with any module, or the CRM's Samples
   * module, is a reason to be asking; nothing else is.
   */
  const allowed =
    ((await canOpen(user.id, "sales")) && (await listUserModules(user.id, "sales")).length > 0) ||
    (await canOpenModule(user.id, "crm.samples"));
  if (!allowed) return NextResponse.json({ customer: null }, { status: 403 });

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ customer: null }, { status: 400 });

  try {
    const info = await customerInformation(customerId);
    if (!info) return NextResponse.json({ customer: null }, { status: 200 });
    const customer = await getCustomer(customerId);
    return NextResponse.json({ customer, info });
  } catch {
    return NextResponse.json({ customer: null }, { status: 200 });
  }
}
