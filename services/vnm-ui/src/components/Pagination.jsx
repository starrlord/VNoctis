import { useState, useEffect } from 'react';

/**
 * Pagination controls — page numbers with prev/next navigation and a "Show All" toggle.
 *
 * Renders a compact set of page buttons with ellipsis for large page counts.
 * Always shows first, last, and a window around the current page.
 * Uses a tighter window (1 sibling) on narrow / mobile screens to prevent overflow.
 *
 * @param {{
 *   currentPage: number,
 *   totalPages: number,
 *   onPageChange: (page: number) => void,
 *   showAll: boolean,
 *   onToggleShowAll: (val: boolean) => void,
 *   filteredCount: number,
 *   pageSize: number,
 * }} props
 */
export default function Pagination({ currentPage, totalPages, onPageChange, showAll, onToggleShowAll, filteredCount, pageSize }) {
  /** Track viewport width so we can choose a tighter sibling window on phones. */
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 480);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 479px)');
    const handler = (e) => setIsNarrow(e.matches);
    // Modern browsers
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    // Safari <14 fallback
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  /** Scroll to the top of the page and change page — essential on iOS / mobile where
   *  the viewport can be scrolled far down and a page change would otherwise leave
   *  the user stranded mid-page. Uses instant scroll to avoid disorienting animation. */
  const changePage = (page) => {
    onPageChange(page);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  };

  // Nothing to paginate — single page of items (or showing all with ≤pageSize items)
  if (!showAll && totalPages <= 1) return null;
  if (showAll && filteredCount <= pageSize) return null;

  // When showing all, just render the toggle to go back to paginated view
  if (showAll) {
    return (
      <nav className="flex items-center justify-center gap-2 pt-6 pb-2" aria-label="Pagination">
        <button
          onClick={() => { onToggleShowAll(false); window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }}
          className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
            text-blue-500 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-800"
        >
          Show {pageSize} per page
        </button>
      </nav>
    );
  }

  /**
   * Build a windowed array of page numbers and '…' ellipsis markers.
   *
   * Always includes page 1 and `totalPages`.  Shows `siblings` pages on each
   * side of `currentPage`.  Inserts '…' when there is a gap of ≥2 between
   * adjacent visible numbers.
   *
   * On narrow viewports (< 480 px, e.g. iPhone portrait) we use 1 sibling;
   * on wider screens we use 2 siblings so the bar stays comfortably within
   * the viewport.
   */
  const getPageNumbers = () => {
    const siblings = isNarrow ? 1 : 2;

    // If total pages fit comfortably, show them all (no ellipsis needed).
    // Threshold: first + last + 2*siblings + current + 2 potential ellipses
    if (totalPages <= siblings * 2 + 5) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages = new Set();
    pages.add(1);
    pages.add(totalPages);

    const lo = Math.max(2, currentPage - siblings);
    const hi = Math.min(totalPages - 1, currentPage + siblings);
    for (let p = lo; p <= hi; p++) pages.add(p);

    // Sort and insert ellipsis markers where gaps exist
    const sorted = [...pages].sort((a, b) => a - b);
    const result = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
        result.push('…');
      }
      result.push(sorted[i]);
    }
    return result;
  };

  const pageNumbers = getPageNumbers();

  return (
    <nav className="flex flex-wrap items-center justify-center gap-1 pt-6 pb-2" aria-label="Pagination">
      {/* Previous button — icon-only on narrow screens to save space */}
      <button
        onClick={() => changePage(currentPage - 1)}
        disabled={currentPage === 1}
        className="inline-flex items-center px-2 py-1.5 rounded-lg text-sm font-medium transition-colors
          disabled:opacity-30 disabled:cursor-not-allowed
          text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200"
        aria-label="Previous page"
      >
        <svg className="w-4 h-4 sm:mr-1" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
        <span className="hidden sm:inline">Prev</span>
      </button>

      {/* Page numbers (windowed with ellipsis) */}
      {pageNumbers.map((page, idx) =>
        page === '…' ? (
          <span
            key={`ellipsis-${idx}`}
            className="px-1.5 py-1.5 text-sm text-gray-400 dark:text-gray-500 select-none"
          >
            …
          </span>
        ) : (
          <button
            key={page}
            onClick={() => changePage(page)}
            className={`min-w-[2rem] px-2 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              page === currentPage
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
            aria-label={`Page ${page}`}
            aria-current={page === currentPage ? 'page' : undefined}
          >
            {page}
          </button>
        )
      )}

      {/* Next button — icon-only on narrow screens to save space */}
      <button
        onClick={() => changePage(currentPage + 1)}
        disabled={currentPage === totalPages}
        className="inline-flex items-center px-2 py-1.5 rounded-lg text-sm font-medium transition-colors
          disabled:opacity-30 disabled:cursor-not-allowed
          text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200"
        aria-label="Next page"
      >
        <span className="hidden sm:inline">Next</span>
        <svg className="w-4 h-4 sm:ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </button>

      {/* Show All toggle */}
      {filteredCount > pageSize && (
        <>
          <span className="text-gray-300 dark:text-gray-600 select-none">|</span>
          <button
            onClick={() => onToggleShowAll(true)}
            className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors
              text-blue-500 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-gray-800"
          >
            Show All
          </button>
        </>
      )}
    </nav>
  );
}
