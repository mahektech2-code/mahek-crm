import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { orderLines } from "@/lib/services/order-approval-service";

/**
 * The items on one order, loaded when a row is opened rather than with the
 * queue — an order may carry hundreds of lines and the list only needs a count.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ lines: [] }, { status: 401 });

  const apps = await listUserApps(user.id);
  if (!apps.includes("accounts")) {
    return NextResponse.json({ lines: [] }, { status: 403 });
  }

  const orderId = new URL(request.url).searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ lines: [] }, { status: 400 });

  return NextResponse.json({ lines: await orderLines(orderId) });
}
