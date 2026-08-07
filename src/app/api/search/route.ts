import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { globalSearch } from "@/lib/queries";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ customers: [], bills: [], products: [] }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  const results = await globalSearch(q);

  return NextResponse.json(results);
}
