import { useState, useMemo, useCallback, useEffect, useRef } from 'react';

/**
 * Page size — 6 on iOS / iPadOS (2 rows × 3 columns) so the grid
 * fits comfortably without scrolling past half-visible cards.
 * Desktop keeps 8 (2 rows × 4 columns on xl, ~3 rows × 3 on lg).
 */
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const PAGE_SIZE = IS_IOS ? 6 : 8;

const STORAGE_KEY = 'vnm-library-filters';

/** Read persisted filter/sort state from sessionStorage. */
function loadSavedFilters() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Custom hook that manages client-side filtering, sorting, and search for the game library.
 *
 * @param {Array} games — raw games array from the API
 * @returns {{
 *   filteredGames: Array,
 *   paginatedGames: Array,
 *   searchQuery: string,
 *   setSearchQuery: (q: string) => void,
 *   ratingFilter: string,
 *   setRatingFilter: (f: string) => void,
 *   buildStatusFilter: string,
 *   setBuildStatusFilter: (f: string) => void,
 *   metadataFilter: string,
 *   setMetadataFilter: (f: string) => void,
 *   selectedTags: Set<string>,
 *   toggleTag: (tag: string) => void,
 *   sortBy: string,
 *   setSortBy: (s: string) => void,
 *   activeFilterCount: number,
 *   clearFilters: () => void,
 *   availableTags: Array<{ name: string, count: number }>,
 *   currentPage: number,
 *   setCurrentPage: (p: number) => void,
 *   totalPages: number,
 *   pageSize: number,
 *   showHidden: boolean,
 *   setShowHidden: (show: boolean) => void,
 *   hiddenCount: number,
 * }}
 */
