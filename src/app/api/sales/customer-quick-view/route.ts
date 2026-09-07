import { NextResponse } from "next/server";
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
