// The settings tab renders asynchronously and twenty of its own controls ask it
// to re-render. Without serialisation a second run empties the container while
// the first is mid-await, and both append into it — which is what produced
// duplicated "Fixed expenses" and "Categories" blocks with mismatched contents.
const H = require("./harness.js");
const { el, BudgetSettingTab } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors the real shape: empty() once at the top, then awaits between sections.
class Probe extends BudgetSettingTab {
  constructor() {
    super();
    this.containerEl = el("div");
    this.app = {};
    this.plugin = {};
    this.runs = 0;
  }
  async renderSettings() {
    const me = ++this.runs;
    this.containerEl.empty();
    for (let i = 0; i < 5; i++) {
      this.containerEl.createEl("h3", { text: `run${me}-section${i}` });
      await settle(2);
    }
  }
}

const sections = (p) => p.containerEl.children.map((c) => c._text);
const runsPresent = (p) => [...new Set(sections(p).map((h) => h.split("-")[0]))];

(async () => {
  console.log("\nWithout the guard (calling the body directly) the race is real");
  {
    const p = new Probe();
    // This is exactly what two unguarded display() calls used to do.
    p.renderSettings();
    p.renderSettings();
    await settle(120);
    check("two runs interleave into one container", runsPresent(p).length > 1, true);
    check("and sections are duplicated", sections(p).length > 5, true);
  }

  console.log("\nWith the guard");
  {
    const p = new Probe();
    p.display();
    p.display();
    p.display();
    await settle(160);
    check("only one run's output is present", runsPresent(p).length, 1);
    check("exactly one full render, nothing doubled", sections(p).length, 5);
    check("three requests collapse into two renders", p.runs, 2);
  }

  console.log("\nA request arriving mid-render still produces a fresh render");
  {
    const p = new Probe();
    p.display();
    await settle(4);      // in flight
    p.display();          // a control changed something
    await settle(160);
    check("the later request was honoured", p.runs, 2);
    check("and the DOM shows only the newest run", runsPresent(p)[0], "run2");
  }

  console.log("\nSequential renders are unaffected");
  {
    const p = new Probe();
    await p.display();
    await settle(20);
    await p.display();
    await settle(20);
    check("two sequential calls render twice", p.runs, 2);
    check("container holds one render's worth", sections(p).length, 5);
  }

  console.log("\nA failing render releases the lock");
  {
    class Boom extends Probe {
      async renderSettings() {
        this.runs++;
        throw new Error("vault unavailable");
      }
    }
    const p = new Boom();
    await p.display();
    check("the error did not wedge the tab", p._rendering, false);
    await p.display();
    check("and it can render again", p.runs, 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
