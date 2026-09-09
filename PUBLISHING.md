# Getting the installers

The Windows `.exe` (and the macOS `.dmg`, and the Linux packages) are built by
GitHub Actions on real Windows, macOS and Linux machines. You do not need any of
those machines yourself — you only need to push this repository once.

---

## The quick way

Install the [GitHub CLI](https://cli.github.com) if you have not already
(`brew install gh` on macOS), sign in once, then run the script:

```bash
gh auth login
./scripts/publish-to-github.sh
```

That creates a **private** repository called `lift` under your account,
pushes the code, tags `v1.1.0`, and starts the build. It then follows the run and
opens the release page when it finishes.

Want a link anyone can download from without signing in? Make it public instead:

```bash
./scripts/publish-to-github.sh lift --public
```

You can also flip an existing repository later:
**Settings → General → Danger Zone → Change visibility**.

---

## The manual way

```bash
gh repo create lift --private --source=. --remote=origin --push
git tag v1.1.0
git push origin v1.1.0
```

Then watch **Actions** in the repository. About 5–10 minutes later, the
**Releases** page has:

| File | For |
|---|---|
| `Lift Setup 1.1.0.exe` | **Windows** |
| `Lift-1.1.0-arm64.dmg` | macOS, Apple silicon |
| `Lift-1.1.0-x64.dmg` | macOS, Intel |
| `Lift-1.1.0.AppImage`, `.deb` | Linux |

Your download link will be:

```
https://github.com/<your-username>/lift/releases/latest
```

---

## Building without GitHub

If you would rather not use GitHub at all, build on the machine you want the
installer for:

```bash
npm install
npm run dist:win      # on Windows  → release/*.exe
npm run dist:mac      # on macOS    → release/*.dmg
npm run dist:linux    # on Linux    → release/*.AppImage, *.deb
```

A Windows installer really does want a Windows machine. Cross-building one from
macOS needs Wine and produces a worse result, which is exactly why the workflow
above uses a real Windows runner.

---

## What the build does

1. **Typecheck and test** on Linux — 93 tests must pass, or nothing is built.
2. **Build** on Windows, macOS and Linux in parallel.
3. **Publish** every installer to a GitHub Release, with install notes.

If a build fails, the Actions log shows exactly which step and why. The most
likely cause on a first run is a dependency version that has moved on; the
ranges in `package.json` are deliberately loose to avoid that.

---

## About signing

These are unsigned personal builds, because code-signing certificates cost money
and are tied to a verified identity.

- **Windows** shows "Windows protected your PC" → **More info → Run anyway**.
- **macOS** needs a **right-click → Open → Open** the first time.

Both are one-time, per machine. [`docs/RELEASE.md`](docs/RELEASE.md) explains how
to sign properly if you ever get certificates.
