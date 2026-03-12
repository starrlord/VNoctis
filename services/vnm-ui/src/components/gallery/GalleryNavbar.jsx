import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';

/**
 * Netflix-style gallery navbar.
 * Semi-transparent at top, becomes opaque on scroll.
 * Shows search expand/collapse and a link back to admin.
 *
 * @param {{
 *   searchQuery: string,
 *   onSearchChange: (q: string) => void,
 * }} props
 */
export default function GalleryNavbar({ searchQuery, onSearchChange }) {
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef(null);

  // Track scroll position for navbar background opacity
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Focus input when search opens
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const handleSearchToggle = () => {
    if (searchOpen && searchQuery) {
      // Clear search when closing with content
      onSearchChange('');
    }
    setSearchOpen(!searchOpen);
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 h-16 flex items-center justify-between px-4 sm:px-12 transition-all duration-500 ${
        scrolled
          ? 'bg-[#111]/95 shadow-lg shadow-black/50'
          : 'bg-gradient-to-b from-black/80 to-transparent'
      }`}
    >
      {/* Left: Logo */}
      <Link to="/gallery" className="flex items-center gap-2 group">
        <span className="text-xl font-bold text-white tracking-wide select-none">
          🎮 <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent group-hover:from-violet-300 group-hover:to-indigo-300 transition-all">VNoctis</span>
          <span className="text-gray-400 font-medium text-lg ml-1">Game Gallery</span>
        </span>
      </Link>

      {/* Right: Search + Admin link */}
      <div className="flex items-center gap-3">
        {/* Search */}
        <div className="flex items-center">
          <div
            className={`flex items-center overflow-hidden transition-all duration-300 ${
              searchOpen
                ? 'w-48 sm:w-64 bg-black/80 border border-gray-600 rounded-md'
                : 'w-0'
            }`}
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search titles, developers…"
              className="w-full px-3 py-1.5 bg-transparent text-white text-sm placeholder-gray-400 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  onSearchChange('');
                  setSearchOpen(false);
                }
              }}
            />
          </div>
          <button
            onClick={handleSearchToggle}
            className="w-9 h-9 flex items-center justify-center text-white hover:text-gray-300 transition-colors"
            aria-label={searchOpen ? 'Close search' : 'Open search'}
          >
            {searchOpen ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
              </svg>
            )}
          </button>
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-gray-600" />

        {/* Admin link */}
        <Link
          to="/"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors rounded-md hover:bg-white/10"
          title="Back to Admin"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          <span className="hidden sm:inline">Admin</span>
        </Link>
      </div>
    </nav>
  );
}
