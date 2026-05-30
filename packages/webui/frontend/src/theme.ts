import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type Density = 'cozy' | 'comfortable' | 'spacious';

const DEFAULT_ACCENT = '#d97757';
/** Five curated accents from the Claude Design handoff. Match the chat intent
 *  (warm rose default + indigo / forest / amber / slate alternates). */
export const ACCENTS = ['#d97757', '#6b7ec2', '#4f9d76', '#b08940', '#7b8290'] as const;

const KEY = {
  theme: 'qyc-theme',
  density: 'qyc-density',
  accent: 'qyc-accent',
} as const;

function readLS<T extends string>(key: string, fallback: T, allowed?: ReadonlyArray<T>): T {
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  if (allowed && !allowed.includes(raw as T)) return fallback;
  return raw as T;
}

/**
 * App-wide theme + density + accent. Persisted in localStorage, applied via
 * `data-theme` / `data-density` / `--accent` on <html> so every CSS rule in
 * design.css picks them up without prop drilling.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readLS<Theme>(KEY.theme, 'dark', ['light', 'dark']));
  const [density, setDensity] = useState<Density>(() => readLS<Density>(KEY.density, 'comfortable', ['cozy', 'comfortable', 'spacious']));
  const [accent, setAccent] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return DEFAULT_ACCENT;
    return localStorage.getItem(KEY.accent) || DEFAULT_ACCENT;
  });

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    localStorage.setItem(KEY.theme, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset['density'] = density;
    localStorage.setItem(KEY.density, density);
  }, [density]);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
    localStorage.setItem(KEY.accent, accent);
  }, [accent]);

  return { theme, setTheme, density, setDensity, accent, setAccent };
}
