/*
 * A ROUTE, and no screen behind it yet.
 *
 * `crm.sales-manager` is a permission with nothing wired to it: the checkbox
 * exists on the Access screen and this route answers to it, but there is no
 * screen here to open. Said plainly rather than left as a blank page, the
 * same way `AppPlaceholder` says it for a whole unbuilt app.
 */
export const metadata = { title: "Sales Manager — CRM — MahekOne" };

export default function Page() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-[460px] text-center">
        <div className="text-[22px] leading-7 font-semibold text-ink">Sales Manager</div>
        <p className="mt-2 text-[15px] leading-[22px] text-muted">
          Not built yet. The permission is grantable and this route is guarded by it — the
          screen itself has not been built.
        </p>
      </div>
    </div>
  );
}
