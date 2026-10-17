import "server-only";
import { canOpen } from "@/lib/access";

/**
 * WHETHER SOMEBODY HAS A SCREEN THESE SHARED ROUTES BELONG TO.
 *
 * `/api/search`, `/api/customer-info`, `/api/payment-panel` and the two
 * payment lookups are called from exactly two shells — the CRM's and the
 * Accounts app's, the only two that render `AppShell`, the call panel and the
 * receipt form. They asked only whether a session existed, so a person holding
 * nothing but HRMS, or nothing but the handset, could search and read the book
 * by URL. Scope inside each service still decides WHICH customers come back;
 * this decides whether the caller has any business asking at all — the same
 * question `/api/bill-detail` has asked of its own three ledgers for a while.
 */
export async function opensTheBook(userId: string): Promise<boolean> {
  return (await canOpen(userId, "crm")) || (await canOpen(userId, "accounts"));
}
