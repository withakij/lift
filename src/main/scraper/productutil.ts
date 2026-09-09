import {
  SOURCE_CONFIDENCE,
  SOURCE_RANK,
  type CanonicalVariant,
  type ExtractionSource
} from '../../shared/canonical';
import { imageIdentity } from '../util/url';
import type { ExtractionContext } from './context';

export function addImages(ctx: ExtractionContext, urls: string[], source: ExtractionSource): void {
  for (const u of urls) addImage(ctx, u, source);
}

export function addImage(
  ctx: ExtractionContext,
  url: string,
  source: ExtractionSource,
  opts?: {
    alt?: string | null;
    title?: string | null;
    isFeatured?: boolean;
    variantIds?: string[];
    width?: number | null;
    height?: number | null;
    position?: number;
  }
): void {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const identity = imageIdentity(url);
  const existing = ctx.product.images.find((i) => imageIdentity(i.url) === identity);
  if (existing) {
    if (opts?.alt && !existing.alt) existing.alt = opts.alt;
    if (opts?.title && !existing.title) existing.title = opts.title;
    if (opts?.isFeatured) existing.isFeatured = true;
    if (opts?.variantIds?.length) {
      for (const v of opts.variantIds) if (!existing.variantIds.includes(v)) existing.variantIds.push(v);
    }
    if (opts?.width && !existing.width) existing.width = opts.width;
    if (opts?.height && !existing.height) existing.height = opts.height;
    // Same photo, better source: take the stronger source's URL, which is the
    // one that has been resolved to the original rendition rather than a
    // thumbnail. Never let a weaker layer's resized URL survive.
    if (SOURCE_RANK[source] > SOURCE_RANK[existing.source]) {
      existing.url = url;
      existing.source = source;
    }
    return;
  }
  ctx.product.images.push({
    url,
    position: opts?.position ?? ctx.product.images.length + 1,
    alt: opts?.alt ?? null,
    title: opts?.title ?? null,
    width: opts?.width ?? null,
    height: opts?.height ?? null,
    isFeatured: opts?.isFeatured ?? false,
    variantIds: opts?.variantIds ?? [],
    source
  });
}

export function optionSignature(v: CanonicalVariant): string {
  return v.options
    .map((o) => `${o.name.trim().toLowerCase()}=${o.value.trim().toLowerCase()}`)
    .sort()
    .join('|');
}

/**
 * Merge a freshly extracted variant set into the product.
 *
 * A variant is a *package*: its price, SKU, stock and image belong together.
 * Mixing halves of two different sources is exactly how variant data gets
 * corrupted, so a stronger layer replaces the whole set rather than field by
 * field. A weaker layer may only fill gaps on variants it can positively match.
 */
