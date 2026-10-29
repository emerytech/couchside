import { createContext } from 'react';

/** Ephemeral coordination with the tab shell: one hint at a time. */
export const PadGuidanceContext = createContext({
  busy: true,
  onRotationTipVisibility: (_visible: boolean) => {},
});
