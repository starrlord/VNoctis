/**
 * Sort bar showing filtered game count (with page range), status pills, and sort dropdown.
 *
 * @param {{
 *   filteredCount: number,
 *   totalCount: number,
 *   sortBy: string,
 *   onSortChange: (value: string) => void,
 *   currentPage: number,
 *   pageSize: number,
 *   showAll: boolean,
 *   hiddenCount: number,
 *   showHidden: boolean,
 *   onToggleShowHidden: () => void,
 *   favoriteCount?: number,
 *   showFavorites?: boolean,
 *   onToggleShowFavorites?: () => void,
 *   unmatchedCount?: number,
 *   buildingCount?: number,
 *   queuedCount?: number,
 *   onStatusClick?: (status: string) => void,
 * }} props
 */
export default function SortBar({ filteredCount, totalCount, sortBy, onSortChange, currentPage, pageSize, showAll, hiddenCount, showHidden, onToggleShowHidden, favoriteCount = 0, showFavorites = false, onToggleShowFavorites, unmatchedCount = 0, buildingCount = 0, queuedCount = 0, onStatusClick, className = '' }) {
  const sortOptions = [
    { value: 'title-asc', label: 'Title (A–Z)' },
    { value: 'title-desc', label: 'Title (Z–A)' },
    { value: 'rating-desc', label: 'Rating (High → Low)' },
    { value: 'rating-asc', label: 'Rating (Low → High)' },
    { value: 'release-desc', label: 'Release Date (Newest)' },
    { value: 'release-asc', label: 'Release Date (Oldest)' },
    { value: 'added-desc', label: 'Date Added (Newest)' },
    { value: 'added-asc', label: 'Date Added (Oldest)' },
    { value: 'built-desc', label: 'Last Build (Newest)' },
    { value: 'built-asc', label: 'Last Build (Oldest)' },
  ];

  const hasStatusPills = favoriteCount > 0 || hiddenCount > 0 || unmatchedCount > 0 || buildingCount > 0 || queuedCount > 0;

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Top row: result count + sort dropdown */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {filteredCount > 0 ? (
            showAll ? (
              <>
                Showing all{' '}
                <span className="text-gray-700 dark:text-gray-200 font-medium">{filteredCount}</span>
                {filteredCount !== totalCount && (
                  <>
                    {' '}of{' '}
                    <span className="text-gray-700 dark:text-gray-200 font-medium">{totalCount}</span>
                  </>
                )}
                {' '}{totalCount === 1 ? 'game' : 'games'}
              </>
            ) : (
              <>
                Showing{' '}
                <span className="text-gray-700 dark:text-gray-200 font-medium">
                  {Math.min((currentPage - 1) * pageSize + 1, filteredCount)}–{Math.min(currentPage * pageSize, filteredCount)}
                </span>
                {' '}of{' '}
                <span className="text-gray-700 dark:text-gray-200 font-medium">{filteredCount}</span>
                {filteredCount !== totalCount && (
                  <>
                    {' '}(
                    <span className="text-gray-700 dark:text-gray-200 font-medium">{totalCount}</span>
                    {' '}total)
                  </>
                )}
                {' '}{totalCount === 1 ? 'game' : 'games'}
              </>
            )
          ) : (
            <>
              Showing{' '}
              <span className="text-gray-700 dark:text-gray-200 font-medium">0</span>
              {' '}{totalCount === 1 ? 'game' : 'games'}
            </>
          )}
        </p>

        {/* Right: sort select */}
        <div className="flex items-center gap-2">
          <label htmlFor="sort-select" className="text-xs text-gray-400 dark:text-gray-500 hidden sm:inline">
            Sort by:
          </label>
          <select
            id="sort-select"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-700 dark:text-gray-300 px-3 py-1.5 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors cursor-pointer"
          >
            {sortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Status pills row — only rendered when there are pills to show */}
      {hasStatusPills && (
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Favorites count pill */}
          {favoriteCount > 0 && (
            <button
              onClick={onToggleShowFavorites}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                showFavorites
                  ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/30'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              title={showFavorites ? 'Show all games' : 'Show favorites only'}
            >
              <svg className="w-3.5 h-3.5" fill={showFavorites ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
              </svg>
              {favoriteCount} favorite{favoriteCount !== 1 ? 's' : ''}
            </button>
          )}

          {/* Hidden count pill */}
          {hiddenCount > 0 && (
            <button
              onClick={onToggleShowHidden}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                showHidden
                  ? 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/30'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              title={showHidden ? 'Hide hidden games' : 'Show hidden games'}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
              </svg>
              {hiddenCount} hidden
            </button>
          )}

          {/* Unmatched count pill */}
          {unmatchedCount > 0 && (
            <button
              onClick={() => onStatusClick?.('unmatched')}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/25 hover:bg-orange-500/25 transition-all duration-200"
              title="Show unmatched games"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              {unmatchedCount} unmatched
            </button>
          )}

          {/* Building count pill */}
          {buildingCount > 0 && (
            <button
              onClick={() => onStatusClick?.('building')}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/25 hover:bg-blue-500/25 animate-pulse transition-all duration-200"
              title="Show building games"
            >
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {buildingCount} building
            </button>
          )}

          {/* Queued count pill */}
          {queuedCount > 0 && (
            <button
              onClick={() => onStatusClick?.('queued')}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/25 hover:bg-yellow-500/25 transition-all duration-200"
              title="Show queued games"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              {queuedCount} queued
            </button>
          )}
        </div>
      )}
    </div>
  );
}
