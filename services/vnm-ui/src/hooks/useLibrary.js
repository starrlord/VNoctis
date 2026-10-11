import { useState, useEffect, useCallback, useRef } from 'react';
import api from './useApi';

// Keep the last loaded view while navigating; never reuse another session's data.
let libraryCache = null;
const cachedLibrary = () => libraryCache?.token === localStorage.getItem('vnm-token') ? libraryCache.games : null;

/**
 * Custom hook for library data management.
 *
 * @returns {{
 *   games: Array,
 *   loading: boolean,
 *   error: string|null,
 *   refetch: () => void,
 *   scanning: boolean,
 *   triggerScan: () => Promise<void>,
 *   hideGame: (gameId: string, hidden?: boolean) => Promise<void>,
 *   unhideAll: () => Promise<void>,
 *   favoriteGame: (gameId: string, favorite?: boolean) => Promise<void>,
 * }}
 */
export default function useLibrary() {
  const [games, setGames] = useState(() => cachedLibrary() || []);
  const [loading, setLoading] = useState(() => cachedLibrary() === null);
  const loaded = useRef(cachedLibrary() !== null);
  const pending = useRef(null);
  const sessionToken = useRef(localStorage.getItem('vnm-token'));
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  const fetchGames = useCallback(async ({ silent = false } = {}) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const token = localStorage.getItem('vnm-token');
    const showLoading = !silent && !loaded.current;
    if (showLoading) {
      setLoading(true);
      setError(null);
    }
    try {
      const data = await api.get('/library?includeHidden=true', { signal: controller.signal });
      if (controller.signal.aborted || token !== localStorage.getItem('vnm-token')) return;
      loaded.current = true;
      setGames(Array.isArray(data) ? data : []);
      if (!silent) setError(null);
    } catch (err) {
      if (!controller.signal.aborted && !silent && !loaded.current) setError(err.message || 'Failed to fetch library');
    } finally {
      if (!controller.signal.aborted && showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
    return () => pending.current?.abort();
  }, [fetchGames]);

  useEffect(() => {
    if (loaded.current && sessionToken.current === localStorage.getItem('vnm-token')) libraryCache = { token: sessionToken.current, games };
  }, [games]);

  const triggerScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await api.post('/library/scan');
      // After scan completes, refetch the library
      await fetchGames();
    } catch (err) {
      setError(err.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [scanning, fetchGames]);

  const hideGame = useCallback(async (gameId, hidden = true) => {
    try {
      await api.patch(`/library/${gameId}`, { hidden });
      // Optimistically update local state
      setGames((prev) =>
        prev.map((g) => (g.id === gameId ? { ...g, hidden } : g))
      );
    } catch (err) {
      // Revert on error — refetch
      await fetchGames();
    }
  }, [fetchGames]);

  const unhideAll = useCallback(async () => {
    try {
      await api.post('/library/unhide-all');
      // Optimistically update local state
      setGames((prev) => prev.map((g) => ({ ...g, hidden: false })));
    } catch (err) {
      await fetchGames();
    }
  }, [fetchGames]);

  const favoriteGame = useCallback(async (gameId, favorite = true) => {
    // Optimistic update first
    setGames((prev) =>
      prev.map((g) => (g.id === gameId ? { ...g, favorite } : g))
    );
    try {
      if (favorite) {
        await api.post(`/favorites/${gameId}`);
      } else {
        await api.delete(`/favorites/${gameId}`);
      }
    } catch (err) {
      // Revert on error — refetch
      await fetchGames();
    }
  }, [fetchGames]);

  return {
    games,
    loading,
    error,
    refetch: fetchGames,
    scanning,
    triggerScan,
    hideGame,
    unhideAll,
    favoriteGame,
  };
}
