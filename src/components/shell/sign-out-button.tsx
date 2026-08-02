import { signOut } from "@/lib/actions/auth";

/**
 * Signing out closes the attendance record for the day, so the label says so —
 * people on the sales floor otherwise leave the browser open and lose an hour.
 */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        title="Signing out records your finish time for the day"
        className="flex h-7.5 cursor-pointer items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas"
      >
        Sign out
      </button>
    </form>
  );
}
