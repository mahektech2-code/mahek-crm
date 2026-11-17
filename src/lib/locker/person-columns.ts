import { getTableColumns, sql } from "drizzle-orm";
import { lockerIdentities, lockerPaymentMethods } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * WHO A SIGN-IN ACCOUNT OR A CARD BELONGS TO, read by account.
 *
 * `controlled_by_id` and `holder_user_id` say who, where the person is staff;
 * the text beside each is only the label, and the whole record of somebody
 * who is not on the staff (a director's own card, a consultant's Gmail). So
 * every read shows the name the account carries TODAY — an HR rename reaches
 * the Locker — and falls back to the text only where nobody is linked. Select
 * these in place of the table's own columns; the row keeps its shape.
 * ------------------------------------------------------------------------- */

export const identityColumns = {
  ...getTableColumns(lockerIdentities),
  controlledByName: sql<string | null>`coalesce((select u.name from users u where u.id = ${lockerIdentities.controlledById}), ${lockerIdentities.controlledByName})`,
};

export const paymentMethodColumns = {
  ...getTableColumns(lockerPaymentMethods),
  holder: sql<string>`coalesce((select u.name from users u where u.id = ${lockerPaymentMethods.holderUserId}), ${lockerPaymentMethods.holder})`,
};
