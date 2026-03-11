import { useEffect, useCallback } from 'react';

/**
 * Fullscreen image lightbox for browsing screenshots.
 * Supports keyboard navigation (←/→/Escape), click-to-close backdrop,
 * and left/right arrow buttons.
 *
 * @param {{
 *   screenshots: string[],
 *   currentIndex: number,
 *   onClose: () => void,
 *   onNavigate: (index: number) => void,
 * }} props
 */
export default function ScreenshotLightbox({ screenshots, currentIndex, onClose, onNavigate }) {
  const total = screenshots.length;

  const goNext = useCallback(() => {
    onNavigate((currentIndex + 1) % total);
  }, [currentIndex, total, onNavigate]);

  const goPrev = useCallback(() => {
    onNavigate((currentIndex - 1 + total) % total);
  }, [currentIndex, total, onNavigate]);

  // Keyboard handling
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, goNext, goPrev]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 motion-safe:animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot viewer"
    >
      {/* Close button */}
      <button
        className="absolute top-4 right-4 z-10 w-10 h-10 flex items-center justify-center rounded-full bg-gray-800/80 hover:bg-gray-700 text-white text-xl transition-colors"
        onClick={onClose}
        aria-label="Close lightbox"
      >
        ✕
      </button>

      {/* Position indicator */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white/70 text-sm font-medium select-none">
        {currentIndex + 1} / {total}
      </div>

      {/* Previous button */}
      {total > 1 && (
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-gray-800/60 hover:bg-gray-700/80 text-white text-2xl transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          aria-label="Previous screenshot"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
      )}

      {/* Image */}
      <img
        src={screenshots[currentIndex]}
        alt={`Screenshot ${currentIndex + 1} of ${total}`}
        className="max-w-[90vw] max-h-[90vh] object-contain select-none"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />

      {/* Next button */}
      {total > 1 && (
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-gray-800/60 hover:bg-gray-700/80 text-white text-2xl transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          aria-label="Next screenshot"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      )}
    </div>
  );
}
