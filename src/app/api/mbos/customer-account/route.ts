import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/services/mbos-service";
import { scopedCustomer } from "@/lib/actions/mbos";
import { handsetCustomerAccount } from "@/lib/services/mbos-account-service";

/* ---------------------------------------------------------------------------
 * ONE CUSTOMER'S ACCOUNT, as the Accounts app holds it — for the handset's
 * Customer accounts screen.
 *
 * A REQUEST rather than a pull channel, for the reason the performance range
 * is one: the full history of every account on a book is not a thing to keep
 * on every phone, and the question is asked about one shop at a time. The
 * thirteen-month statement the pull already carries is what the screen shows
 * when this cannot be reached, and it says that it is doing so.
 *
 * A shop he may not see answers exactly like one that does not exist.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ customerId: z.string().trim().min(1) });

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "That could not be read." }, { status: 400 });
  }

  const found = await scopedCustomer(auth.principal, parsed.data.customerId);
  if (!found.ok) {
    return NextResponse.json({ ok: false, error: "That shop is not on your book." }, { status: 404 });
  }

  try {
    const account = await handsetCustomerAccount(auth.principal, found.customer.id);
    if (!account) {
      return NextResponse.json({ ok: false, error: "That shop is not on your book." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, account });
  } catch (e) {
    console.error("Customer account failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "The account could not be read just now. What this phone holds is shown instead." },
      { status: 500 },
    );
  }
}
