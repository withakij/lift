# Building from source

## What you need

- **Node.js 20 or newer** — <https://nodejs.org>
- **npm** (ships with Node)

That is all. There are no native modules to compile, so no Xcode, no
Visual Studio Build Tools, no Python.

## Get going

```bash
git clone <your repo url> lift
cd lift
npm install
```

`npm install` fetches only TypeScript, Electron and electron-builder.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Build and launch the app with developer tools open. |
| `npm start` | Build and launch it as the operator sees it. |
| `npm test` | Run the test suite (93 tests). |
| `npm run typecheck` | Typecheck both processes. |
| `npm run build` | Compile main + renderer into `dist/`. |
| `npm run preview` | Serve the interface in a plain browser against sample data — useful for working on the UI without launching Electron. |

## How the build works

Two TypeScript projects, no bundler:

- `tsconfig.main.json` → `dist/main/` (CommonJS, for Node inside Electron)
- `tsconfig.renderer.json` → `dist/renderer/` (ES modules, loaded natively by
  Chromium), then `scripts/copy-static.mjs` copies `index.html` and `styles.css`

Because the renderer emits plain ES modules with explicit `.js` specifiers, the
browser loads them directly. Nothing is bundled, minified or transpiled away —
what you read in `src/` is what runs.

## Packaging

```bash
npm run dist:mac      # .dmg + .zip (Apple silicon and Intel)
npm run dist:win      # NSIS .exe installer
npm run dist:linux    # AppImage + .deb
npm run pack:dir      # unpacked app, for a quick check
```

Output lands in `release/`. See [RELEASE.md](RELEASE.md).

**Build on the platform you are targeting.** A macOS `.dmg` must be built on
macOS; a Windows installer is best built on Windows.

## Working offline

The build needs the network once, for `npm install`. After that everything —
compiling, testing, packaging — works with no network at all.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md#directory-map).
