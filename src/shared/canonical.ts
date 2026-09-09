/**
 * Canonical Product Model
 * ------------------------------------------------------------------
 * Every scraper writes into THIS model. Every exporter reads from THIS model.
 * No scraper may contain Shopify- or WooCommerce-specific assumptions, and no
 * exporter may reach back into raw HTML.
 *
 *      SOURCE  ->  CANONICAL  ->  VALIDATION  ->  TARGET ADAPTER
 *
 * Rules that this file encodes and the rest of the app must honour:
 *   1. A field that was not found on the source page is `null`, never guessed,
 *      never inherited from another product or another variant.
 *   2. Every meaningful field carries provenance (which extraction layer
 *      produced it) and a confidence rating, recorded in `provenance`.
 *   3. Variants are first-class children with their OWN price / sku / stock /
 *      image / weight. Parent-level values are never copied down silently.
 */

/* ------------------------------------------------------------------ */
/* Provenance & confidence                                             */
/* ------------------------------------------------------------------ */

/** Which extraction layer produced a value. Ordered weakest -> strongest. */
export type ExtractionSource =
  | 'unavailable'
  | 'heuristic'          // derived by our own inference (lowest trust)
  | 'html'               // parsed out of rendered/raw markup
  | 'opengraph'          // og: / twitter: meta tags
  | 'microdata'          // schema.org microdata attributes
  | 'jsonld'             // application/ld+json
  | 'embedded-json'      // an inline JSON blob the theme printed
  | 'woo-variation-form' // WooCommerce data-product_variations payload
  | 'woo-rest'           // WooCommerce Store API / wc-ajax response
  | 'shopify-product-json' // /products/<handle>.js or .json
  | 'platform-api'       // any first-party product endpoint
  | 'user';              // typed in by the operator

export type Confidence = 'none' | 'low' | 'medium' | 'high';

export const SOURCE_CONFIDENCE: Record<ExtractionSource, Confidence> = {
  unavailable: 'none',
  heuristic: 'low',
  html: 'medium',
  opengraph: 'medium',
  microdata: 'medium',
  jsonld: 'high',
  'embedded-json': 'high',
  'woo-variation-form': 'high',
  'woo-rest': 'high',
  'shopify-product-json': 'high',
  'platform-api': 'high',
  user: 'high'
};

/** Numeric rank used when two layers disagree; higher wins. */
export const SOURCE_RANK: Record<ExtractionSource, number> = {
  unavailable: 0,
  heuristic: 10,
  html: 30,
  opengraph: 25,
  microdata: 35,
  jsonld: 55,
  'embedded-json': 60,
  'woo-variation-form': 75,
  'woo-rest': 80,
  'shopify-product-json': 85,
  'platform-api': 80,
  user: 100
};

export interface FieldProvenance {
  source: ExtractionSource;
  confidence: Confidence;
  /** Human-readable note, e.g. "og:price:amount" or "variations JSON index 3". */
  note?: string;
  /** Set when two layers produced different values for the same field. */
  conflict?: { otherSource: ExtractionSource; otherValue: unknown };
}

/** field path (e.g. "title", "variants[2].price") -> provenance */
export type ProvenanceMap = Record<string, FieldProvenance>;

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export type SourcePlatform =
  | 'shopify'
  | 'woocommerce'
  | 'wordpress-generic'
  | 'bigcommerce'
  | 'magento'
  | 'squarespace'
  | 'unknown';

export type ProductKind = 'simple' | 'variable' | 'grouped' | 'external' | 'unknown';

export type StockStatus = 'in_stock' | 'out_of_stock' | 'on_backorder' | 'preorder' | 'unknown';

export type PublishStatus = 'active' | 'draft' | 'archived' | 'unknown';

export type ProductCondition = 'new' | 'refurbished' | 'used' | 'unknown';

/* ------------------------------------------------------------------ */
/* Sub-structures                                                      */
/* ------------------------------------------------------------------ */

