/**
 * THE OFFICE'S OWN INTERNET CONNECTION COUNTS AS BEING IN THE OFFICE.
 *
 * A desktop has no GPS: its browser guesses where it is from the Wi-Fi or the
 * connection, and in Ambernath that guess lands about 1.3 km from the
 * building — the same wrong spot for every computer on the office network.
 * Measured against a 300 m radius, nobody at a desk could ever punch in. The
 * address the request arrives from is the one thing about a desktop that does
 * say which building it is in, so each office lists the public addresses of
 * its connection, and a punch from one of them passes the location check.
 *
 * Pure, so the rule is tested without a request. The address itself is read
 * by `clientAddress()` from what Caddy sets, never from anything the browser
 * sends.
 *
 * IPv4 matches exactly. IPv6 matches on the /64: a broadband line hands the
 * office one /64 and every computer picks its own address inside it, so an
 * exact match would only ever recognise the computer HR saved it from.
 */

/** "::ffff:1.2.3.4" is IPv4 carried in IPv6; read it as the IPv4 it is. */
export function normaliseIp(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (isIpv4(s)) return s.split(".").map((p) => String(Number(p))).join(".");
  const v6 = expandIpv6(s.split("%")[0]);
  return v6 ? v6.join(":") : null;
}

function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** The eight groups of an IPv6 address, each four hex digits; null when it is not one. */
function expandIpv6(s: string): string[] | null {
  if (!s.includes(":") || !/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

/** What an address is compared on: the address for IPv4, its /64 for IPv6. */
function networkKey(ip: string): string {
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

/**
 * The office's saved list, typed by HR: one address per line or separated by
 * commas or spaces. Returns the clean list, or the first entry that is not an
 * address so the form can say which one.
 */
export function parseNetworkList(text: string | null | undefined): { ok: true; ips: string[] } | { ok: false; bad: string } {
  const ips: string[] = [];
  for (const part of String(text ?? "").split(/[\s,;]+/)) {
    if (!part) continue;
    const ip = normaliseIp(part);
    if (!ip) return { ok: false, bad: part };
    if (!ips.includes(ip)) ips.push(ip);
  }
  return { ok: true, ips };
}

/** Whether a request from `ip` comes from one of the office's saved connections. */
export function onOfficeNetwork(ip: string | null | undefined, saved: readonly string[] | null | undefined): boolean {
  const mine = normaliseIp(ip);
  if (!mine || !saved?.length) return false;
  const key = networkKey(mine);
  return saved.some((s) => {
    const n = normaliseIp(s);
    return n != null && networkKey(n) === key;
  });
}
