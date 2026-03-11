/**
 * Sort bar showing filtered game count (with page range) and sort dropdown.
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
 * }} props
 */
export default function SortBar({ filteredCount, totalCount, sortBy, onSortChange, currentPage, pageSize, showAll, hiddenCount, showHidden, onToggleShowHidden }) {
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

  return (
    <div className="flex items-center justify-between">
      {/* Left: result count with page range + hidden pill */}
      <div className="flex items-center">
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

        {/* Hidden count pill */}
        {hiddenCount > 0 && (
          <button
            onClick={onToggleShowHidden}
            className={`inline-flex items-center gap-1.5 ml-3 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
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
      </div>

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
  );
}
