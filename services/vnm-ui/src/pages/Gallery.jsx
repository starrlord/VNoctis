import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import useGallery from '../hooks/useGallery';
import GalleryNavbar from '../components/gallery/GalleryNavbar';
import GalleryHero from '../components/gallery/GalleryHero';
import GalleryRow from '../components/gallery/GalleryRow';
import GalleryCard from '../components/gallery/GalleryCard';
import GalleryDetailModal from '../components/gallery/GalleryDetailModal';

/**
 * Netflix-style game gallery page.
 * Read-only view showing built games in categorized horizontal rows.
 * Users can browse, view details, and play games — no admin actions.
 *
 * Supports three view modes:
 *  1. Browse — hero banner + horizontal category rows
 *  2. Search — flat grid filtered by search query
 *  3. Category — full grid for a specific tag/category (via "View More" or tag click)
 */
export default function Gallery() {
  const navigate = useNavigate();
  const {
    games,
    loading,
    error,
    refetch,
    featuredGames,
    rows,
    searchQuery,
    setSearchQuery,
    searchResults,
  } = useGallery();

  const [selectedGameId, setSelectedGameId] = useState(null);

  // Category filter view: { title, games } or null
  const [categoryView, setCategoryView] = useState(null);

  const handleCardClick = useCallback((game) => {
    setSelectedGameId(game.id);
  }, []);

  const handlePlay = useCallback((game) => {
    navigate(`/gallery/play/${game.id}`);
  }, [navigate]);

  const handleModalClose = useCallback(() => {
    setSelectedGameId(null);
  }, []);

  // "View More" from a row → show full grid for that category
  const handleViewMore = useCallback((title, categoryGames) => {
    setCategoryView({ title, games: categoryGames });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Tag click from detail modal → find all games with that tag, show grid
  const handleTagClick = useCallback((tagName) => {
    const tagGames = games.filter((g) => {
      const tags = Array.isArray(g.tags) ? g.tags : [];
      return tags.some((t) => t.name === tagName);
    });
    if (tagGames.length > 0) {
      setCategoryView({ title: tagName, games: tagGames });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [games]);

  // Back to browse from category view
  const handleBackToBrowse = useCallback(() => {
    setCategoryView(null);
  }, []);

  // When searching, clear category view
  const handleSearchChange = useCallback((q) => {
    setSearchQuery(q);
    if (q.trim()) {
      setCategoryView(null);
    }
  }, [setSearchQuery]);

  const isSearching = searchQuery.trim().length > 0;

  // Loading state
  if (loading) {
    return (
      <div className="min-h-dvh bg-[#111]">
        <GalleryNavbar searchQuery="" onSearchChange={() => {}} />
        <div className="flex items-center justify-center min-h-dvh">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-400">Loading gallery…</span>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-dvh bg-[#111]">
        <GalleryNavbar searchQuery="" onSearchChange={() => {}} />
        <div className="flex flex-col items-center justify-center min-h-dvh text-center px-6">
          <svg className="w-16 h-16 text-red-500 mb-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          <p className="text-lg font-semibold text-white mb-2">Failed to load gallery</p>
          <p className="text-sm text-gray-400 mb-4">{error}</p>
          <button
            onClick={refetch}
            className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded-md transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Empty state — no built games
  if (!games || games.length === 0) {
    return (
      <div className="min-h-dvh bg-[#111]">
        <GalleryNavbar searchQuery="" onSearchChange={() => {}} />
        <div className="flex flex-col items-center justify-center min-h-dvh text-center px-6">
          <svg className="w-20 h-20 text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-2.625 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0 1 18 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0 1 18 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 0 1 6 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M19.125 12h1.5m0 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m14.25 0h1.5" />
          </svg>
          <p className="text-lg text-gray-400 font-medium">No games available yet</p>
          <p className="text-sm text-gray-500 mt-2">
            Games need to be built before they appear in the gallery.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#111] text-white">
      {/* Navbar */}
      <GalleryNavbar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
      />

      {/* Content */}
      {isSearching ? (
        /* Search results — flat grid */
        <div className="pt-20 px-4 sm:px-12 pb-12">
          <h2 className="text-xl font-bold text-white mb-4">
            {searchResults.length > 0
              ? `Results for "${searchQuery}" (${searchResults.length})`
              : `No results for "${searchQuery}"`}
          </h2>
          {searchResults.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {searchResults.map((game) => (
                <GalleryCard
                  key={game.id}
                  game={game}
                  onClick={handleCardClick}
                  onPlay={handlePlay}
                />
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">
              Try different keywords or browse the categories below.
            </p>
          )}
        </div>
      ) : categoryView ? (
        /* Category / tag filter view — full grid */
        <div className="pt-20 px-4 sm:px-12 pb-12">
          {/* Header with back button */}
          <div className="flex items-center gap-4 mb-6">
            <button
              onClick={handleBackToBrowse}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-700 text-white transition-colors"
              aria-label="Back to browse"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
              </svg>
            </button>
            <div>
              <h2 className="text-2xl font-bold text-white">{categoryView.title}</h2>
              <p className="text-sm text-gray-400">{categoryView.games.length} game{categoryView.games.length !== 1 ? 's' : ''}</p>
            </div>
          </div>

          {/* Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {categoryView.games.map((game) => (
              <GalleryCard
                key={game.id}
                game={game}
                onClick={handleCardClick}
                onPlay={handlePlay}
              />
            ))}
          </div>
        </div>
      ) : (
        /* Normal gallery view — hero + rows */
        <>
          {/* Hero banner with auto-rotation */}
          <GalleryHero
            games={featuredGames}
            onMoreInfo={handleCardClick}
            onPlay={handlePlay}
          />

          {/* Category rows */}
          <div className="pb-12 -mt-8 relative z-10">
            {rows.map((row) => (
              <GalleryRow
                key={row.title}
                title={row.title}
                games={row.games}
                onCardClick={handleCardClick}
                onPlay={handlePlay}
                onViewMore={handleViewMore}
              />
            ))}
          </div>
        </>
      )}

      {/* Detail modal */}
      {selectedGameId && (
        <GalleryDetailModal
          gameId={selectedGameId}
          onClose={handleModalClose}
          onTagClick={handleTagClick}
        />
      )}
    </div>
  );
}
