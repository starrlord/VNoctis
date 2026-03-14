import { useState, useEffect, useMemo, useCallback } from 'react';
import GameCard from '../components/GameCard';
import SkeletonCard from '../components/SkeletonCard';
import GameDetailModal from '../components/GameDetailModal';
import SearchAndFilter from '../components/SearchAndFilter';
import SortBar from '../components/SortBar';
import Pagination from '../components/Pagination';
import StarBackground from '../components/StarBackground';
import useFilterSort from '../hooks/useFilterSort';
import useLibrary from '../hooks/useLibrary';

/**
 * Library page — Netflix-style poster wall with search, filter, sort, and detail modal.
 * Owns its own data via useLibrary (fetches games, handles scanning).
 */
export default function Library() {
  const { games, loading, error, refetch, scanning, triggerScan, hideGame, unhideAll } = useLibrary();
  const [selectedGameId, setSelectedGameId] = useState(null);

  // Listen for external refresh events (e.g., after game import from Navbar modal)
  useEffect(() => {
    const handler = () => refetch();
    window.addEventListener('vnm:library-refresh', handler);
    return () => window.removeEventListener('vnm:library-refresh', handler);
  }, [refetch]);

  const {
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
    currentPage,
    setCurrentPage,
    totalPages,
    pageSize,
    showAll,
    setShowAll,
    showHidden,
    setShowHidden,
    hiddenCount,
  } = useFilterSort(games);

  // Compute status counts from all games (unfiltered)
  const unmatchedCount = useMemo(() => games.filter((g) => g.metadataSource === 'unmatched').length, [games]);
  const buildingCount = useMemo(() => games.filter((g) => g.buildStatus === 'building').length, [games]);
  const queuedCount = useMemo(() => games.filter((g) => g.buildStatus === 'queued').length, [games]);

  // Status pill click → set the appropriate filter
  const handleStatusClick = useCallback((status) => {
    clearFilters();
    if (status === 'unmatched') {
      setMetadataFilter('unmatched');
    } else if (status === 'building') {
      setBuildStatusFilter('building');
    } else if (status === 'queued') {
      setBuildStatusFilter('queued');
    }
  }, [clearFilters, setMetadataFilter, setBuildStatusFilter]);

  const handleCardClick = (game) => {
    setSelectedGameId(game.id);
  };

  const handleHide = (game) => {
    hideGame(game.id, !game.hidden);
  };

  const handleUnhideAll = async () => {
    await unhideAll();
    setShowHidden(false);
  };

  const handleModalClose = () => {
    setSelectedGameId(null);
    // Silent refetch preserves the current game list (and scroll position)
    // while updating data in the background.
    refetch({ silent: true });
  };

  // Loading state — show skeleton cards
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <div className="text-red-400 mb-4">
          <svg className="w-16 h-16 mx-auto mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          <p className="text-lg font-semibold">Failed to load library</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{error}</p>
        </div>
        <button
          onClick={refetch}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors duration-200"
        >
          Retry
        </button>
      </div>
    );
  }

  // Empty state
  if (!games || games.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <svg className="w-20 h-20 text-gray-300 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
        </svg>
        <p className="text-lg text-gray-500 dark:text-gray-400 font-medium">No games found</p>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-2 max-w-md">
          Add Ren'Py game directories to your <code className="text-gray-700 dark:text-gray-300 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">/games</code> mount and scan.
        </p>
        <button
          onClick={triggerScan}
          disabled={scanning}
          className="mt-4 flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors duration-200"
        >
          {scanning ? (
            <>
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Scanning…
            </>
          ) : (
            'Scan Library'
          )}
        </button>
      </div>
    );
  }

  // Library with search, filter, sort, and poster grid
  return (
    <>
    <StarBackground fixed darkOnly />
    <div className="relative z-10 p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-4">
      {/* Search and filter controls */}
      <SearchAndFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        ratingFilter={ratingFilter}
        onRatingFilterChange={setRatingFilter}
        buildStatusFilter={buildStatusFilter}
        onBuildStatusFilterChange={setBuildStatusFilter}
        metadataFilter={metadataFilter}
        onMetadataFilterChange={setMetadataFilter}
        selectedTags={selectedTags}
        onToggleTag={toggleTag}
        availableTags={availableTags}
        activeFilterCount={activeFilterCount}
        onClearFilters={clearFilters}
      />

      {/* Sort bar with count + scan button */}
      <div className="flex items-start justify-between gap-4">
        <SortBar className="flex-1 min-w-0"
          filteredCount={filteredGames.length}
          totalCount={games.length}
          sortBy={sortBy}
          onSortChange={setSortBy}
          currentPage={currentPage}
          pageSize={pageSize}
          showAll={showAll}
          hiddenCount={hiddenCount}
          showHidden={showHidden}
          onToggleShowHidden={() => setShowHidden(!showHidden)}
          unmatchedCount={unmatchedCount}
          buildingCount={buildingCount}
          queuedCount={queuedCount}
          onStatusClick={handleStatusClick}
        />

        <div className="flex items-center gap-2 flex-shrink-0">
          {showHidden && hiddenCount > 0 && (
            <button
              onClick={handleUnhideAll}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-orange-500 dark:text-orange-400 hover:text-orange-600 dark:hover:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-900/20 rounded-lg transition-colors duration-200"
              title="Unhide all hidden games"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
              Unhide All
            </button>
          )}
          <button
            onClick={triggerScan}
            disabled={scanning}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-200"
            title="Rescan games directory"
          >
            {scanning ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Scanning…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                </svg>
                Rescan
              </>
            )}
          </button>
        </div>
      </div>

      {/* Poster grid */}
      {filteredGames.length > 0 ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {paginatedGames.map((game) => (
              <GameCard key={game.id} game={game} onClick={handleCardClick} onHide={handleHide} />
            ))}
          </div>

          {/* Pagination controls */}
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            showAll={showAll}
            onToggleShowAll={setShowAll}
            filteredCount={filteredGames.length}
            pageSize={pageSize}
          />
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <p className="text-gray-500 dark:text-gray-400 font-medium">No games match your filters</p>
          <button
            onClick={clearFilters}
            className="mt-3 text-sm text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300 font-medium transition-colors"
          >
            Clear all filters
          </button>
        </div>
      )}
    </div>

    {/* Detail modal — rendered outside the z-10 stacking context so its
        z-[55] correctly layers above the Navbar (z-50) on all platforms. */}
    {selectedGameId && (
      <GameDetailModal
        gameId={selectedGameId}
        onClose={handleModalClose}
        onDeleted={() => {
          setSelectedGameId(null);
          refetch();
        }}
        onHide={handleHide}
        onTagClick={(tagName) => {
          clearFilters();
          toggleTag(tagName);
          setSelectedGameId(null);
        }}
      />
    )}
    </>
  );
}
