Product collection and migration for Shopify and WooCommerce.
**Made by Rahul Raj.**

## Install

**Windows** — download the `.exe` and run it. SmartScreen will say the
publisher is unknown, because this is an unsigned personal build: choose
**More info → Run anyway**.

**macOS** — download the `.dmg` for your chip (`arm64` for Apple silicon,
`x64` for Intel), open it and drag the app to Applications. The first launch
needs a **right-click → Open → Open**; after that it opens normally.

**Linux** — make the `.AppImage` executable and run it, or install the `.deb`.

Nothing else is required: no Python, no Node.js, no npm, no browser driver,
no database. Everything the app needs is inside it.

## What it does

Reads the exact product URLs you give it — nothing else on the site is
crawled — works out whether each product is simple or variable, and keeps
every variant's own price, compare-at price, SKU, barcode, stock, weight and
image tied to the right variant. It then checks the result for anything that
would import badly and writes an import-ready CSV.

The category you assign in the app becomes the product's category in the
export, so you do not set it again after importing.

A field the source page did not publish is left empty and recorded as
*unavailable*. No GTIN, MPN, brand or Google product category is ever
invented.

## Workflow

```
Add URLs → choose a category → collect → validate → export → import
```
