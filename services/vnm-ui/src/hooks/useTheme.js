import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for managing dark/light theme toggle.
 *
 * - Reads initial value from localStorage('vnm-theme') or defaults to 'dark'
 * - Applies theme by adding/removing 'dark' class on document.documentElement
 * - Persists selection to localStorage on change
 *
 * @returns {{ theme: 'dark'|'light', toggleTheme: () => void, isDark: boolean }}
 */
export default function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('vnm-theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  const isDark = theme === 'dark';

  // Apply dark class to <html> whenever theme changes
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('vnm-theme', theme);
    } catch {
      // localStorage unavailable — no-op
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme, isDark };
}
