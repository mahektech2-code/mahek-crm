import { listCustomerStatusRequests } from "@/lib/queries";
import { today } from "@/lib/recompute";
import { RequestsScreen } from "./requests-screen";

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
  const [rows, day] = await Promise.all([listCustomerStatusRequests(), today()]);
  return <RequestsScreen rows={rows} today={day} />;
}
