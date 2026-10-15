import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { opensTheBook } from "@/app/api/book-door";
import { crmSearch } from "@/lib/services/app-search-service";

/**
 * The CRM header's search — one typed list, the ERP's shape. `/api/search`
 * stays as it was for the two pickers that read its three sections.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ hits: [] }, { status: 401 });
  if (!(await opensTheBook(user.id))) return NextResponse.json({ hits: [] }, { status: 403 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ hits: await crmSearch(user.id, q) });
}
