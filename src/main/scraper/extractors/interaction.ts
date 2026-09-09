/**
 * Layer 6 — variant interaction.
 *
 * Only runs when the stronger layers could not produce a complete variant set.
 * The renderer has already clicked through each option combination and recorded
 * what the page displayed; this layer turns those observations into variants.
 *
 * Because the values come from rendered text rather than a data payload they
 * are recorded as `html` provenance, which ranks below every structured source,
 * and every product built this way is flagged for review.
 */
import type { ExtractionContext, ExtractionLayer, LayerResult } from '../context';
import { cleanText, currencyFrom, parseMoney } from '../merge';
import { absoluteUrl } from '../../util/url';
import { emptyVariant, type CanonicalVariant, type StockStatus } from '../../../shared/canonical';
import { addImage, mergeVariants, optionSignature } from '../productutil';
import { newId } from '../../db/store';

function stockFrom(text: string | null): StockStatus {
  if (!text) return 'unknown';
  const s = text.toLowerCase();
  if (s.includes('backorder')) return 'on_backorder';
  if (s.includes('pre-order') || s.includes('preorder')) return 'preorder';
  if (s.includes('out of stock') || s.includes('sold out') || s.includes('unavailable')) return 'out_of_stock';
  if (s.includes('in stock') || /\d+\s*(in stock|available)/.test(s)) return 'in_stock';
  return 'unknown';
}

export const interactionLayer: ExtractionLayer = {
  id: 'interaction',
  label: 'Variant interaction',

  applies(ctx) {
    if (!ctx.interaction || ctx.interaction.length === 0) return false;
    // Skip when a structured source already gave us priced variants.
    const have = ctx.product.variants;
    if (have.length > 1 && have.every((v) => v.price !== null)) return false;
    return true;
  },

  async run(ctx): Promise<LayerResult> {
    const observations = ctx.interaction ?? [];
    if (!observations.length) return { produced: 0 };

    const seen = new Set<string>();
    const built: CanonicalVariant[] = [];

    observations.forEach((obs, i) => {
      const v = emptyVariant(newId('var_'), ctx.product.id, i + 1);
      v.options = obs.selection
        .map((s) => ({ name: cleanText(s.name) ?? 'Option', value: cleanText(s.value) ?? '' }))
        .filter((o) => o.value !== '');
      const sig = optionSignature(v);
      if (!sig || seen.has(sig)) return;
      seen.add(sig);

      v.sourceVariantId = cleanText(obs.variantId);
      v.price = parseMoney(obs.price);
      v.compareAtPrice = parseMoney(obs.comparePrice);
      v.regularPrice = v.compareAtPrice ?? v.price;
      v.salePrice = v.compareAtPrice !== null && v.price !== null && v.price < v.compareAtPrice ? v.price : null;
      v.currency = currencyFrom(obs.price);
      v.sku = cleanText(obs.sku);
      v.stockStatus = stockFrom(obs.availabilityText);
      v.available = v.stockStatus === 'unknown' ? null : v.stockStatus === 'in_stock';
      const img = absoluteUrl(obs.imageUrl, ctx.finalUrl);
      if (img) {
        v.imageUrl = img;
        addImage(ctx, img, 'html', { variantIds: [v.id] });
      }
      built.push(v);
    });

    if (!built.length) return { produced: 0 };

    // If several combinations produced identical output the page may not have
    // reacted at all; that is worth saying out loud rather than exporting it.
    const distinctPrices = new Set(built.map((v) => String(v.price)));
    const distinctSkus = new Set(built.map((v) => String(v.sku)));
    if (built.length > 1 && distinctPrices.size === 1 && distinctSkus.size === 1) {
      ctx.warnings.push(
        'Selecting different options did not change the displayed price or SKU, so variant-specific values could not be confirmed.'
      );
    }

    mergeVariants(ctx, built, 'html');
    ctx.merger.set('kind', 'variable', 'html', 'variant selectors present');
    ctx.product.extractionNotes.push(
      `${built.length} variants were read by operating the option selectors on the page rather than from structured data.`
    );

    return { produced: 1, note: `${built.length} observed combinations` };
  }
};
