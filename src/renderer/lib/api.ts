import type { TotoApi } from '../../shared/ipc';

declare global {
  interface Window {
    toto: TotoApi;
  }
}

/**
 * The only door between the interface and the rest of the app. Everything the
 * UI can do is a method the preload script explicitly exposed.
 */
export const api: TotoApi = window.toto;

export function hasBridge(): boolean {
  return typeof window.toto === 'object' && window.toto !== null;
}
