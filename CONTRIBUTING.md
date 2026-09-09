# Working on Lift

## Setup

```bash
npm install
npm test
npm run dev
```

## The rules that matter

**Never invent data.** If a source page does not publish a field, it stays
`null` and its provenance is recorded as `unavailable`. This applies absolutely
to Merchant Center identifiers — a GTIN, MPN, brand or Google category cannot be
derived from a product page, and a fabricated one makes a feed wrong in a way
that is very hard to notice.

**Variants merge as whole sets.** Never fill one variant's field from a
different source than its siblings. See `mergeVariants` in
`src/main/scraper/productutil.ts`.

**Scrapers know nothing about output formats.** If you find yourself importing
anything from `src/main/export/` into `src/main/scraper/`, stop.

**Errors are written for a person.** "Could not read the variant data on this
page" — not "TypeError: Cannot read property 'variants' of undefined". Technical
detail belongs in the log, behind Advanced mode.

## Adding an extraction layer

1. Create `src/main/scraper/extractors/<name>.ts` exporting an `ExtractionLayer`.
2. Give it an `applies()` that is cheap — it runs on every page.
3. Offer values through `ctx.merger`, never by assigning to the product directly.
4. Add its source to `ExtractionSource` and `SOURCE_RANK` in
   `src/shared/canonical.ts`.
5. Register it in `STATIC_LAYERS` in `engine.ts`.
6. Add a fixture and a test proving what it extracts.

## Adding an output format

1. Create `src/main/export/<format>.ts` exporting an `ExportProfile`. Columns are
   plain data: a header and a function of the row context.
2. Register it in `PROFILES` in `src/main/export/index.ts`.
3. Add the format to `TargetFormat` in `src/shared/types.ts`.
4. Test it against the shared fixtures.

No scraper changes should be needed. If they are, the canonical model is missing
something — add it there.

## Adding a validation rule

Add a `ValidationRule` in `src/main/validation/engine.ts` and register it in
`RULES`. Product-scope rules run per product; project-scope rules run once with
every product.

Pick the severity by what actually happens on import:

- **CRITICAL** — data integrity is compromised; never exported
- **ERROR** — the row would import wrong or be rejected
- **WARNING** — imports fine, but a human should look
- **INFO** — worth knowing, nothing to do

## Testing

```bash
npm test
```

This compiles `src/` and `tests/` to `dist/test/` and runs the suite against the
**compiled output**, so what is tested is what ships.

Tests live in `tests/`, fixtures in `tests/fixtures/`. `tests/helpers.ts`
provides an offline fetcher so extraction tests never touch the network.

When you fix an extraction bug, add the case to a fixture first and watch it
fail. Every bug found so far came from a test that was written before the fix.

## Working on the interface

```bash
npm run build && node scripts/preview.mjs
```

This serves the real interface against sample data in an ordinary browser, so
you can iterate without launching Electron. `node scripts/preview.mjs --shot`
drives it with Playwright, captures every screen, and **fails on any page
error** — worth running before you commit UI changes.

## Verifying without installing anything

`tsconfig.check.json` and `tsconfig.test.local.json` typecheck and build using a
minimal Electron type stub in `tools/offline-types/`, for machines that cannot
reach the npm registry. They are development aids: the real build always uses
`tsconfig.main.json` and `tsconfig.renderer.json` against the real `electron`
package, and the stub is never part of a shipped build.

## Style

- No third-party runtime dependencies. If you need one, you probably do not.
- Comments explain *why*, not *what*.
- Keep operator-facing text in plain language and in the active voice.
