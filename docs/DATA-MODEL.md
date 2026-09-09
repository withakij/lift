# The canonical product model

Defined in [`src/shared/canonical.ts`](../src/shared/canonical.ts). Every
extractor writes into it; every exporter reads from it. Nothing else is allowed
to sit between a source page and an import file.

## Rules the model encodes

1. A field the source did not publish is `null` — never guessed, never inherited
   from another product or another variant.
2. Every meaningful field carries **provenance**: which layer produced it, how
   much it can be trusted, and whether another layer disagreed.
3. Variants are first-class children with their own price, SKU, stock, image and
   weight. Parent values are never silently copied down.

## Product

| Group | Fields |
|---|---|
| Identity | `id`, `projectId`, `categoryId`, `categoryPath`, `sourceUrl`, `sourcePlatform`, `sourceProductId`, `handle` |
| Classification | `kind` (`simple` · `variable` · `grouped` · `external` · `unknown`), `sourceProductType` |
| Descriptive | `title`, `vendor`, `brand`, `tags`, `status`, `published`, `descriptionHtml`, `descriptionText`, `shortDescriptionHtml`, `shortDescriptionText`, `purchaseNote` |
| Pricing | `price`, `regularPrice`, `salePrice`, `compareAtPrice`, `costPerItem`, `currency`, `priceMin`, `priceMax` |
| Inventory | `sku`, `barcode`, `stockStatus`, `inventoryQuantity`, `inventoryPolicy`, `backordersAllowed`, `soldIndividually`, `lowStockAmount` |
| Physical | `weight`, `weightUnit`, `length`, `width`, `height`, `dimensionUnit`, `requiresShipping`, `taxable`, `taxStatus`, `taxClass`, `shippingClass` |
| Structure | `options[]`, `attributes[]`, `variants[]`, `images[]`, `featuredImageUrl` |
| Marketing | `seo`, `google` |
| Misc | `ratingValue`, `reviewCount`, `allowReviews`, `externalUrl`, `externalButtonText` |
| Bookkeeping | `provenance`, `extractionNotes`, `layersUsed`, `scrapedAt`, `contentHash`, `debug` |

## Variant

`id`, `sourceVariantId`, `parentProductId`, `title`, `sku`, `barcode`,
`options[]` (name/value pairs — any number of axes, not capped at three),
`price`, `compareAtPrice`, `regularPrice`, `salePrice`, `costPerItem`,
`currency`, `available`, `stockStatus`, `inventoryQuantity`, `inventoryPolicy`,
`inventoryTracker`, `backordersAllowed`, `weight`, `weightUnit`, `length`,
`width`, `height`, `dimensionUnit`, `requiresShipping`, `taxable`, `imageUrl`,
`extraAttributes`, `position`.

`parentProductId` is checked by validation. A variant pointing anywhere else is
CRITICAL and its product is never exported.

## Image

`url`, `position`, `alt`, `title`, `width`, `height`, `isFeatured`,
`variantIds[]`, `source`.

`isFeatured` is set **only** when the source itself identifies a primary image.
When it does not, gallery position 1 is used, recorded as low confidence, and
raised as a finding — the app will not quietly pretend it knew.

## SEO

`title`, `description`, `metaDescription`, `canonicalUrl`, `robots`, `ogTitle`,
`ogDescription`, `ogImage`, `keywords[]`.

## Google Merchant Center

`googleProductCategory`, `productTypeString`, `brand`, `gtin`, `mpn`,
`condition`, `gender`, `ageGroup`, `material`, `pattern`, `color`, `size`,
`sizeSystem`, `itemGroupId`, `identifierExists`, `adsGrouping`, `adsLabels[]`,
`customLabel0`–`customLabel4`, `shippingWeight`, `multipack`, `isBundle`.

**Every one of these stays `null` unless the source page published it.** Nothing
in this application may synthesise a GTIN, MPN, brand or Google category. When
they are missing, validation says so explicitly, in those words.

## Provenance

```ts
provenance['variants[var_7].price'] = {
  source: 'shopify-product-json',
  confidence: 'high',
  note: '/products/x.js',
  conflict: { otherSource: 'opengraph', otherValue: 129 }   // when layers disagreed
}
```

Visible in a product's **Where it came from** tab. `conflict` is what lets
validation warn that two sources on the same page told different stories.

## Mapping to the export formats

| Canonical | Shopify | WooCommerce |
|---|---|---|
| `categoryPath` | `Product Category` + `Type` | `Categories` |
| `variants[]` | one row each, sharing a `Handle` | one `variation` row each, `Parent` = the parent's SKU |
| `variant.weight` + `weightUnit` | `Variant Grams` (converted) | `Weight (kg)` + a `meta:` column preserving the unit |
| `options[]` | `Option1/2/3 Name` + `Value` | numbered `Attribute N` columns |
| `images[]` | one row per image, featured first | comma-separated `Images` |
| `google.*` | `Google Shopping / …` columns | omitted (WooCommerce has no native columns) |

A product with no variants still needs one row in Shopify, which has no concept
of a variant-less product: its own values are presented through a single
`Default Title` variant. That copies nothing between variants and adds nothing
the source did not provide.
