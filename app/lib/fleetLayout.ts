/**
 * Fleet tab card layout — the user's box ORDER + a HIDDEN set, persisted.
 *
 * Same shared store as the Console (lib/cardLayout), but the ids here are BOX
 * ids, so the order is "which box sits where" and hidden is "boxes I don't want
 * cluttering the fleet list". effectiveOrder reconciles against the live box ids
 * every render, so pairing a box appends it and unpairing one drops it cleanly.
 */
import { makeCardLayoutStore } from './cardLayout';

const store = makeCardLayoutStore('couchside.fleetLayout.v1');

export const useFleetLayout = store.useLayout;
export const setFleetLayout = store.setLayout;
export const loadFleetLayout = store.load;
