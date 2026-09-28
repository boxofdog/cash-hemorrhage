// Structural snapshots of the Overview and Settings renders (from the fixture
// data), compared against the committed copies in tools/snapshots/.
//
//   node tools/snapshot.js            compare; exit 1 and show the diff if changed
//   node tools/snapshot.js --update   rewrite the committed copies
//
// A change that should look identical (a refactor, a logic fix elsewhere) must
// leave these untouched. A change that's meant to alter the UI updates them, and
// the diff goes in the commit.
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const P = require("../tests/paths.js");

const DIR = path.join(__dirname, "snapshots");
const update = process.argv.includes("--update");
let changed = 0;
for (const [name, script] of [["render", "render-snapshot.js"], ["settings", "settings-snapshot.js"]]) {
  const now = execFileSync(process.execPath, [path.join(__dirname, script), P.MAIN], { encoding: "utf8" });
  const file = path.join(DIR, `${name}.txt`);
  if (update || !fs.existsSync(file)) {
    fs.writeFileSync(file, now);
    console.log(`${name}: written`);
    continue;
  }
  const was = fs.readFileSync(file, "utf8");
  if (was === now) {
    console.log(`${name}: unchanged`);
    continue;
  }
  changed++;
  const tmp = path.join(require("os").tmpdir(), `bt-${name}-now.txt`);
  fs.writeFileSync(tmp, now);
  const d = spawnSync("diff", ["-u", file, tmp], { encoding: "utf8" });
  console.log(`${name}: CHANGED\n${(d.stdout || "").split("\n").slice(0, 80).join("\n")}`);
}
if (changed) {
  console.log("\nIf the change is intended, run `npm run snapshots:update` and commit the new snapshots.");
  process.exit(1);
}
