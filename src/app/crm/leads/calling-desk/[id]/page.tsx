/*
 * THE TELECALLER'S RECORD IS THE UNIFIED LEAD RECORD NOW.
 *
 * `/crm/leads/[id]` is the one lead page for everybody — Call 1/3, Check
 * Visits, Convert, the gate and the People panel are all on it, each behind its
 * own capability, and it opens for the Calling desk without All Leads. This
 * route stays because it lives in bookmarks, bells and enquiries, and sends
 * everybody there. What a Telecaller may READ is decided by that read, not by
 * which URL they arrived on. `?call=1` is forwarded so My day's Call still
 * opens the dialog.
 */
import { redirect } from "next/navigation";

export const metadata = { title: "Lead — Telecaller — CRM — MahekOne" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const call = (await searchParams).call;
  redirect(`/crm/leads/${encodeURIComponent(id)}${call === "1" ? "?call=1" : ""}`);
}
