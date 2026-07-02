import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DEFAULT_SETTINGS, loadSettings, saveSettings, Settings } from './settings';

type SettingsContextValue = {
  settings: Settings;
  /** True once persisted settings have been loaded. */
  ready: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
};

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  ready: false,
  update: async () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const current = useRef<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    loadSettings().then((s) => {
      if (!cancelled) {
        current.current = s;
        setSettings(s);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setSettings(next);
    await saveSettings(next);
  }, []);

  const value = useMemo(() => ({ settings, ready, update }), [settings, ready, update]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
