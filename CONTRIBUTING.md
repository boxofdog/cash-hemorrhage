# Contributing

Thanks for taking a look. Bug reports, ideas and fixes are all welcome.

## Reporting a bug

Open an issue and say:

- What you did, what you expected, and what happened instead.
- Your Obsidian version, the plugin version (Settings → Community plugins) and
  whether you're on desktop or phone.
- A screenshot if it's about how something looks.

**Please remove personal financial details first.** Blur account names, balances
and merchants, and never paste a SimpleFIN setup token or access URL.

## Suggesting a change

Open an issue before you start on anything large, so we can agree it fits. The
plugin favors short, plain screens: notices are one line, dialogs show only what
there is to decide, and nothing that moves real money happens without your
confirmation.

## Sending a fix

1. Fork the repo and make your change on a branch.
2. Run `npm install`, then `npm run check`. It runs the syntax check, the scan
   for initialization mistakes, the screen snapshots and every test. It has to
   pass.
3. Add tests for what you changed, in the matching `tests/test-*.js` file. Cover
   the cases that must *not* happen too.
4. If a screen changed on purpose, run `npm run snapshots:update` and include the
   diff.
5. Add a line to the top entry of `CHANGELOG.md`, written for people using the
   plugin.
6. Open a pull request and describe what changed and why.

Please leave `manifest.json`'s version alone. It's changed only when a release
is published.

## How the code is laid out

The plugin is three files (`main.js`, `styles.css`, `manifest.json`) with no
build step. `docs/ARCHITECTURE.md` describes where things live, and
`docs/HANDOFF.md` explains decisions that are deliberate and shouldn't be
undone. Use only synthetic data in tests and fixtures.

By contributing you agree your changes are released under the [MIT license](LICENSE).
