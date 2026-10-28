/* ---------------------------------------------------------------------------
 * WHICH APPS A REVOCATION IS ABOUT, as the one id an impact report carries.
 *
 * `setAccess` takes a whole desired picture, and only the part of it that
 * takes an app away is confirmed through the impact modal. So that part is its
 * own record: the person, and the apps going, sorted. PURE and client-safe,
 * because the Access dialog and the action have to spell the same revocation
 * the same way or the fingerprint the person confirmed would never match.
 * ------------------------------------------------------------------------- */

/** The impact kind for apps taken away in one save. */
export const ACCESS_REVOKE_KIND = "admin-access-revoke";

/** The person and the apps going as one id: `<user>:<app,app>`, apps unique and sorted. */
export function accessRevokeKey(userId: string, apps: readonly string[]): string {
  return `${userId}:${[...new Set(apps)].sort().join(",")}`;
}

/** The person and the apps back out of the key. */
export function accessRevokeParts(key: string): { userId: string; apps: string[] } | null {
  const at = key.lastIndexOf(":");
  if (at < 1) return null;
  return { userId: key.slice(0, at), apps: key.slice(at + 1).split(",").filter(Boolean) };
}
