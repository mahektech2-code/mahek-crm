import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { APPS } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { getConfig } from "@/lib/config/store";
import { initialsOf } from "@/lib/format";
import { pendingOrderCount } from "@/lib/services/order-approval-service";
import { pendingReceiptCount } from "@/lib/services/receipt-service";
import { pendingCreditNoteCount } from "@/lib/services/credit-note-service";
import { queueUrgency } from "@/lib/services/accounts-queue-service";
import { AccountsShell } from "./accounts-shell";

/**
 * The Accounts app's own shell.
 *
 * Deliberately not the CRM's `AppShell`: that carries the calling sidebar and
 * its reminder and complaint badges, and accounts have no calling book.
 *
 * The counts are read once here rather than by each screen for itself — the
 * sidebar badges them on every route, and three screens asking the same three
 * questions on every navigation is three round trips nobody sees.
 */
export default async function OrdersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  // Checked here as well as on the launcher: a bookmarked /accounts must not
  // open for somebody who was never given the app.
  if (!apps.includes("accounts")) redirect("/apps");

  // Which screens of it, so the sidebar draws what they hold and nothing else.
  const modules = await listUserModules(user.id, "accounts");
  if (modules.length === 0) redirect("/apps");

  const [orderCount, paymentCount, creditCount, urgency, config] = await Promise.all([
    pendingOrderCount(),
    pendingReceiptCount(),
    pendingCreditNoteCount(),
    queueUrgency(),
    getConfig(),
  ]);
  const staleHours = config["payments.confirmationAgeWarningHours"];

  return (
    <ToastProvider>
      <AccountsShell
        user={{
          name: user.name,
          role: user.role,
          initials: initialsOf(user.name),
        }}
        counts={{
          orders: orderCount,
          // An order waiting twice the confirmation threshold is a customer who
          // ordered yesterday morning and has heard nothing since.
          ordersUrgent: urgency.oldestOrderHours >= staleHours * 2,
          payments: paymentCount,
          paymentsUrgent: urgency.oldestReceiptHours > staleHours,
          credits: creditCount,
        }}
        allowed={modules.map((m) => m.href)}
        switcher={
          apps.length > 1 ? (
            <AppSwitcher apps={APPS.filter((a) => apps.includes(a.id))} current="accounts" />
          ) : null
        }
        feedback={<FeedbackButton />}
      >
        {children}
      </AccountsShell>
    </ToastProvider>
  );
}
