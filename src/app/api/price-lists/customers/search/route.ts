import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { searchCustomers } from "@/lib/services/price-list-service";

/** The customer picker behind a scope, a special price and the list preview. */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ customers: await searchCustomers(q) });
}
