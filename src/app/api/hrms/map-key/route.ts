import { NextResponse } from "next/server";
import { hrmsContext } from "@/lib/hrms/access";
import { readSecret } from "@/lib/secrets";

/**
 * The tile key for the office pin picker. It is the one credential that
 * reaches a browser (see `lib/secrets.ts`), so it is handed only to somebody
 * who holds the Offices screen — the one form that draws the map.
 */
export async function GET() {
  const ctx = await hrmsContext();
  if (!ctx.level || !ctx.screens.has("offices")) return NextResponse.json({ key: null }, { status: 403 });
  return NextResponse.json({ key: await readSecret("olamaps.apiKey") });
}
