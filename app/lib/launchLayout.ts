/**
 * Launch tab card layout — order + hidden set for the tab's AUX cards, persisted.
 *
 * Same shared store as the Console (lib/cardLayout). The ids here are the aux
 * cards that sit above the game grid: 'installable', 'playlog', 'downloads',
 * 'streamfrompc'. The Now Playing card stays pinned (urgent-by-design) and the
 * game grid is the primary content, so neither is movable. Hold-to-edit hide
 * replaces the old per-card "Hide the downloads card" / "Hide this section"
 * Prefs toggles — one gesture instead of two buried switches.
 */
import { makeCardLayoutStore } from './cardLayout';

const store = makeCardLayoutStore('couchside.launchLayout.v1');

export const useLaunchLayout = store.useLayout;
export const setLaunchLayout = store.setLayout;
export const loadLaunchLayout = store.load;
