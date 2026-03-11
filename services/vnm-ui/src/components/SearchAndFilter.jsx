import { useState, useEffect, useRef } from 'react';

/**
 * Search bar with debounced input and filter chip rows for the library.
 *
 * @param {{
 *   searchQuery: string,
 *   onSearchChange: (q: string) => void,
 *   ratingFilter: string,
 *   onRatingFilterChange: (f: string) => void,
 *   buildStatusFilter: string,
 *   onBuildStatusFilterChange: (f: string) => void,
 *   metadataFilter: string,
 *   onMetadataFilterChange: (f: string) => void,
 *   selectedTags: Set<string>,
 *   onToggleTag: (tag: string) => void,
 *   availableTags: Array<{ name: string, count: number }>,
 *   activeFilterCount: number,
 *   onClearFilters: () => void,
 * }} props
 */
export default function SearchAndFilter({
  searchQuery,
  onSearchChange,
  ratingFilter,
  onRatingFilterChange,
  buildStatusFilter,
  onBuildStatusFilterChange,
  metadataFilter,
  onMetadataFilterChange,
  selectedTags,
  onToggleTag,
  availableTags,
  activeFilterCount,
  onClearFilters,
}) {
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [tagsExpanded, setTagsExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem('vnm-tags-expanded');
      return stored !== null ? JSON.parse(stored) : true;
    } catch {
      return true;
    }
  });
  const debounceRef = useRef(null);

  // Sync external state → local (e.g., on clearFilters)
  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  // Debounced search
  const handleInputChange = (e) => {
    const value = e.target.value;
    setLocalQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange(value);
    }, 300);
  };

  const handleClear = () => {
    setLocalQuery('');
    onSearchChange('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
  };

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const ratingOptions = [
    { value: 'all', label: 'Any Rating' },
    { value: '8+', label: '8+' },
    { value: '7+', label: '7+' },
    { value: '6+', label: '6+' },
    { value: 'unrated', label: 'Unrated' },
  ];

  const buildOptions = [
    { value: 'all', label: 'All' },
    { value: 'built', label: 'Built ✅' },
    { value: 'not_built', label: 'Not Built' },
    { value: 'building', label: 'Building 🔄' },
    { value: 'failed', label: 'Failed ❌' },
  ];

  const metadataOptions = [
    { value: 'all', label: 'All' },
    { value: 'matched', label: 'Matched' },
    { value: 'unmatched', label: 'Unmatched' },
  ];

  return (
    <div className="space-y-3">
      {/* Search input */}
      <div className="relative">
        {/* Search icon */}
        <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-gray-400 dark:text-gray-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
        </div>
        <input
          type="text"
          value={localQuery}
          onChange={handleInputChange}
          placeholder="Search by title..."
          className="w-full pl-10 pr-10 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
        />
        {/* Clear button */}
        {localQuery && (
          <button
            onClick={handleClear}
            className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
            aria-label="Clear search"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {/* Rating filter group */}
        <FilterGroup label="Rating">
          {ratingOptions.map((opt) => (
            <Chip
              key={opt.value}
              label={opt.label}
              active={ratingFilter === opt.value}
              onClick={() => onRatingFilterChange(opt.value)}
            />
          ))}
        </FilterGroup>

        {/* Build status group */}
        <FilterGroup label="Build">
          {buildOptions.map((opt) => (
            <Chip
              key={opt.value}
              label={opt.label}
              active={buildStatusFilter === opt.value}
              onClick={() => onBuildStatusFilterChange(opt.value)}
            />
          ))}
        </FilterGroup>

        {/* Metadata group */}
        <FilterGroup label="Metadata">
          {metadataOptions.map((opt) => (
            <Chip
              key={opt.value}
              label={opt.label}
              active={metadataFilter === opt.value}
              onClick={() => onMetadataFilterChange(opt.value)}
            />
          ))}
        </FilterGroup>
        {/* Tags toggle button */}
        {availableTags.length > 0 && (
          <TagsToggle
            count={selectedTags.size}
            expanded={tagsExpanded}
            onToggle={() => setTagsExpanded((prev) => {
              const next = !prev;
              try { localStorage.setItem('vnm-tags-expanded', JSON.stringify(next)); } catch {}
              return next;
            })}
          />
        )}
      </div>

      {/* Collapsible tag chips */}
      {availableTags.length > 0 && (
        <div
          className={`overflow-hidden transition-all duration-300 ease-in-out ${
            tagsExpanded ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
          }`}
        >
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-medium mr-1">Tags:</span>
            {availableTags.map((tag) => (
              <button
                key={tag.name}
                onClick={() => onToggleTag(tag.name)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedTags.has(tag.name)
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {tag.name}
                <span className="ml-1 opacity-60">{tag.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Clear all filters button */}
      {activeFilterCount > 0 && (
        <div className="flex items-center">
          <button
            onClick={onClearFilters}
            className="text-xs text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300 font-medium transition-colors"
          >
            ✕ Clear all filters ({activeFilterCount})
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Small inline label for a filter group.
 */
function FilterGroup({ label, children }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">{label}:</span>
      <div className="flex gap-1">
        {children}
      </div>
    </div>
  );
}

/**
 * Individual filter chip button.
 */
function Chip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Toggle button for showing/hiding the tag chip row.
 */
function TagsToggle({ count, expanded, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
        count > 0
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide tags' : 'Show tags'}
    >
      🏷️ Tags{count > 0 && ` (${count})`}
      <svg
        className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2.5}
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </svg>
    </button>
  );
}