export interface CanonicalImage {
  /** Absolute, normalised URL. */
  url: string;
  /** 1-based position within the gallery, in source order. */
  position: number;
  alt: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  /** True only when the source itself identifies this as the primary image. */
  isFeatured: boolean;
  /** Variant ids this image is explicitly bound to by the source. */
  variantIds: string[];
  source: ExtractionSource;
}

export interface CanonicalOptionDefinition {
  /** e.g. "Color" */
  name: string;
  /** Distinct values in source order, e.g. ["Black", "White"] */
  values: string[];
  position: number;
}

export interface CanonicalAttribute {
  name: string;
  values: string[];
  /** WooCommerce global attributes (pa_color) vs. per-product ones. */
  isGlobal: boolean;
  /** Whether the attribute participates in variation selection. */
  isVariation: boolean;
  visible: boolean;
  position: number;
}

export interface CanonicalVariant {
  /** Stable id: platform id when available, otherwise a deterministic hash. */
  id: string;
  /** The platform's own id, verbatim, when it exists. */
  sourceVariantId: string | null;
  /** Parent canonical product id. Never null on a stored variant. */
  parentProductId: string;

  title: string | null;
  sku: string | null;
  barcode: string | null;

  /** Selected option values, aligned with the parent's option definitions. */
  options: Array<{ name: string; value: string }>;

  price: number | null;
  compareAtPrice: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  costPerItem: number | null;
  currency: string | null;

  available: boolean | null;
  stockStatus: StockStatus;
  inventoryQuantity: number | null;
  inventoryPolicy: 'deny' | 'continue' | null;
  inventoryTracker: string | null;
  backordersAllowed: boolean | null;

  weight: number | null;
  weightUnit: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  dimensionUnit: string | null;

  requiresShipping: boolean | null;
  taxable: boolean | null;

  /** URL of the image the source binds to this variant. */
  imageUrl: string | null;

  /** Extra source attributes that are not part of the option axes. */
  extraAttributes: Record<string, string>;

  position: number;
}

export interface SeoData {
  title: string | null;
  description: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robots: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  keywords: string[];
}

/**
 * Google Merchant Center / Shopping attributes.
 * EVERY field here stays null unless the source page actually published it.
 * Nothing in this app may synthesise a GTIN, MPN, brand or Google category.
 */
export interface GoogleShoppingData {
  googleProductCategory: string | null;
  productTypeString: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  condition: ProductCondition;
  gender: string | null;
  ageGroup: string | null;
  material: string | null;
  pattern: string | null;
  color: string | null;
  size: string | null;
  sizeSystem: string | null;
  itemGroupId: string | null;
  identifierExists: boolean | null;
  adsGrouping: string | null;
  adsLabels: string[];
  customLabel0: string | null;
  customLabel1: string | null;
  customLabel2: string | null;
  customLabel3: string | null;
  customLabel4: string | null;
  shippingWeight: string | null;
  multipack: number | null;
  isBundle: boolean | null;
}

export interface CanonicalProduct {
  /* --- identity ------------------------------------------------- */
  id: string;
  projectId: string;
  categoryId: string | null;
  /** The category NAME configured in the app; flows straight to exports. */
  categoryPath: string | null;

  sourceUrl: string;
  sourcePlatform: SourcePlatform;
  /** The store's own product id, verbatim. */
  sourceProductId: string | null;
  handle: string | null;

  /* --- classification ------------------------------------------- */
  kind: ProductKind;
  /** Merchandising type/category string read from the source page. */
  sourceProductType: string | null;

  /* --- descriptive ---------------------------------------------- */
  title: string | null;
  vendor: string | null;
  brand: string | null;
  tags: string[];
  status: PublishStatus;
  published: boolean | null;
  descriptionHtml: string | null;
  descriptionText: string | null;
  shortDescriptionHtml: string | null;
  shortDescriptionText: string | null;
  purchaseNote: string | null;

  /* --- commerce (product level; variants may override) ----------- */
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  compareAtPrice: number | null;
  costPerItem: number | null;
  currency: string | null;
  priceMin: number | null;
  priceMax: number | null;

