import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { listTrash, type TrashSort } from "@/lib/services/lead-trash-service";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const SORTS: TrashSort[] = ["deleted_desc", "deleted_asc", "name_asc", "created_desc"];

/**
 * The Admin Console's Trash, a page at a time. Filtered, counted and paged in
 * the database; the screen holds one page. Administrators only — the same
 * capability that restores, checked here and again inside `listTrash`.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if (!(await canFor(user, "lead.restore"))) {
    return NextResponse.json({ error: "Only an administrator can open the trash." }, { status: 403, ...NO_STORE });
  }
  const p = new URL(request.url).searchParams;
  const sort = p.get("sort") as TrashSort | null;
  return NextResponse.json(
    await listTrash({
      q: p.get("q") ?? "",
      deletedBy: p.get("by") ?? undefined,
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
      sort: sort && SORTS.includes(sort) ? sort : "deleted_desc",
      page: Number(p.get("page")) || 1,
      perPage: Number(p.get("per")) || 25,
    }),
    NO_STORE,
  );
}
