import { createContext } from 'react';
export const TabSwipeContext = createContext<{ order: string[]; enabled: boolean }>({ order: [], enabled: false });