  sku: string | null;
  barcode: string | null;
  stockStatus: StockStatus;
  inventoryQuantity: number | null;
  inventoryPolicy: 'deny' | 'continue' | null;
  backordersAllowed: boolean | null;
  soldIndividually: boolean | null;
  lowStockAmount: number | null;

  weight: number | null;
  weightUnit: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  dimensionUnit: string | null;

  requiresShipping: boolean | null;
  taxable: boolean | null;
  taxStatus: string | null;
  taxClass: string | null;
  shippingClass: string | null;

  /* --- structure -------------------------------------------------*/
  options: CanonicalOptionDefinition[];
  attributes: CanonicalAttribute[];
  variants: CanonicalVariant[];
  images: CanonicalImage[];
  featuredImageUrl: string | null;

  /* --- marketing -------------------------------------------------*/
  seo: SeoData;
  google: GoogleShoppingData;

  /* --- misc ------------------------------------------------------*/
  ratingValue: number | null;
  reviewCount: number | null;
  allowReviews: boolean | null;
  externalUrl: string | null;
  externalButtonText: string | null;

  /* --- bookkeeping ---------------------------------------------- */
  provenance: ProvenanceMap;
  /** Human-readable notes about anything that could not be determined. */
  extractionNotes: string[];
  /** Layers that actually ran for this product, in order. */
  layersUsed: string[];
  scrapedAt: string;
  contentHash: string | null;
  /** Raw payloads kept for the Advanced/debug view. Never exported. */
  debug?: {
    detectedBy?: string;
    httpStatus?: number;
    renderedWithBrowser?: boolean;
    rawSnippets?: Record<string, string>;
  };
}

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

export function emptySeo(): SeoData {
  return {
    title: null,
    description: null,
    metaDescription: null,
    canonicalUrl: null,
    robots: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    keywords: []
  };
}

export function emptyGoogle(): GoogleShoppingData {
  return {
    googleProductCategory: null,
    productTypeString: null,
    brand: null,
    gtin: null,
    mpn: null,
    condition: 'unknown',
    gender: null,
    ageGroup: null,
    material: null,
    pattern: null,
    color: null,
    size: null,
    sizeSystem: null,
    itemGroupId: null,
    identifierExists: null,
    adsGrouping: null,
    adsLabels: [],
    customLabel0: null,
    customLabel1: null,
    customLabel2: null,
    customLabel3: null,
    customLabel4: null,
    shippingWeight: null,
    multipack: null,
    isBundle: null
  };
}

export function emptyProduct(id: string, projectId: string, sourceUrl: string): CanonicalProduct {
  return {
    id,
    projectId,
    categoryId: null,
    categoryPath: null,
    sourceUrl,
    sourcePlatform: 'unknown',
    sourceProductId: null,
    handle: null,
    kind: 'unknown',
    sourceProductType: null,
    title: null,
    vendor: null,
    brand: null,
    tags: [],
    status: 'unknown',
    published: null,
    descriptionHtml: null,
    descriptionText: null,
    shortDescriptionHtml: null,
    shortDescriptionText: null,
    purchaseNote: null,
    price: null,
    regularPrice: null,
    salePrice: null,
    compareAtPrice: null,
    costPerItem: null,
    currency: null,
    priceMin: null,
    priceMax: null,
    sku: null,
    barcode: null,
    stockStatus: 'unknown',
    inventoryQuantity: null,
    inventoryPolicy: null,
    backordersAllowed: null,
    soldIndividually: null,
    lowStockAmount: null,
    weight: null,
    weightUnit: null,
    length: null,
    width: null,
    height: null,
    dimensionUnit: null,
    requiresShipping: null,
    taxable: null,
    taxStatus: null,
    taxClass: null,
    shippingClass: null,
    options: [],
    attributes: [],
    variants: [],
    images: [],
    featuredImageUrl: null,
    seo: emptySeo(),
    google: emptyGoogle(),
    ratingValue: null,
    reviewCount: null,
    allowReviews: null,
    externalUrl: null,
    externalButtonText: null,
    provenance: {},
    extractionNotes: [],
    layersUsed: [],
    scrapedAt: new Date().toISOString(),
    contentHash: null
  };
}

