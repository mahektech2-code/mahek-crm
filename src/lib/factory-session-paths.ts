/**
 * Where a FACTORY-ONLY session counts. A PIN is four digits and the SMS code
 * that replaces a forgotten one is good for the floor, so the session either
 * opens is good for the Factory app and nothing else: anywhere outside these
 * addresses `getCurrentUser` answers nobody, and the person signs in with
 * their password like everyone else. Pure, so the rule is pinned by a test.
 *
 * A path that could not be read is NOT the factory: the safe direction.
 */
export function factorySessionAllows(path: string | null | undefined): boolean {
  if (!path || !path.startsWith("/")) return false;
  const bare = path.split("?")[0].split("#")[0];
  return bare === "/factory" || bare.startsWith("/factory/") || bare.startsWith("/api/factory/");
}
