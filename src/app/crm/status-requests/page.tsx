import { listCustomerStatusRequests } from "@/lib/queries";
import { today } from "@/lib/recompute";
import { RequestsScreen } from "./requests-screen";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";

export const metadata = { title: "Status requests — MahekOne CRM" };

/**
 * The list is not scoped. A request is work for whoever decides it, not for
 * whoever raised it — narrowing it to a manager's own book would hide the
 * requests raised by telecallers whose customers sit in somebody else's, which
 * is most of them. The layout has already refused anybody who is not a manager
 * or an admin, and both actions check `customer.deactivate` again themselves.
 *
 * `today` comes from the server and is passed down, because the screen needs to
 * ask "did they order recently" and reading the clock during render is refused
 * by the React Compiler rules.
 */
export default async function Page() {
  const user = await requireUser();
  const [rows, day, canDecide] = await Promise.all([
    listCustomerStatusRequests(),
    today(),
    canFor(user, "customer.deactivate"),
  ]);
  /* Somebody who cannot decide is here only to withdraw their own (see the
     layout), so they see only their own. */
  return (
    <RequestsScreen
      rows={canDecide ? rows : rows.filter((r) => r.askedById === user.id)}
      today={day}
      userId={user.id}
      canDecide={canDecide}
    />
  );
}
