import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { opensTheBook } from "@/app/api/book-door";
import { globalSearch } from "@/lib/queries";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ customers: [], bills: [], products: [] }, { status: 401 });

  /* A screen this belongs to, first — see `book-door.ts`. */
  if (!(await opensTheBook(user.id))) {
    return NextResponse.json({ customers: [], bills: [], products: [] }, { status: 403 });
  }

  const q = new URL(request.url).searchParams.get("q") ?? "";
  const results = await globalSearch(q);

  return NextResponse.json(results);
}
