import type { CheerioAPI } from '../dom';
import type { CanonicalProduct } from '../../shared/canonical';
import type { AppSettings } from '../../shared/types';
import type { FetchLike } from './fetcher';
import type { Merger } from './merge';
import type { PageHarvest, VariantObservation } from './renderer';
import type { PlatformDetection } from './detect';

export interface ExtractionContext {
  /** URL as supplied by the operator. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  html: string;
  $: CheerioAPI;
  headers: Record<string, string>;
  detection: PlatformDetection;
  harvest: PageHarvest | null;
  interaction: VariantObservation[] | null;
  renderedWithBrowser: boolean;
  fetcher: FetchLike;
  settings: AppSettings;
  product: CanonicalProduct;
  merger: Merger;
  warnings: string[];
  /** Raw payloads kept for the Advanced view. */
  snippets: Record<string, string>;
}

export interface LayerResult {
  /** Number of fields this layer actually contributed. */
  produced: number;
  note?: string;
  /** Set when the layer is confident it found the complete variant set. */
  variantsAuthoritative?: boolean;
}

export interface ExtractionLayer {
  id: string;
  label: string;
  /** Cheap check so we do not run irrelevant layers. */
  applies(ctx: ExtractionContext): boolean;
  run(ctx: ExtractionContext): Promise<LayerResult>;
}

/** Counts how many provenance entries exist, used to measure a layer's yield. */
export function provenanceSize(p: CanonicalProduct): number {
  return Object.keys(p.provenance).length;
}
