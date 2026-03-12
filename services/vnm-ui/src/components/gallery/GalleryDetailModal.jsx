import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../hooks/useApi';
import ScreenshotLightbox from '../ScreenshotLightbox';
import {
  formatRating,
  formatDate,
  formatLength,
  getRatingColor,
  generateGradient,
} from '../../lib/utils';

/**
 * Read-only game detail modal for the gallery.
 * Shows game information, screenshots, and a Play button — no admin actions.
 *
 * @param {{
 *   gameId: string,
 *   onClose: () => void,
 *   galleryPlayPath?: string,
 *   onTagClick?: (tagName: string) => void,
 * }} props
 */
export default function GalleryDetailModal({ gameId, onClose, galleryPlayPath, onTagClick }) {
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showSpoilerTags, setShowSpoilerTags] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);

  // Fetch game detail
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.get(`/library/${gameId}`)
      .then((data) => {
        if (!cancelled) setGame(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load game details');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [gameId]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Focus trap & Escape key
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    modalRef.current?.focus();

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  const handlePlay = useCallback(() => {
    const path = galleryPlayPath || `/gallery/play/${gameId}`;
    navigate(path);
  }, [navigate, gameId, galleryPlayPath]);

  // Derived values
  const title = game?.vndbTitle || game?.extractedTitle || 'Unknown';
  const coverUrl = game?.coverPath
    ? `/api/v1/covers/${game.id}?t=${encodeURIComponent(game.updatedAt || '')}`
    : null;
  const gradient = generateGradient(title);
  const screenshots = (game?.screenshots || []).slice(0, 8);
  const tags = Array.isArray(game?.tags) ? game.tags : [];
  const nonSpoilerTags = tags.filter((t) => !t.spoiler || t.spoiler === 0);
  const spoilerTags = tags.filter((t) => t.spoiler && t.spoiler > 0);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[55] flex items-start sm:items-center justify-center bg-black/70 backdrop-blur-sm motion-safe:animate-fade-in"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={loading ? 'Loading game details' : `Details for ${title}`}
      >
        {/* Modal card */}
        <div
          ref={modalRef}
          tabIndex={-1}
          className="relative w-full max-w-4xl modal-max-h overflow-y-auto bg-[#181818] rounded-xl shadow-2xl border border-gray-700/30 motion-safe:animate-scale-in outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            className="sticky top-2 right-2 z-10 w-9 h-9 -mb-9 flex items-center justify-center rounded-full bg-[#181818]/80 hover:bg-gray-700 text-white text-lg transition-colors ml-auto"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center h-64">
              <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center h-64 text-center px-6">
              <p className="text-red-400 font-semibold mb-2">Failed to load</p>
              <p className="text-gray-400 text-sm">{error}</p>
            </div>
          )}

          {/* Content */}
          {game && !loading && !error && (
            <>
              {/* Hero section */}
              <div className="relative w-full h-48 sm:h-64 overflow-hidden rounded-t-xl">
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt=""
                    className="w-full h-full object-cover object-top"
                    aria-hidden="true"
                  />
                ) : (
                  <div className="w-full h-full" style={{ background: gradient }} />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#181818] via-[#181818]/30 to-transparent" />
              </div>

              <div className="px-6 pb-6 -mt-16 relative">
                {/* Title row */}
                <div className="flex items-start gap-3 mb-4">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-2xl sm:text-3xl font-bold text-white leading-tight">
                      {title}
                    </h2>
                    {game.vndbTitleOriginal && (
                      <p className="text-sm text-gray-400 italic mt-1">
                        {game.vndbTitleOriginal}
                      </p>
                    )}
                  </div>
                  {game.vndbRating != null && (
                    <div
                      className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-lg font-bold text-white ${getRatingColor(game.vndbRating)}`}
                    >
                      {formatRating(game.vndbRating)}
                    </div>
                  )}
                </div>

                {/* Info row */}
                <div className="flex flex-wrap gap-2 mb-5">
                  {game.developer && (
                    <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-800 text-gray-300">
                      🏢 {game.developer}
                    </span>
                  )}
                  {game.releaseDate && (
                    <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-800 text-gray-300">
                      📅 {formatDate(game.releaseDate)}
                    </span>
                  )}
                  {game.lengthMinutes != null && game.lengthMinutes > 0 && (
                    <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-800 text-gray-300">
                      ⏱ {formatLength(game.lengthMinutes)}
                    </span>
                  )}
                </div>

                {/* Action buttons — Play only + VNDB link */}
                <div className="flex flex-wrap gap-3 mb-6">
                  <button
                    onClick={handlePlay}
                    className="flex items-center gap-2 px-6 py-2.5 bg-white hover:bg-gray-200 text-black font-bold rounded-md text-sm transition-colors"
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Play
                  </button>
                  {game.vndbId && (
                    <a
                      href={`https://vndb.org/${game.vndbId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-md text-sm transition-colors"
                    >
                      VNDB
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                  )}
                </div>

                {/* Synopsis */}
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">
                    Synopsis
                  </h3>
                  {game.synopsis ? (
                    <div className="text-gray-300 text-sm leading-relaxed whitespace-pre-line">
                      {game.synopsis}
                    </div>
                  ) : (
                    <p className="text-gray-500 text-sm italic">No synopsis available.</p>
                  )}
                </div>

                {/* Tags (read-only) */}
                {(nonSpoilerTags.length > 0 || spoilerTags.length > 0) && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Tags
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {nonSpoilerTags.map((tag) => (
                        <button
                          key={tag.id || tag.name}
                          onClick={() => {
                            if (onTagClick) {
                              onClose();
                              onTagClick(tag.name);
                            }
                          }}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium bg-gray-800 text-gray-300 transition-colors ${
                            onTagClick
                              ? 'hover:bg-gray-700 hover:text-white cursor-pointer'
                              : 'cursor-default'
                          }`}
                        >
                          {tag.name}
                        </button>
                      ))}
                      {spoilerTags.length > 0 && !showSpoilerTags && (
                        <button
                          onClick={() => setShowSpoilerTags(true)}
                          className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-800 text-yellow-400 hover:bg-gray-700 transition-colors"
                        >
                          +{spoilerTags.length} spoiler tag{spoilerTags.length > 1 ? 's' : ''}
                        </button>
                      )}
                      {showSpoilerTags &&
                        spoilerTags.map((tag) => (
                          <button
                            key={tag.id || tag.name}
                            onClick={() => {
                              if (onTagClick) {
                                onClose();
                                onTagClick(tag.name);
                              }
                            }}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-900/40 text-yellow-300 border border-yellow-700/30 transition-colors ${
                              onTagClick
                                ? 'hover:bg-yellow-900/60 hover:text-yellow-200 cursor-pointer'
                                : 'cursor-default'
                            }`}
                          >
                            {tag.name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}

                {/* Screenshots */}
                {screenshots.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Screenshots
                    </h3>
                    <div className="flex gap-2 overflow-x-auto pb-2 gallery-row-scroll">
                      {screenshots.map((url, i) => (
                        <button
                          key={i}
                          onClick={() => setLightboxIndex(i)}
                          className="flex-shrink-0 rounded-lg overflow-hidden border-2 border-transparent hover:border-white/50 transition-colors focus:outline-none focus:border-white/50"
                        >
                          <img
                            src={url}
                            alt={`Screenshot ${i + 1}`}
                            className="h-24 sm:h-32 w-auto object-cover"
                            loading="lazy"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Minimal footer info */}
                {game.releaseDate && (
                  <div className="border-t border-gray-800 pt-4">
                    <p className="text-xs text-gray-500">
                      Released {formatDate(game.releaseDate)}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Screenshot lightbox */}
      {lightboxIndex != null && screenshots.length > 0 && (
        <ScreenshotLightbox
          screenshots={screenshots}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </>
  );
}
