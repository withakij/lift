import type { CanonicalImage, CanonicalProduct, CanonicalVariant } from '../../shared/canonical';
import type { TargetFormat } from '../../shared/types';

export interface RowContext {
  product: CanonicalProduct;
  variant: CanonicalVariant | null;
  image: CanonicalImage | null;
  rowType: 'primary' | 'variant' | 'image';
  index: number;
  /** Adapter-specific extras (e.g. WooCommerce parent reference). */
  extra?: Record<string, string>;
}

export interface ExportColumn {
  header: string;
  get(ctx: RowContext): string;
}

export interface ExportProfile {
  id: string;
  format: TargetFormat;
  label: string;
  description: string;
  /** Static columns. `dynamicColumns` may append more per export. */
  columns: ExportColumn[];
  /** Columns that depend on the data set (e.g. how many attributes exist). */
  dynamicColumns?(products: CanonicalProduct[]): ExportColumn[];
  buildRows(product: CanonicalProduct, all: CanonicalProduct[]): RowContext[];
}
