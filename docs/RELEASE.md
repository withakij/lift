# Producing a release

## 1 · Check it

```bash
npm run typecheck
npm test
```

Both must be clean. `npm test` covers extraction accuracy against captured
Shopify and WooCommerce fixtures, both export adapters, every validation rule,
the storage layer and the queue's crash recovery.

To eyeball the interface:

```bash
npm run build
node scripts/preview.mjs        # http://localhost:5273, sample data
```

## 2 · Set the version

Bump `version` in `package.json`, then commit and tag:

```bash
git commit -am "Release 1.0.1"
git tag v1.0.1
```

## 3 · Build the installers

```bash
npm run dist:mac      # on macOS
npm run dist:win      # on Windows
npm run dist:linux    # on Linux
```

Artefacts appear in `release/`:

| Platform | File |
|---|---|
| macOS | `ToTo Company-<version>-arm64.dmg`, `-x64.dmg`, plus `.zip` |
| Windows | `ToTo Company Setup <version>.exe` |
| Linux | `ToTo Company-<version>.AppImage`, `.deb` |

## macOS first launch

The build is unsigned, because signing needs a paid Apple Developer ID. macOS
therefore quarantines it on first open.

**Right-click the app → Open → Open.** Once only; it opens normally afterwards.

If macOS refuses outright, clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/ToTo Company.app"
```

If you do get a Developer ID later, set `identity` in `electron-builder.yml` to
your certificate name and turn `hardenedRuntime` back on; add notarisation
credentials as environment variables rather than putting them in the file.

## Windows SmartScreen

An unsigned installer shows "Windows protected your PC". Choose **More info →
Run anyway**. A code-signing certificate removes this.

## 4 · Install

Copy the installer to the machine and run it. Nothing else is needed — no
runtime, no dependencies, no configuration.

## Upgrading

The app never checks for updates or contacts a server. Install the new version
over the old one; your data lives outside the application bundle and is kept.

Back it up first if you like — the folder is shown in **Settings → About**.
