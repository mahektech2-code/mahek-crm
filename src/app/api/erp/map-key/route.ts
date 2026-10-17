import { NextResponse } from "next/server";
import { erpContext } from "@/lib/erp/access";
import { liveOlaKey } from "@/lib/services/ola-key-service";

/**
 * The tile key for the ERP's pin pickers ("Pick on map") — a godown's pin, a
 * transporter godown's pin. It is the one credential that reaches a browser
 * (see `lib/secrets.ts`), so it is handed only to somebody who holds the ERP,
 * and it is whichever key in the pool is live now.
 */
export async function GET() {
  const ctx = await erpContext();
  if (!ctx.level) return NextResponse.json({ key: null }, { status: 403 });
  return NextResponse.json({ key: (await liveOlaKey()).key });
}
