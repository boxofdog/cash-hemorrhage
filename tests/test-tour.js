// The first-run tour: its pages, moving through them, and when it opens by itself.
const P = require("./paths.js");
global.document = { body: { classList: { contains: () => false } } };
const H = require("./harness.js");
const { el, allText } = H;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => find(c, pred, out)); return out; };
const buttons = (n) => find(n, (x) => x.tag === "button").map((b) => b._text);
const click = (n, label) => find(n, (x) => x.tag === "button" && x._text === label)[0].onclick();
const text = (n) => allText(n).replace(/\s+/g, " ").trim();

function open() {
  let closed = 0;
  const m = new H.IntroTourModal({}, () => closed++);
  m.modalEl = el("div");
  m.close = function () { this.onClose(); };
  m.onOpen();
  return { m, closed: () => closed };
}

(async () => {
console.log("\n1. The pages");
check("eight pages", H.TOUR_PAGES.length, 8);
check("the paycheck page asks for the latest paycheck and the next one", /most recent paycheck/i.test(H.TOUR_PAGES[3].title) && /next one/.test(H.TOUR_PAGES[3].body) && /cadence/.test(H.TOUR_PAGES[3].body), true);
check("the transactions page says labelling is upfront work", /upfront work/.test(H.TOUR_PAGES[5].body) && /rule/.test(H.TOUR_PAGES[5].body), true);
check("bold markers split into pieces", H.tourSegments("a **b** c"), [{ text: "a ", bold: false }, { text: "b", bold: true }, { text: " c", bold: false }]);

console.log("\n2. Moving through it");
{
  const { m, closed } = open();
  check("starts on page 1: Skip tour and Next, no Back", [text(m.contentEl).startsWith("1 of 8 Welcome"), buttons(m.contentEl)], [true, ["Skip tour", "Next"]]);
  click(m.contentEl, "Next");
  check("Next moves on and Back appears", [text(m.contentEl).startsWith("2 of 8"), buttons(m.contentEl)], [true, ["Skip tour", "Back", "Next"]]);
  click(m.contentEl, "Back");
  check("Back returns", text(m.contentEl).startsWith("1 of 8"), true);
  for (let i = 0; i < 7; i++) click(m.contentEl, "Next");
  check("the last page ends with Done, no Skip", [text(m.contentEl).startsWith("8 of 8"), buttons(m.contentEl)], [true, ["Back", "Done"]]);
  check("it names the command that reopens it", text(m.contentEl).includes("Budget Tracker: Show tour"), true);
  click(m.contentEl, "Done");
  check("Done closes it", closed(), 1);
  const s = open();
  click(s.m.contentEl, "Skip tour");
  check("Skip closes it too", s.closed(), 1);
}

console.log("\n3. Closing it means it stays closed");
{
  const store = {};
  const app = { vault: { adapter: { exists: async () => false, write: async (p, d) => (store[p] = d), read: async (p) => store[p] } } };
  const plugin = Object.create(H.__PluginClass.prototype);
  plugin.app = app;
  plugin.settings = { bufferMode: "auto" };
  // showTour opens a real modal; capture it instead of showing it.
  const seen = [];
  const Real = H.IntroTourModal.prototype.open;
  H.IntroTourModal.prototype.open = function () { seen.push(this); };
  plugin.showTour();
  H.IntroTourModal.prototype.open = Real;
  check("it opens", seen.length, 1);
  await seen[0].onCloseCb();
  check("closing marks it seen and saves", [plugin.settings.tourSeen, JSON.parse(store[H.FILES.settings]).tourSeen], [true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
