/**
 * Actions tab card layout — order + hidden set for the tab's SECTIONS, persisted.
 *
 * Same shared store as the Console (lib/cardLayout). The ids here are the fixed
 * section ids: 'boot' (the Boot Session card) and the three impact groups
 * 'routine' / 'medium' / 'high'. Reorder puts the group you use first up top;
 * hide tucks away a group you never touch (e.g. someone who only switches to
 * desktop can hide "Ends your session"). The Utilities surface is intentionally
 * NOT movable — it is an advanced, opt-in flashing tool that stays pinned.
 */
import { makeCardLayoutStore } from './cardLayout';

const store = makeCardLayoutStore('couchside.actionsLayout.v1');

export const useActionsLayout = store.useLayout;
export const setActionsLayout = store.setLayout;
export const loadActionsLayout = store.load;
