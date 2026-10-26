import "server-only";
import { requestAppId } from "./access-control";
import { listUserApps } from "./access";

/**
 * A CUSTOMER'S DETAILS ARE EDITED IN ACCOUNTS, AND READ EVERYWHERE ELSE.
 *
 * The same party is drawn in the CRM, Accounts, the ERP's Masters and the
 * HRMS Sales desk, and each of them grew its own Edit — so a phone number,
 * a GSTIN or a credit term could be changed from four places by four teams,
 * and the last save won with nobody accountable for the record as a whole.
 * Mahek's answer is one desk: the details are the ledger desk's, and every
 * other app shows them.
 *
 * It is a rule about WHERE the edit happens, not only about who: somebody
 * holding both Accounts and the CRM edits from Accounts, and their CRM screen
 * is view-only like everybody else's. So two things must hold — the request
 * is in the Accounts app (the `x-mahek-app` header, which `src/proxy.ts`
 * writes from the URL after stripping any the client sent), and the person
 * actually holds that app, because a server action is a URL and a header
 * alone is a claim about a page, not a grant.
 *
 * What this does NOT cover, deliberately: creating a customer or a lead,
 * moving an account between people (`customer.reassign`, already accounts'),
 * the workflows that write a column as a side effect (lead stages, DND,
 * follow-ups, the sheet sync), and the MBOS handset, which keeps correcting a
 * shop's phone, address and pin from the field.
 */
export const CUSTOMER_EDIT_APP = "accounts";

export const CUSTOMER_EDIT_REFUSAL = "Customer details are edited in the Accounts app — here they are view-only.";

const globalForTest = globalThis as unknown as { __mahekTestCustomerEditApp?: string | null };

/** Integration tests have no request, so they say which app they are standing in. */
export function setTestCustomerEditApp(app: string | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setTestCustomerEditApp is only available under NODE_ENV=test.");
  globalForTest.__mahekTestCustomerEditApp = app;
}

async function appOfRequest(): Promise<string | null> {
  if (process.env.NODE_ENV === "test") return globalForTest.__mahekTestCustomerEditApp ?? null;
  return requestAppId();
}

/** Null when this person may edit a customer's details here, or the sentence that says where they can. */
export async function customerEditRefusal(userId: string): Promise<string | null> {
  if ((await appOfRequest()) !== CUSTOMER_EDIT_APP) return CUSTOMER_EDIT_REFUSAL;
  if (!(await listUserApps(userId)).includes(CUSTOMER_EDIT_APP)) return CUSTOMER_EDIT_REFUSAL;
  return null;
}
