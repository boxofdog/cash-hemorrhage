// Flags `const/let X = <init>` where <init> references X — a TDZ error if the
// reference runs during initialisation (e.g. a builder callback).
const acorn = require("acorn");
const walk = require("acorn-walk");
const P = require("../tests/paths.js");
const src = require("fs").readFileSync(process.argv[2] || P.MAIN, "utf8");
const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
const hits = [];
walk.full(ast, (node) => {
  if (node.type !== "VariableDeclaration" || node.kind === "var") return;
  node.declarations.forEach((d) => {
    if (d.id.type !== "Identifier" || !d.init) return;
    const name = d.id.name;
    walk.full(d.init, (n) => {
      if (n.type === "Identifier" && n.name === name) hits.push(`${n.loc.start.line}: ${name}`);
    });
  });
});
// Reviewed and safe: each is referenced only inside a callback that runs after
// the declaration finishes (an event handler, a later-called closure).
const KNOWN = new Set(["frame", "outside", "btn"]);
const fresh = hits.filter((h) => !KNOWN.has(h.split(": ")[1]));
console.log(hits.length ? hits.join("\n") : "no self-references");
if (fresh.length) {
  console.log(`\n${fresh.length} new self-reference(s) — check each isn't read during initialisation:\n${fresh.join("\n")}`);
  process.exit(1);
}
console.log(`\nOK — only the ${hits.length} known, reviewed ones.`);