export default function useFilterSort(games) {
  const saved = useRef(loadSavedFilters()).current;

  const [searchQuery, setSearchQuery] = useState(saved.searchQuery ?? '');
  const [ratingFilter, setRatingFilter] = useState(saved.ratingFilter ?? 'all');
  const [buildStatusFilter, setBuildStatusFilter] = useState(saved.buildStatusFilter ?? 'all');
  const [metadataFilter, setMetadataFilter] = useState(saved.metadataFilter ?? 'all');
  const [selectedTags, setSelectedTags] = useState(() => new Set(saved.selectedTags ?? []));
  const [sortBy, setSortBy] = useState(saved.sortBy ?? 'title-asc');
  const [currentPage, _setCurrentPage] = useState(() => {
    return Math.max(1, saved.currentPage ?? 1);
  });
  const setCurrentPage = useCallback((p) => {
    _setCurrentPage(p);
  }, []);
  const [showAll, setShowAll] = useState(saved.showAll ?? false);
  const [showHidden, setShowHidden] = useState(saved.showHidden ?? false);

  // Persist all filter/sort state to sessionStorage so it survives
  // navigation to the Player page and back.
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        searchQuery,
        ratingFilter,
        buildStatusFilter,
        metadataFilter,
        selectedTags: [...selectedTags],
        sortBy,
        currentPage,
        showAll,
        showHidden,
      }));
    } catch {
      // sessionStorage may be unavailable; degrade gracefully
    }
  }, [searchQuery, ratingFilter, buildStatusFilter, metadataFilter, selectedTags, sortBy, currentPage, showAll, showHidden]);

  // Compute count of hidden games (across unfiltered list)
  const hiddenCount = useMemo(() => {
    return games.filter((g) => g.hidden).length;
  }, [games]);

  // Compute top tags across all games (by frequency)
  const availableTags = useMemo(() => {
    const tagCounts = new Map();
    for (const game of games) {
      if (!game.tags) continue;
      for (const tag of game.tags) {
        tagCounts.set(tag.name, (tagCounts.get(tag.name) || 0) + 1);
      }
    }
    return Array.from(tagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);
  }, [games]);

  const toggleTag = useCallback((tagName) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagName)) {
        next.delete(tagName);
      } else {
        next.add(tagName);
      }
      return next;
    });
  }, []);

  // Count active filters (excluding sort and search)
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (ratingFilter !== 'all') count++;
    if (buildStatusFilter !== 'all') count++;
    if (metadataFilter !== 'all') count++;
    count += selectedTags.size;
    return count;
  }, [ratingFilter, buildStatusFilter, metadataFilter, selectedTags]);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setRatingFilter('all');
    setBuildStatusFilter('all');
    setMetadataFilter('all');
    setSelectedTags(new Set());
    setCurrentPage(1);
  }, []);

  // Apply all filters and sort in a single useMemo
  const filteredGames = useMemo(() => {
    let result = games;

    // 0. Hidden filter — exclude hidden games unless showHidden is active
    if (!showHidden) {
      result = result.filter((game) => !game.hidden);
    }

    // 1. Search filter — case-insensitive match against both titles
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((game) => {
        const vndb = (game.vndbTitle || '').toLowerCase();
        const extracted = (game.extractedTitle || '').toLowerCase();
        return vndb.includes(q) || extracted.includes(q);
      });
    }

    // 2. Rating filter
    if (ratingFilter !== 'all') {
      if (ratingFilter === 'unrated') {
        result = result.filter((game) => game.vndbRating == null);
      } else {
        const minRating = parseFloat(ratingFilter); // '8+' → 8, '7+' → 7, '6+' → 6
        result = result.filter(
          (game) => game.vndbRating != null && game.vndbRating >= minRating
        );
      }
    }

    // 3. Build status filter
    if (buildStatusFilter !== 'all') {
      result = result.filter((game) => {
        switch (buildStatusFilter) {
          case 'built':
            return game.buildStatus === 'built';
          case 'not_built':
            return !game.buildStatus || game.buildStatus === 'not_built';
          case 'building':
            return game.buildStatus === 'building' || game.buildStatus === 'queued';
          case 'failed':
            return game.buildStatus === 'failed';
          default:
            return true;
        }
      });
    }

    // 4. Metadata filter
    if (metadataFilter !== 'all') {
      result = result.filter((game) => {
        if (metadataFilter === 'matched') {
          return game.metadataSource && game.metadataSource !== 'unmatched';
        }
        if (metadataFilter === 'unmatched') {
          return !game.metadataSource || game.metadataSource === 'unmatched';
        }
        return true;
      });
    }

    // 5. Tag filter — game must have ALL selected tags
    if (selectedTags.size > 0) {
      result = result.filter((game) => {
        if (!game.tags) return false;
        const gameTagNames = new Set(game.tags.map((t) => t.name));
        for (const tag of selectedTags) {
          if (!gameTagNames.has(tag)) return false;
        }
        return true;
      });
    }

    // 6. Sort
    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case 'title-asc': {
          const aTitle = (a.vndbTitle || a.extractedTitle || '').toLowerCase();
          const bTitle = (b.vndbTitle || b.extractedTitle || '').toLowerCase();
          return aTitle.localeCompare(bTitle);
        }
        case 'title-desc': {
          const aTitle = (a.vndbTitle || a.extractedTitle || '').toLowerCase();
          const bTitle = (b.vndbTitle || b.extractedTitle || '').toLowerCase();
          return bTitle.localeCompare(aTitle);
        }
        case 'rating-desc': {
          const aR = a.vndbRating ?? -1;
          const bR = b.vndbRating ?? -1;
          return bR - aR;
        }
        case 'rating-asc': {
          const aR = a.vndbRating ?? -1;
          const bR = b.vndbRating ?? -1;
          return aR - bR;
        }
        case 'release-desc': {
          const aD = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
          const bD = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
          return bD - aD;
        }
        case 'release-asc': {
          const aD = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
          const bD = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
          return aD - bD;
        }
        case 'added-desc': {
          const aD = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bD = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bD - aD;
        }
        case 'added-asc': {
          const aD = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bD = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return aD - bD;
        }
        case 'built-desc': {
          const aD = a.builtAt ? new Date(a.builtAt).getTime() : 0;
          const bD = b.builtAt ? new Date(b.builtAt).getTime() : 0;
          return bD - aD;
        }
        case 'built-asc': {
          const aD = a.builtAt ? new Date(a.builtAt).getTime() : Infinity;
          const bD = b.builtAt ? new Date(b.builtAt).getTime() : Infinity;
          return aD - bD;
        }
        default:
          return 0;
      }
    });

    return result;
  }, [games, searchQuery, ratingFilter, buildStatusFilter, metadataFilter, selectedTags, sortBy, showHidden]);

  // Reset to page 1 when filters, search, or sort change (skip initial mount
  // so the page restored from sessionStorage isn't immediately overwritten).
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    setCurrentPage(1);
  }, [searchQuery, ratingFilter, buildStatusFilter, metadataFilter, selectedTags, sortBy]);

  // Pagination derived values
  const totalPages = showAll ? 1 : Math.max(1, Math.ceil(filteredGames.length / PAGE_SIZE));

  // Clamp current page if filteredGames shrinks (e.g. new filter reduces pages)
  const safePage = showAll ? 1 : Math.min(currentPage, totalPages);

  const paginatedGames = useMemo(() => {
    if (showAll) return filteredGames;
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredGames.slice(start, start + PAGE_SIZE);
  }, [filteredGames, safePage, showAll]);

  return {
    filteredGames,
    paginatedGames,
    searchQuery,
    setSearchQuery,
    ratingFilter,
    setRatingFilter,
    buildStatusFilter,
    setBuildStatusFilter,
    metadataFilter,
    setMetadataFilter,
    selectedTags,
    toggleTag,
    sortBy,
    setSortBy,
    activeFilterCount,
    clearFilters,
    availableTags,
    currentPage: safePage,
    setCurrentPage,
    totalPages,
    pageSize: PAGE_SIZE,
    showAll,
    setShowAll,
    showHidden,
    setShowHidden,
    hiddenCount,
  };
}
