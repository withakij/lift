# ToTo Company

**Made by Rahul Raj**

A desktop application for collecting product data from specific e-commerce
product pages and turning it into an import-ready file for Shopify or
WooCommerce.

You give it the exact product URLs you care about. It reads those pages — and
only those pages — works out whether each product is simple or variable, keeps
every variant's own price, SKU, stock, weight and image tied to the right
variant, checks the result for anything that would import badly, and writes a
CSV you can hand straight to the destination store.

```
Add URLs  →  choose a category  →  collect  →  validate  →  export  →  import
```

---

## What it does

| | |
|---|---|
| **Reads only what you list** | No crawling. Each URL is an explicit target. |
| **Finds the real structure** | Simple, variable, grouped and external products; parent/variant relationships preserved. |
| **Keeps variants honest** | A variant's price, compare-at price, SKU, barcode, stock, quantity, weight and image are read together and never mixed with another variant's. |
| **Never invents anything** | A field the source page did not publish is left empty and recorded as *unavailable*. No fabricated GTINs, MPNs, brands or Google categories — ever. |
| **Carries your category through** | The category you assign in the app becomes the product's category in the export. You do not set it again after importing. |
| **Tells you what is wrong** | A validation pass grades every problem INFO / WARNING / ERROR / CRITICAL, in plain English, before you export. |
| **Shows its working** | Every field records which extraction layer produced it and how much it can be trusted. |
| **Stays on your machine** | Projects, products and exports live in a local folder. Nothing is uploaded anywhere. |

---

## Installing

Grab the installer for your platform from the release you built (see
[docs/BUILD.md](docs/BUILD.md)), then:

- **macOS** — open the `.dmg`, drag **ToTo Company** to Applications. The first
  launch of an unsigned personal build needs a right-click → **Open** → **Open**;
  after that it opens normally. [Details](docs/RELEASE.md#macos-first-launch)
- **Windows** — run the `.exe` installer.
- **Linux** — run the `.AppImage`, or install the `.deb`.

There is nothing else to install. No Python, no Node.js, no npm, no browser
driver, no database. Everything the app needs is inside it.

---

## Using it

**1 · Create a project** and choose whether it will be imported into Shopify or
WooCommerce. This only decides the shape of the export file.

**2 · Create categories** — Monitors, Keyboards, Wallets. Give each one the
category path the destination store should receive, e.g.
`Electronics > Monitors`.

**3 · Add product URLs** to a category. Paste one, or paste two hundred; a file
of URLs can be imported too. Duplicates are skipped automatically.

**4 · Collect.** Watch progress live. You can pause, resume, stop, and retry
anything that failed. Closing the app mid-run is safe — it picks up where it
left off.

**5 · Validate.** Findings are grouped by product and graded. Critical findings
mean a product is never exported until you deal with them.

**6 · Export.** Preview the exact rows first, choose whether to include products
with warnings or errors, then write the file.

---

## How it reads a page

The scraper escalates only as far as it has to, so a well-behaved page is fast
and an awkward one is still correct:

| Layer | What it reads |
|---|---|
| 1 | Page metadata, OpenGraph, `product:*` tags |
| 2 | schema.org microdata and JSON-LD, including `ProductGroup` / `hasVariant` |
| 3 | Inline product JSON printed by the theme |
| 4 | **Shopify**: `/products/<handle>.js` · **WooCommerce**: Store API, the `data-product_variations` payload, WordPress REST |
| 5 | The page rendered in the built-in browser, for stores that build their product page in JavaScript |
| 6 | Operating the option selectors and reading what changes — a last resort, recorded as lower confidence and flagged for review |

Values from a stronger layer beat values from a weaker one, and when two layers
disagree the disagreement is kept and surfaced.

A variant set is treated as a package: a stronger source replaces the whole set
rather than merging field by field, because half a price from one source and
half a SKU from another is exactly how variant data gets corrupted.

---

## Being a good visitor

The app is built for legitimate migration work and behaves accordingly:

- one request at a time per site, with a configurable gap between them
- `robots.txt` is honoured; a disallowed page is skipped and reported
- `Retry-After` is respected, and failures back off exponentially
- **no** bypasses for logins, paywalls, CAPTCHAs or any other access control —
  a page that refuses us is reported as a failure, not worked around

Only visit sites you have the right to collect from.

---

## Where your data lives

Everything is stored locally in the application's own data folder — the exact
path is shown in **Settings → About**. Projects, categories, URLs, collected
products, validation findings and export history are all there, as plain files
you can back up by copying the folder.

The app makes network requests to exactly two kinds of place: the product pages
you listed, and the same store's own product endpoints for those pages. Nothing
else.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/BUILD.md](docs/BUILD.md) — building from source
- [docs/RELEASE.md](docs/RELEASE.md) — producing installers
- [docs/SECURITY.md](docs/SECURITY.md) — the security model
- [docs/DATA-MODEL.md](docs/DATA-MODEL.md) — the canonical product schema
- [CONTRIBUTING.md](CONTRIBUTING.md) — working on the code

---

## Licence

Personal use. Not for redistribution.
