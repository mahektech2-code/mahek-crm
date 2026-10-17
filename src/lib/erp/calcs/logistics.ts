import { registerCalc } from "../calc";

/* The request form's derived fields: what the office sees before saving. */

const map = <T>(data: Record<string, unknown>, k: string) => (data[k] ?? {}) as Record<string, T>;

registerCalc("request.mobile", ({ h, data }) => (h.customer ? (map<string>(data, "mobile")[h.customer] ?? "") || "No mobile on the party" : ""));

registerCalc("request.billDate", ({ h, data }) => {
  if (!h.bill) return "";
  const d = map<string>(data, "billDate")[`${h.customer}|${h.bill}`];
  if (!d) return "Not dispatched yet";
  const [y, m, day] = d.split("-");
  return `${day}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`;
});