export function mergeVariants(ctx: ExtractionContext, incoming: CanonicalVariant[], source: ExtractionSource): void {
  if (!incoming.length) return;
  const currentSource = ctx.product.provenance['variants']?.source;
  const currentRank = currentSource ? SOURCE_RANK[currentSource] : -1;
  const incomingRank = SOURCE_RANK[source];

  if (ctx.product.variants.length === 0 || incomingRank > currentRank) {
    if (ctx.product.variants.length && currentSource) {
      ctx.product.extractionNotes.push(
        `Variant set from ${source} (${incoming.length}) superseded ${currentSource} (${ctx.product.variants.length}).`
      );
      // Drop provenance keys belonging to the discarded variants.
      for (const old of ctx.product.variants) {
        for (const key of Object.keys(ctx.product.provenance)) {
          if (key.startsWith(`variants[${old.id}]`)) delete ctx.product.provenance[key];
        }
      }
    }
    incoming.forEach((v, i) => {
      v.parentProductId = ctx.product.id;
      v.position = i + 1;
      for (const [k, val] of Object.entries(v)) {
        if (val === null || val === undefined || val === '' || k === 'id' || k === 'parentProductId') continue;
        ctx.product.provenance[`variants[${v.id}].${k}`] = { source, confidence: SOURCE_CONFIDENCE[source] };
      }
    });
    ctx.product.variants = incoming;
    ctx.product.provenance['variants'] = {
      source,
      confidence: SOURCE_CONFIDENCE[source],
      note: `${incoming.length} variants`
    };
    return;
  }

  for (const inc of incoming) {
    const match =
      (inc.sourceVariantId ? ctx.product.variants.find((v) => v.sourceVariantId === inc.sourceVariantId) : undefined) ??
      ctx.product.variants.find((v) => optionSignature(v) !== '' && optionSignature(v) === optionSignature(inc));
    if (!match) continue;
    for (const key of Object.keys(inc) as Array<keyof CanonicalVariant>) {
      if (key === 'id' || key === 'parentProductId' || key === 'position' || key === 'options') continue;
      const incVal = inc[key];
      const curVal = match[key];
      const curEmpty = curVal === null || curVal === undefined || curVal === '';
      const incFilled = incVal !== null && incVal !== undefined && incVal !== '';
      if (curEmpty && incFilled) {
        (match as unknown as Record<string, unknown>)[key as string] = incVal;
        ctx.product.provenance[`variants[${match.id}].${String(key)}`] = {
          source,
          confidence: SOURCE_CONFIDENCE[source]
        };
      } else if (!curEmpty && incFilled && curVal !== incVal && (key === 'price' || key === 'sku')) {
        const pk = `variants[${match.id}].${String(key)}`;
        const prior = ctx.product.provenance[pk];
        if (prior) prior.conflict = { otherSource: source, otherValue: incVal };
      }
    }
  }
}

/** Derives product-level option definitions from the variant set. */
export function deriveOptionsFromVariants(ctx: ExtractionContext): void {
  if (ctx.product.options.length > 0) return;
  const order: string[] = [];
  const values = new Map<string, string[]>();
  for (const v of ctx.product.variants) {
    for (const o of v.options) {
      const name = o.name.trim();
      if (!name) continue;
      if (!values.has(name)) {
        values.set(name, []);
        order.push(name);
      }
      const list = values.get(name)!;
      if (o.value && !list.includes(o.value)) list.push(o.value);
    }
  }
  ctx.product.options = order.map((name, i) => ({ name, values: values.get(name) ?? [], position: i + 1 }));
}

/** Chooses the featured image only from an explicit source signal. */
export function resolveFeaturedImage(ctx: ExtractionContext): void {
  if (ctx.product.featuredImageUrl) return;
  const flagged = ctx.product.images.find((i) => i.isFeatured);
  if (flagged) {
    ctx.product.featuredImageUrl = flagged.url;
    ctx.product.provenance['featuredImageUrl'] = {
      source: flagged.source,
      confidence: SOURCE_CONFIDENCE[flagged.source],
      note: 'flagged as primary by the source'
    };
    return;
  }
  if (ctx.product.images.length === 1) {
    ctx.product.featuredImageUrl = ctx.product.images[0].url;
    ctx.product.provenance['featuredImageUrl'] = {
      source: ctx.product.images[0].source,
      confidence: 'medium',
      note: 'only image on the page'
    };
    return;
  }
  // No explicit signal: do not guess. Position 1 is recorded as a low-confidence
  // fallback so the validation engine can raise it for review.
  if (ctx.product.images.length > 1) {
    const first = [...ctx.product.images].sort((a, b) => a.position - b.position)[0];
    ctx.product.featuredImageUrl = first.url;
    ctx.product.provenance['featuredImageUrl'] = {
      source: 'heuristic',
      confidence: 'low',
      note: 'gallery order only — the source did not mark a primary image'
    };
    ctx.product.extractionNotes.push(
      'The source page did not identify a primary image; the first gallery image was used.'
    );
  }
}

export function renumberImages(ctx: ExtractionContext): void {
  ctx.product.images
    .sort((a, b) => a.position - b.position)
    .forEach((img, i) => {
      img.position = i + 1;
    });
}
