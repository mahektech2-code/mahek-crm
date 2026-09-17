import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * A BACKTICK INSIDE A `sql` TEMPLATE ENDS THE TEMPLATE.
 *
 * This codebase explains itself in prose comments, and the house voice quotes
 * identifiers in backticks — `customers.lead_stage`, `split_part`, `gateForNext`.
 * Most of those comments sit in ordinary code, where a backtick is just a
 * character. Inside a tagged template literal it is the terminator, and the
 * rest of the query becomes JavaScript.
 *
 * The failure is loud when it happens (a wall of TS1005s, pointing at lines
 * that look fine) and it is easy to cause, because nothing about writing a
 * comment feels like writing a string. It happened three times in one sitting
 * while this module was being built, twice in the comment explaining a bug the
 * commit was fixing.
 *
 * `tsc` does catch it. This test exists anyway, for two reasons: it names the
 * cause in one line instead of twenty-two syntax errors that point everywhere
 * except at the backtick, and `npm run test` is what most people run first.
 *
 * It is a TEXT scan, like the three zone guards and `mbos-wire.test.ts`. There
 * is no AST here on purpose: the thing being checked is lexical, and a parser
 * would refuse the file before it could report why.
 * ------------------------------------------------------------------------- */

const ROOT = join(process.cwd(), "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/**
 * Every `sql` template in a file, as the text between the opening backtick and
 * whichever backtick the JavaScript parser would treat as the closing one.
 *
 * That is the whole trick: the slice is what the language sees, not what the
 * author meant. If the author put a backtick in a comment, the slice ends
 * inside that comment, and the block comment it ended inside is left unclosed.
 * An unclosed `/*` in the slice is the tell, and it is exact rather than
 * heuristic — a real query cannot contain one, because SQL block comments
 * close, and `--` is what SQL uses for a line comment anyway.
 */
function unterminatedComment(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length - 1; i += 1) {
    if (body[i] === "/" && body[i + 1] === "*") {
      depth += 1;
      i += 1;
    } else if (body[i] === "*" && body[i + 1] === "/") {
      if (depth > 0) depth -= 1;
      i += 1;
    }
  }
  return depth > 0;
}

describe("no backtick inside a sql template", () => {
  it("every sql`…` closes outside its own comments", () => {
    const offenders: string[] = [];

    for (const path of sourceFiles(ROOT)) {
      const text = readFileSync(path, "utf8");

      // `sql` as a tag: the identifier, then the opening backtick. `sql.raw(`
      // and `sql(` are ordinary calls and are not templates.
      const opener = /\bsql`/g;
      let match: RegExpExecArray | null;
      while ((match = opener.exec(text)) !== null) {
        const from = match.index + match[0].length;
        const close = text.indexOf("`", from);
        if (close === -1) continue;
        const body = text.slice(from, close);
        if (!unterminatedComment(body)) continue;

        const line = text.slice(0, from).split("\n").length;
        offenders.push(`${path.replace(process.cwd() + "/", "")}:${line}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A backtick inside one of these sql templates ends the template early — " +
        "almost always a quoted identifier in a comment. Use plain words there:\n  " +
        offenders.join("\n  "),
    );
  });

  it("recognises the shape it is looking for", () => {
    // The guard has to be able to fail, or it is a test that always passes.
    assert.equal(unterminatedComment("select 1 /* fine */ from t"), false);
    assert.equal(unterminatedComment("select 1 /* quoting "), true);
    assert.equal(unterminatedComment("select 1 -- fine\n from t"), false);
  });
});
