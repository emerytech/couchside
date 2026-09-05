/**
 * Console tab card layout — user order + hidden set, persisted.
 *
 * This is now a thin binding over the shared store in lib/cardLayout (Console
 * was the first tab to grow hold-to-edit; Fleet and Actions reuse the same
 * store). The public names below are unchanged, so callers are untouched. The
 * storage key is likewise unchanged, so an existing user's saved Console layout
 * survives the refactor.
 */
import { makeCardLayoutStore, type CardLayout } from './cardLayout';

export { effectiveOrder, moveSection } from './cardLayout';

export type ConsoleLayout = CardLayout;

const store = makeCardLayoutStore('couchside.consoleLayout.v1');

export const useConsoleLayout = store.useLayout;
export const setConsoleLayout = store.setLayout;
export const loadConsoleLayout = store.load;
