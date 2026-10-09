import { unstable_isUnrecognizedActionError } from "next/navigation";
import { err, type Result } from "@/lib/result";

/**
 * Call a server action from a client screen, and turn a call that never
 * reached our code into a Result with a sentence that says which way it failed.
 *
 * A DEPLOY IS NOT A DROPPED CONNECTION, and the screen used to say it was.
 * Next renames every server action on every build, so a page loaded before a
 * deploy posts to an action the new server has never heard of — it answers
 * "not found" and the promise rejects. The screen read every rejection as the
 * network: "That did not reach the server. Try again." Trying again posts the
 * same dead id, so it fails identically for ever. A price list was picked at
 * 13:31 and Publish pressed at 20:28 with seven deploys in between, and the
 * only way out — reloading the page — was the one thing nothing said.
 */
export async function callAction<T>(call: Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call;
  } catch (e) {
    if (unstable_isUnrecognizedActionError(e)) {
      return err(
        "MahekOne was updated while this page was open, so it cannot save from here. Reload the page and do it again.",
        "conflict",
      );
    }
    return err("That did not reach the server — check the connection and try again.", "validation");
  }
}
