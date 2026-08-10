import { signOut } from "@/lib/actions/auth";

/**
 * Signing out ends the session and closes the day's sign-in row.
 *
 * The label used to promise it "records your finish time", which read as
 * clocking off and is not what this is: most people close the tab instead, and
 * their row simply never closes. Attendance is a check-in system of its own,
 * and it is not built yet — so this button says what it does, which is end the
 * session.
 */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        title="Ends your session on this device"
        className="flex h-7.5 cursor-pointer items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas"
      >
        Sign out
      </button>
    </form>
  );
}
