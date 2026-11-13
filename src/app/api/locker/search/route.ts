import { NextResponse } from "next/server";
import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { lockerCredentials } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { lockerAccess } from "@/lib/locker/access";
import { STATUS, TIER, daysLabel } from "@/lib/locker/engine";
import { registerFor } from "@/lib/locker/service";

/**
 * The header search: assets the person may open, and — for vault holders —
 * logins by title, username or provider. Never a secret, never a hint.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ groups: [] }, { status: 401 });
  const access = await lockerAccess(user.id);
  if (!access.keys.size) return NextResponse.json({ groups: [] }, { status: 403 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ groups: [] });
  const groups: { label: string; vault?: boolean; items: { href: string; name: string; meta: string }[] }[] = [];
  const assets = (await registerFor(user.id)).filter((a) => a.live && `${a.title} ${a.code} ${a.docNo} ${a.provider}`.toLowerCase().includes(q)).slice(0, 6);
  if (assets.length)
    groups.push({ label: "Assets", items: assets.map((a) => ({ href: `/locker/assets/${a.id}`, name: a.title, meta: `${a.code} · ${daysLabel(a.actionIn)} · ${STATUS[a.status].label}` })) });
  if (access.vault) {
    const like = `%${q}%`;
    const creds = await db
      .select({ id: lockerCredentials.id, title: lockerCredentials.title, tier: lockerCredentials.tier, username: lockerCredentials.username })
      .from(lockerCredentials)
      .where(and(eq(lockerCredentials.active, true), or(ilike(lockerCredentials.title, like), ilike(lockerCredentials.username, like), ilike(lockerCredentials.provider, like))))
      .limit(6);
    if (creds.length)
      groups.push({ label: "Passwords & keys", vault: true, items: creds.map((c) => ({ href: `/locker/vault/${c.id}`, name: c.title, meta: `${TIER[c.tier as keyof typeof TIER].label} · ${c.username}` })) });
  }
  return NextResponse.json({ groups });
}
