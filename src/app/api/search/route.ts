import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getScope } from "@/lib/scope";
import { globalSearch } from "@/lib/queries";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ customers: [], bills: [] }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  const scope = await getScope(user);
  const results = await globalSearch(user, scope, q);

  return NextResponse.json(results);
}
