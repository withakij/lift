import type { ExtractionContext } from './context';
import { imageIdentity } from '../util/url';
import { log } from '../util/logger';

const BAD_PATTERNS = [
  /\/no[-_]?image/i,
  /placeholder/i,
  /woocommerce-placeholder/i,
  /\/spacer\./i,
  /1x1\.(gif|png)/i,
  /data:image/i,
  /loading\.(gif|svg)/i
];

/** Drops obvious non-product images and de-duplicates by visual identity. */
export function pruneImages(ctx: ExtractionContext): void {
  const kept: typeof ctx.product.images = [];
  const seen = new Set<string>();
  for (const img of ctx.product.images) {
    if (BAD_PATTERNS.some((p) => p.test(img.url))) {
      ctx.warnings.push(`A placeholder image was skipped: ${img.url}`);
      continue;
    }
    const id = imageIdentity(img.url);
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(img);
  }
  kept.sort((a, b) => a.position - b.position);
  kept.forEach((img, i) => (img.position = i + 1));
  ctx.product.images = kept;

  // Re-point variant image URLs at the surviving gallery entry.
  for (const v of ctx.product.variants) {
    if (!v.imageUrl) continue;
    const id = imageIdentity(v.imageUrl);
    const match = kept.find((k) => imageIdentity(k.url) === id);
    if (match) {
      v.imageUrl = match.url;
      if (!match.variantIds.includes(v.id)) match.variantIds.push(v.id);
    }
  }
  if (ctx.product.featuredImageUrl) {
    const id = imageIdentity(ctx.product.featuredImageUrl);
    const match = kept.find((k) => imageIdentity(k.url) === id);
    ctx.product.featuredImageUrl = match ? match.url : kept[0]?.url ?? null;
  }
}

/** HEAD-checks every image URL so broken links are caught before export. */
export async function validateImageUrls(ctx: ExtractionContext): Promise<string[]> {
  if (!ctx.settings.validateImageUrls || ctx.product.images.length === 0) return [];
  const problems: string[] = [];
  const queue = [...ctx.product.images];
  const workers = Math.max(1, Math.min(ctx.settings.imageValidationConcurrency, 8));

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const img = queue.shift();
        if (!img) return;
        try {
          const r = await ctx.fetcher.probe(img.url, {
            timeoutMs: Math.min(ctx.settings.requestTimeoutMs, 15000),
            userAgent: ctx.settings.userAgent
          });
          if (!r.ok) {
            problems.push(`Image ${img.position} did not load (HTTP ${r.status || 'no response'}): ${img.url}`);
          } else if (r.contentType && !/^image\//i.test(r.contentType) && !/octet-stream/i.test(r.contentType)) {
            problems.push(`Image ${img.position} is not an image file (${r.contentType}): ${img.url}`);
          }
        } catch (err) {
          log.debug('images', 'Image probe failed', String(err));
          problems.push(`Image ${img.position} could not be checked: ${img.url}`);
        }
      }
    })
  );
  return problems;
}
