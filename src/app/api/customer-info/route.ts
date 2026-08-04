import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { customerInformation } from "@/lib/services/customer-info-service";

/**
 * The information strip loads when the panel opens rather than being
 * prefetched for every row behind it — most rows are never opened.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ info: null }, { status: 401 });

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ info: null }, { status: 400 });

  try {
    return NextResponse.json({ info: await customerInformation(customerId) });
  } catch {
    // Out of scope, or gone. The panel shows nothing rather than an error.
    return NextResponse.json({ info: null }, { status: 200 });
  }
}
