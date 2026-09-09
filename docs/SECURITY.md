# Security model

## The short version

The application reads public product pages, stores what it finds on your own
machine, and writes CSV files. It has no account, no server, no telemetry and no
update check.

## Process boundary

The interface runs in Chromium with **no Node access at all**:

- `nodeIntegration: false`, `contextIsolation: true`
- every capability crosses the boundary through `src/main/preload.ts`, which
  exposes one named method per operation and nothing else — no general
  `ipcRenderer`, no filesystem, no network
- a Content-Security-Policy allows scripts only from the app itself; the
  interface loads no fonts, no CDN scripts and no analytics
- navigation away from the app is blocked, and real links open in your own
  browser rather than inside the window

## The hidden browser

Pages that need JavaScript are rendered in an offscreen `BrowserWindow` that is:

- sandboxed, with node integration off and context isolation on
- in its own session partition, separate from anything else
- unable to prompt for permissions — every request is denied
- never made visible, and only ever *reads* the page

## HTML from the internet is treated as hostile

- The parser never executes anything. `<script>` and `<style>` bodies are
  captured as opaque text and are never interpreted as markup.
- Product descriptions pass through an allow-list sanitiser: known-good tags and
  attributes survive; scripts, iframes, forms, event handlers, `javascript:`
  URLs and tracking pixels are removed. Only sanitised HTML is ever rendered in
  the interface or written to an export.
- CSV output neutralises formula injection: a value starting with `=`, `+`, `-`
  or `@` is prefixed so a spreadsheet cannot execute scraped text.

## What it will not do

There is no mechanism anywhere in the codebase for defeating a login, a
paywall, a CAPTCHA, a rate limit or any other access control, and none should be
added. A page that refuses us is reported to you as a failure.

`robots.txt` is honoured by default. Requests are rate-limited per host, back off
exponentially, and respect `Retry-After`.

## Your data

- Everything is stored locally, in the folder shown in **Settings → About**.
- No product data is transmitted anywhere. The only outbound requests are to the
  product pages you listed and those stores' own product endpoints.
- No credentials are collected or stored, because the app never signs in to
  anything.
- No API keys or secrets exist in the source. If you ever add an integration
  that needs one, read it from the environment or the OS keychain — never commit
  it.

## Reporting a problem

This is a personal application. If you find something, open an issue in your own
repository with steps to reproduce.
