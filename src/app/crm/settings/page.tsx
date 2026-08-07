import { permanentRedirect } from "next/navigation";

/**
 * Configuration moved to the Admin Console. A bookmark from before the move
 * should land where the settings actually are, not on a 404.
 */
export default function MovedToConsole() {
  permanentRedirect("/admin");
}
