import path from "node:path";

/*
 * Where the Studio's files live: the approved designs (`studio/templates`) and
 * the fonts, logos and pack images they draw with (`studio/assets`). They are
 * read from disk at render time, so the Dockerfile copies `studio/` beside
 * `server.js` — the standalone trace cannot see a file that is only ever
 * named in a path string. The working directory is the repository root in
 * development and in tests, and `/app` in the image; both hold `studio/`.
 */
export const STUDIO_DIR = path.resolve(process.cwd(), "studio");
export const TEMPLATES_DIR = path.join(STUDIO_DIR, "templates");
export const ASSETS_DIR = path.join(STUDIO_DIR, "assets");
