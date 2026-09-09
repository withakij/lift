Product collection and migration for Shopify and WooCommerce.
**Made by Rahul Raj.**

## New in 1.1.0

The app is now called **Lift**. It was *ToTo Company*; nothing else about it
changed, and an existing installation's projects are carried over the first
time the new version starts.

Four things that quietly damaged an export were fixed:

- **Simple products kept their price.** A product whose price, SKU, stock and
  weight sat on a single variant — which is every "simple" product on Shopify,
  because Shopify has no product without variants — exported to WooCommerce as
  a row with no price, no SKU and no stock at all. Those values are now read
  onto the product row.
- **Weights and sizes are converted, not relabelled.** A 25 lb item was written
  as `25` under a column headed *Weight (kg)*, and inches were written under
  *(cm)*. They are now converted properly, and the unit the source published is
  kept alongside. When a source gives a number but never says the unit, the
  number is passed through untouched and you are told.
- **Nothing Shopify cannot store is dropped in silence.** A product with more
  than three option axes now reports an error naming the axis that will not
  fit, instead of quietly losing it.
- **The exported file cannot go missing.** Exports never overwrite an earlier
  file, names that Windows would mangle are corrected before writing, the file
  is read back after it is written to prove it is really there, and an export
  with nothing in it now says so rather than leaving a file containing only
  column headers.

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
