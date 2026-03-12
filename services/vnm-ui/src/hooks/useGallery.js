import { useState, useEffect, useCallback, useMemo } from 'react';
import api from './useApi';

/**
 * Minimum number of games required for a tag-based row to appear.
 */
const MIN_TAG_ROW_SIZE = 3;

/**
 * Maximum number of tag-based rows to display.
 */
const MAX_TAG_ROWS = 8;

/**
 * Read-only hook for the gallery view.
 * Fetches only built, non-hidden games and computes Netflix-style category rows.
 *
 * @returns {{
 *   games: Array,
 *   loading: boolean,
 *   error: string|null,
 *   refetch: () => void,
 *   featuredGame: object|null,
 *   rows: Array<{ title: string, games: Array }>,
 *   searchQuery: string,
 *   setSearchQuery: (q: string) => void,
 *   searchResults: Array,
 * }}
 */
export default function useGallery() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchGames = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/library?buildStatus=built');
      setGames(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to fetch games');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  // Pick featured games for hero rotation: top rated, or random selection
  const featuredGames = useMemo(() => {
    if (!games.length) return [];
    const withRating = games.filter((g) => g.vndbRating != null);
    if (withRating.length) {
      const sorted = [...withRating].sort((a, b) => b.vndbRating - a.vndbRating);
      return sorted.slice(0, Math.min(5, sorted.length));
    }
    // No ratings — pick up to 5 random games
    const shuffled = [...games].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(5, shuffled.length));
  }, [games]);

  // Compute Netflix-style category rows
  const rows = useMemo(() => {
    if (!games.length) return [];
    const result = [];

    // 1. Recently Added — sorted by createdAt desc
    const recentlyAdded = [...games]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);
    if (recentlyAdded.length > 0) {
      result.push({ title: 'Recently Added', games: recentlyAdded });
    }

    // 2. Top Rated — rating ≥ 7, sorted desc
    const topRated = [...games]
      .filter((g) => g.vndbRating != null && g.vndbRating >= 7)
      .sort((a, b) => b.vndbRating - a.vndbRating);
    if (topRated.length >= 2) {
      result.push({ title: 'Top Rated', games: topRated });
    }

    // 3. Quick Plays — length < 120 min
    const quickPlays = games.filter(
      (g) => g.lengthMinutes != null && g.lengthMinutes > 0 && g.lengthMinutes < 120
    );
    if (quickPlays.length >= 2) {
      result.push({ title: 'Quick Plays', games: quickPlays });
    }

    // 4. Tag-based rows — group by most common tags
    const tagMap = new Map();
    for (const game of games) {
      const tags = Array.isArray(game.tags) ? game.tags : safeJsonParse(game.tags, []);
      for (const tag of tags) {
        if (tag.spoiler && tag.spoiler > 0) continue;
        const name = tag.name;
        if (!tagMap.has(name)) tagMap.set(name, []);
        tagMap.get(name).push(game);
      }
    }

    // Sort tags by popularity, take top N
    const tagRows = [...tagMap.entries()]
      .filter(([, tagGames]) => tagGames.length >= MIN_TAG_ROW_SIZE)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_TAG_ROWS);

    for (const [tagName, tagGames] of tagRows) {
      result.push({ title: tagName, games: tagGames });
    }

    // 5. All Games — full collection sorted by title
    const allGames = [...games].sort((a, b) => {
      const tA = (a.vndbTitle || a.extractedTitle || '').toLowerCase();
      const tB = (b.vndbTitle || b.extractedTitle || '').toLowerCase();
      return tA.localeCompare(tB);
    });
    if (allGames.length > 0) {
      result.push({ title: 'All Games', games: allGames });
    }

    return result;
  }, [games]);

  // Search results — flat filtered list when user is searching
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return games.filter((g) => {
      const title = (g.vndbTitle || g.extractedTitle || '').toLowerCase();
      const dev = (g.developer || '').toLowerCase();
      const synopsis = (g.synopsis || '').toLowerCase();
      return title.includes(q) || dev.includes(q) || synopsis.includes(q);
    });
  }, [games, searchQuery]);

  return {
    games,
    loading,
    error,
    refetch: fetchGames,
    featuredGames,
    rows,
    searchQuery,
    setSearchQuery,
    searchResults,
  };
}

/**
 * Safely parse a JSON string, returning a fallback on failure.
 */
function safeJsonParse(str, fallback) {
  if (Array.isArray(str)) return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