export function emptyVariant(id: string, parentProductId: string, position: number): CanonicalVariant {
  return {
    id,
    sourceVariantId: null,
    parentProductId,
    title: null,
    sku: null,
    barcode: null,
    options: [],
    price: null,
    compareAtPrice: null,
    regularPrice: null,
    salePrice: null,
    costPerItem: null,
    currency: null,
    available: null,
    stockStatus: 'unknown',
    inventoryQuantity: null,
    inventoryPolicy: null,
    inventoryTracker: null,
    backordersAllowed: null,
    weight: null,
    weightUnit: null,
    length: null,
    width: null,
    height: null,
    dimensionUnit: null,
    requiresShipping: null,
    taxable: null,
    imageUrl: null,
    extraAttributes: {},
    position
  };
}

/* ------------------------------------------------------------------ */
/* Weight helpers (shared by both exporters)                           */
/* ------------------------------------------------------------------ */

const GRAMS_PER: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kgs: 1000,
  kilogram: 1000,
  kilograms: 1000,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125
};

export function toGrams(value: number | null, unit: string | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const key = (unit ?? 'g').trim().toLowerCase();
  const factor = GRAMS_PER[key];
  if (factor === undefined) return null;
  return Math.round(value * factor * 1000) / 1000;
}

export function normaliseWeightUnit(unit: string | null): string | null {
  if (!unit) return null;
  const key = unit.trim().toLowerCase();
  if (['g', 'gram', 'grams'].includes(key)) return 'g';
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(key)) return 'kg';
  if (['lb', 'lbs', 'pound', 'pounds'].includes(key)) return 'lb';
  if (['oz', 'ounce', 'ounces'].includes(key)) return 'oz';
  return null;
}

/**
 * Kilograms, for exports whose weight column is metric. Returns null when the
 * unit is not one we recognise, because a number under the wrong unit is worse
 * than an empty cell: it silently misprices shipping.
 */
export function toKilograms(value: number | null, unit: string | null): number | null {
  const grams = toGrams(value, unit);
  return grams === null ? null : Math.round((grams / 1000) * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ */
/* Dimension helpers                                                   */
/* ------------------------------------------------------------------ */

const CM_PER: Record<string, number> = {
  cm: 1,
  cms: 1,
  centimetre: 1,
  centimetres: 1,
  centimeter: 1,
  centimeters: 1,
  mm: 0.1,
  millimetre: 0.1,
  millimetres: 0.1,
  millimeter: 0.1,
  millimeters: 0.1,
  m: 100,
  metre: 100,
  metres: 100,
  meter: 100,
  meters: 100,
  in: 2.54,
  ins: 2.54,
  inch: 2.54,
  inches: 2.54,
  '"': 2.54,
  ft: 30.48,
  foot: 30.48,
  feet: 30.48,
  yd: 91.44,
  yard: 91.44,
  yards: 91.44
};

export function toCentimetres(value: number | null, unit: string | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const key = (unit ?? 'cm').trim().toLowerCase();
  const factor = CM_PER[key];
  if (factor === undefined) return null;
  return Math.round(value * factor * 1000) / 1000;
}

export function normaliseDimensionUnit(unit: string | null): string | null {
  if (!unit) return null;
  const key = unit.trim().toLowerCase();
  if (['cm', 'cms', 'centimetre', 'centimetres', 'centimeter', 'centimeters'].includes(key)) return 'cm';
  if (['mm', 'millimetre', 'millimetres', 'millimeter', 'millimeters'].includes(key)) return 'mm';
  if (['m', 'metre', 'metres', 'meter', 'meters'].includes(key)) return 'm';
  if (['in', 'ins', 'inch', 'inches', '"'].includes(key)) return 'in';
  if (['ft', 'foot', 'feet'].includes(key)) return 'ft';
  if (['yd', 'yard', 'yards'].includes(key)) return 'yd';
  return null;
}
