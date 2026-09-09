# Architecture

## Why Electron

The application needs four things at once: a polished desktop interface, a real
browser for JavaScript-rendered product pages, local storage, and a single
double-click installer with nothing for the operator to set up.

Electron gives all four, and one of them decisively: **it already contains
Chromium.** Layer-5 rendering and Layer-6 variant interaction run in a hidden
`BrowserWindow`, so there is no Playwright download, no chromedriver, no
separate browser to keep in step with the app. Tauri would have meant shipping a
browser anyway plus a far thinner scraping ecosystem; a bundled Python runtime
would have meant a weaker interface and a heavier installer.

## Why no dependencies

The application has **no third-party runtime dependencies at all** — not even an
HTML parser. `package.json` lists only TypeScript, Electron and electron-builder
as *dev* dependencies.

That is deliberate. A scraper's HTML parser is the component most exposed to
hostile input, and this one is small, readable, fully tested and entirely under
our control (`src/main/dom/`). A supply-chain change cannot break the build, and
`npm install` on a fresh machine has almost nothing to fetch.

## The shape of it

```
┌───────────────────────────────────────────────────────────────┐
│ Renderer  (Chromium, no Node access, CSP-locked)              │
│   plain TypeScript views · no framework · src/renderer/       │
└──────────────────────────────┬────────────────────────────────┘
                               │ contextBridge — one allow-listed
                               │ method per operation
┌──────────────────────────────┴────────────────────────────────┐
│ Main process (Node)                                           │
│                                                               │
│   ipc.ts ──────── queue ──────── scraper/engine                │
│     │                                  │                       │
│     │                                  ├── fetcher (polite HTTP)│
│     │                                  ├── renderer (hidden BW) │
│     │                                  └── extractors/*         │
│     │                                                           │
│     ├──────────── validation/engine                             │
│     ├──────────── export/{shopify,woocommerce}                  │
│     └──────────── db (local store)                              │
└───────────────────────────────────────────────────────────────┘
```

## The one rule everything obeys

```
SOURCE  →  CANONICAL PRODUCT MODEL  →  VALIDATION  →  TARGET ADAPTER
```

No extractor knows what Shopify's CSV looks like. No exporter can reach back
into raw HTML. Adding a third output format is a new file in `src/main/export/`
and nothing else.

## Directory map

| Path | What lives there |
|---|---|
| `src/shared/` | The canonical product model, shared types, the IPC contract. Imported by both processes. |
| `src/main/dom/` | HTML parser, CSS selector engine, jQuery-shaped façade. |
| `src/main/db/` | Local store: `Collection` (small records, one file) and `DocStore` (one file per product plus an index). |
| `src/main/scraper/` | Fetcher, hidden-browser renderer, platform detection, the extraction layers, the provenance-aware merger. |
| `src/main/validation/` | Rules, severities, the run. |
| `src/main/export/` | CSV writer and the target adapters. |
| `src/main/queue/` | The job queue: pause, resume, retry, crash recovery. |
| `src/renderer/` | The interface. `lib/` primitives, `views/` screens, `actions.ts` every operation. |
| `tests/` | 93 tests over extraction accuracy, exports, validation, storage and the DOM. |

## Extraction layers

Ordered weakest to strongest. Each layer *offers* values; an offer only lands if
the field is still empty or the offering layer outranks whatever filled it.

| Rank | Source | Notes |
|---:|---|---|
| 10 | `heuristic` | Our own inference. Always flagged for review. |
| 25 | `opengraph` | `og:` and `product:` meta tags. |
| 30 | `html` | Parsed out of the markup. |
| 35 | `microdata` | schema.org `itemprop`. |
| 55 | `jsonld` | `application/ld+json`. |
| 60 | `embedded-json` | An inline JSON blob the theme printed. |
| 75 | `woo-variation-form` | `data-product_variations`. |
| 80 | `woo-rest` / `platform-api` | WooCommerce Store API, WordPress REST. |
| 85 | `shopify-product-json` | `/products/<handle>.js`. |
| 100 | `user` | Typed in by the operator. |

When two layers disagree, the stronger value is kept **and** the disagreement is
recorded on the field's provenance, so validation can raise it and the Advanced
view can show both readings.

## Variant merging

Variants are merged as whole sets, never field by field:

- If the incoming layer outranks the current one, it **replaces** the entire set
  and the supersession is noted.
- A weaker layer may only fill gaps on variants it can positively match — by the
  platform's own variant id, or by an identical option signature.
- A weaker layer that disagrees about a price or SKU records a conflict rather
  than overwriting.

This is the single most important invariant in the codebase. Mixing a price from
one source with a SKU from another is exactly how a migration silently corrupts
a catalogue.

## Escalation

`ScrapeEngine.scrape()` runs the static layers, then asks whether the product is
still *thin* — no title, no price anywhere, no images, or no variant/SKU/stock
signal at all. Only then does it open the page in the hidden browser, and only
if variants are still unpriced does it operate the option selectors.

A well-formed Shopify page never opens a browser. There is a test that proves it.

## Storage

No native modules, no database server, nothing to install.

- `Collection<T>` — one JSON file of small records, held in memory, atomically
  rewritten on a debounced flush.
- `DocStore<T, I>` — one file per product plus a compact index, so listing and
  filtering never reads every product from disk.

Both write temp → fsync → rename and keep a `.bak` of the last good file, so an
interrupted write cannot leave a half-written database; a corrupt file falls back
to its backup on load. A background flush that fails keeps the record dirty and
reports through the app log rather than losing the data silently.

## The queue

- One URL failing never stops a run.
- Progress is written after each URL, so closing the app loses at most the URL
  in flight.
- A job left `running` by a crash reopens as `paused` and resumes without
  redoing finished work.
- Pause takes effect between URLs; the product in flight is allowed to finish so
  a half-parsed product is never stored.

## The interface

Plain TypeScript, no framework. `h()` builds real DOM nodes; a state change
re-renders the view. At this size that is simpler than a virtual DOM, it removes
React and a bundler from the build, and — because the output is plain ES modules
— the whole interface can be driven in a real browser by
`node scripts/preview.mjs --shot`, which is how it was verified.
