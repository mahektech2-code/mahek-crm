import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@/db/schema";
import { canOpen, canOpenModule } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";

/* The Studio's routes answer the same three ways: not signed in, not given
   this part of the Studio, or the thing itself. A file somebody may not see
   and a file that does not exist both answer 404, so an id cannot be used to
   find out what exists. */

/** `moduleKey` null means anybody holding the Studio at all — for a picture whose own read already narrows by scope. */
export async function studioCaller(moduleKey: string | null): Promise<{ user: User } | { response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { response: NextResponse.json({ ok: false, error: "Sign in again — your session has ended." }, { status: 401 }) };
  const allowed = moduleKey ? await canOpenModule(user.id, moduleKey) : await canOpen(user.id, "studio");
  if (!allowed) return { response: NextResponse.json({ ok: false, error: "Not found." }, { status: 404 }) };
  return { user };
}

export const notFound = () => NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });

export function imageResponse(bytes: Buffer | Uint8Array, contentType: string, opts: { download?: string | null; cache?: "private-short" | "immutable" } = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": opts.cache === "immutable" ? "private, max-age=86400, immutable" : "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
  if (opts.download) headers["Content-Disposition"] = `attachment; filename="${opts.download.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
  return new Response(new Uint8Array(bytes), { headers });
}
