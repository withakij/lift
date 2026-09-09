import type { LiftApi } from '../../shared/ipc';

declare global {
  interface Window {
    lift: LiftApi;
  }
}

/**
 * The only door between the interface and the rest of the app. Everything the
 * UI can do is a method the preload script explicitly exposed.
 */
export const api: LiftApi = window.lift;

export function hasBridge(): boolean {
  return typeof window.lift === 'object' && window.lift !== null;
}
