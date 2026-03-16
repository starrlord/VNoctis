import { useState, useEffect, useCallback } from 'react';
import api from './useApi';

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
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  const fetchGames = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const data = await api.get('/library?includeHidden=true');
      setGames(Array.isArray(data) ? data : []);
      if (!silent) setError(null);
    } catch (err) {
      if (!silent) setError(err.message || 'Failed to fetch library');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

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
    try {
      await api.patch(`/library/${gameId}`, { favorite });
      // Optimistically update local state
      setGames((prev) =>
        prev.map((g) => (g.id === gameId ? { ...g, favorite } : g))
      );
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
