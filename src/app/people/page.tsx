import { permanentRedirect } from "next/navigation";

/**
 * Attendance & People was a placeholder for the work HRMS now does. A bookmark
 * to it lands in HRMS rather than on "not built yet".
 */
export default function RetiredIntoHrms() {
  permanentRedirect("/hrms");
}
