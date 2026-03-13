import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../hooks/useApi';
import ScreenshotLightbox from './ScreenshotLightbox';
import MetadataEditModal from './MetadataEditModal';
import {
  formatRating,
  formatDate,
  formatLength,
  getRatingColor,
  getBuildStatusBadge,
  getMetadataSourceBadge,
  generateGradient,
} from '../lib/utils';

/**
 * Full-screen modal overlay showing complete game details.
 * Fetches fresh game data on open and provides action buttons.
 *
 * @param {{ gameId: string, onClose: () => void, onDeleted?: () => void, onHide?: (game: object) => void, onTagClick?: (tagName: string) => void }} props
 */
export default function GameDetailModal({ gameId, onClose, onDeleted, onHide, onTagClick }) {
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showSpoilerTags, setShowSpoilerTags] = useState(false);
  const [showTagInput, setShowTagInput] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [buildTriggered, setBuildTriggered] = useState(false);
  const [refreshTriggered, setRefreshTriggered] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showBuildOptions, setShowBuildOptions] = useState(false);
  const [compressAssets, setCompressAssets] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);
  const tagInputRef = useRef(null);

  // Fetch fresh game detail
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

  // Prevent body scroll while modal is open.
  // iOS Safari ignores overflow:hidden on body — we must also set
  // position:fixed and restore scroll position on cleanup.
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
      // Focus trap
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

  // Action handlers
  const handlePlay = useCallback(() => {
    navigate(`/play/${gameId}`);
  }, [navigate, gameId]);

  const handleBuild = useCallback(() => {
    if (buildTriggered) return;
    setShowBuildOptions(true);
  }, [buildTriggered]);

  const handleConfirmBuild = useCallback(async () => {
    setShowBuildOptions(false);
    if (buildTriggered) return;
    setBuildTriggered(true);
    try {
      await api.post(`/build/${gameId}`, { compressAssets });
    } catch {
      // Best-effort — toast would be nice but out of scope
    }
  }, [gameId, buildTriggered, compressAssets]);

  const handleRefreshMetadata = useCallback(async () => {
    if (refreshTriggered) return;
    setRefreshTriggered(true);
    try {
      await api.post(`/metadata/${gameId}/refresh`);
      // Re-fetch game detail after refresh
      const data = await api.get(`/library/${gameId}`);
      setGame(data);
    } catch {
      // Best-effort
    } finally {
      setRefreshTriggered(false);
    }
  }, [gameId, refreshTriggered]);

  // Delete handler
  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.delete(`/library/${gameId}`);
      onClose();
      onDeleted?.();
    } catch (err) {
      alert(`Delete failed: ${err?.message || 'An unknown error occurred.'}`);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [gameId, deleting, onClose, onDeleted]);

  // Refetch game data (used after edit modal saves)
  const refetchGame = useCallback(async () => {
    try {
      const data = await api.get(`/library/${gameId}`);
      setGame(data);
    } catch {
      // Best-effort
    }
  }, [gameId]);

  // Remove a tag from the game
  const handleRemoveTag = useCallback(async (tagToRemove) => {
    if (!game) return;
    const allTags = game.tags || [];
    const updatedTags = allTags.filter(
      (t) => !(t.name === tagToRemove.name && t.id === tagToRemove.id)
    );
    // Optimistic update
    setGame((prev) => prev ? { ...prev, tags: updatedTags } : prev);
    try {
      await api.patch(`/library/${gameId}`, { tags: updatedTags });
    } catch {
      // Revert on failure
      setGame((prev) => prev ? { ...prev, tags: allTags } : prev);
    }
  }, [game, gameId]);

  // Add a new user-defined tag
  const handleAddTag = useCallback(async (name) => {
    const trimmed = name.trim();
    if (!trimmed || !game) return;
    const allTags = game.tags || [];
    // Prevent duplicates (case-insensitive)
    if (allTags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    const newTag = { name: trimmed, spoiler: 0 };
    const updatedTags = [...allTags, newTag];
    // Optimistic update
    setGame((prev) => prev ? { ...prev, tags: updatedTags } : prev);
    setNewTagName('');
    try {
      await api.patch(`/library/${gameId}`, { tags: updatedTags });
    } catch {
      // Revert on failure
      setGame((prev) => prev ? { ...prev, tags: allTags } : prev);
    }
  }, [game, gameId]);

  // Derived values
  const buildLogStatuses = ['built', 'stale', 'failed'];
  const isBuildFailed = game?.buildStatus === 'failed';

  const title = game?.vndbTitle || game?.extractedTitle || 'Unknown';
  const coverUrl = game?.coverPath
    ? `/api/v1/covers/${game.id}?t=${encodeURIComponent(game.updatedAt || '')}`
    : null;
  const gradient = generateGradient(title);
  const buildBadge = game ? getBuildStatusBadge(game.buildStatus) : null;
  const metaBadge = game ? getMetadataSourceBadge(game.metadataSource) : null;
  const isBuilt = game?.buildStatus === 'built';
  const screenshots = (game?.screenshots || []).slice(0, 8);
  const nonSpoilerTags = (game?.tags || []).filter((t) => !t.spoiler || t.spoiler === 0);
  const spoilerTags = (game?.tags || []).filter((t) => t.spoiler && t.spoiler > 0);

  return (
    <>
      {/* Backdrop — z-[55] to layer above the Navbar (z-50) on all platforms,
          especially iOS where same-z fixed elements can stack unpredictably. */}
      <div
        className="fixed inset-0 z-[55] flex items-start sm:items-center justify-center bg-black/60 dark:bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={loading ? 'Loading game details' : `Details for ${title}`}
      >
        {/* Modal card — always scrolls internally with a max-h constraint.
            Uses 90vh as a baseline (widely supported) then overrides with
            90dvh where available to account for iOS Safari's dynamic toolbar.
            On phones items-start keeps the top visible; on wider viewports
            items-center vertically centres the card. */}
        <div
          ref={modalRef}
          tabIndex={-1}
          className="relative w-full max-w-4xl modal-max-h overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button — sticky so it stays visible while scrolling long
              content; -mb-9 pulls the hero section up beneath it so there's
              no visual gap above the hero image. */}
          <button
            className="sticky top-2 right-2 z-10 w-9 h-9 -mb-9 flex items-center justify-center rounded-full bg-gray-200/80 dark:bg-gray-800/80 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-700 dark:text-white text-lg transition-colors ml-auto"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center h-64">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
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
              {/* 1. Hero section */}
              <div className="relative w-full h-48 sm:h-56 overflow-hidden rounded-t-xl">
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
                <div className="absolute inset-0 bg-gradient-to-t from-white dark:from-gray-900 via-white/40 dark:via-gray-900/40 to-transparent" />
              </div>

              <div className="px-6 pb-6 -mt-12 relative">
                {/* 2. Title row */}
                <div className="flex items-start gap-3 mb-4">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white leading-tight">
                      {title}
                    </h2>
                    {game.vndbTitleOriginal && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 italic mt-1">
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

                {/* 3. Info row */}
                <div className="flex flex-wrap gap-2 mb-5">
                  {game.developer && (
                    <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                      🏢 {game.developer}
                    </span>
                  )}
                  {game.releaseDate && (
                    <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                      📅 {formatDate(game.releaseDate)}
                    </span>
                  )}
                  {game.lengthMinutes != null && game.lengthMinutes > 0 && (
                    <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                      ⏱ {formatLength(game.lengthMinutes)}
                    </span>
                  )}
                  {buildBadge && (
                    buildLogStatuses.includes(game?.buildStatus) && game?.buildJobId ? (
                      <a
                        href={`/build-log/${game.buildJobId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`px-3 py-1 rounded-full text-xs font-medium cursor-pointer hover:ring-2 ${isBuildFailed ? 'hover:ring-red-400/50' : 'hover:ring-gray-400/50'} transition-all ${buildBadge.colorClass} inline-flex items-center gap-1`}
                        title="Open build log in new tab"
                      >
                        {buildBadge.label}
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                      </a>
                    ) : (
                      <span className={`px-3 py-1 rounded-full text-xs font-medium ${buildBadge.colorClass}`}>
                        {buildBadge.label}
                      </span>
                    )
                  )}
                  {metaBadge && (
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${metaBadge.colorClass}`}>
                      {metaBadge.label}
                    </span>
                  )}
                </div>

                {/* 4. Action buttons */}
                <div className="flex flex-wrap gap-3 mb-6">
                  <button
                    onClick={handlePlay}
                    className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors duration-200 text-sm"
                  >
                    {isBuilt ? '▶ Play' : '▶ Build & Play'}
                  </button>
                  {buildTriggered ? (
                    <a
                      href={`/build-log/${game?.buildJobId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white font-medium rounded-lg transition-colors duration-200 text-sm inline-flex items-center gap-1.5"
                    >
                      🔨 View Build Log
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                  ) : (
                    <button
                      onClick={handleBuild}
                      className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white font-medium rounded-lg transition-colors duration-200 text-sm"
                    >
                      {isBuilt ? '🔨 Rebuild' : '🔨 Build'}
                    </button>
                  )}
                  <button
                    onClick={handleRefreshMetadata}
                    disabled={refreshTriggered}
                    className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-400 dark:disabled:text-gray-500 text-gray-700 dark:text-white font-medium rounded-lg transition-colors duration-200 text-sm"
                  >
                    {refreshTriggered ? '🔄 Refreshing…' : '🔄 Refresh Metadata'}
                  </button>
                  <button
                    onClick={() => setShowEditModal(true)}
                    className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white font-medium rounded-lg transition-colors duration-200 text-sm"
                  >
                    ✏️ Edit
                  </button>
                  {/* Hide/Unhide toggle */}
                  {onHide && (
                    <button
                      onClick={() => {
                        setGame((prev) => prev ? { ...prev, hidden: !prev.hidden } : prev);
                        onHide(game);
                      }}
                      className={`px-4 py-2.5 font-medium rounded-lg transition-colors duration-200 text-sm ${
                        game.hidden
                          ? 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 ring-1 ring-orange-500/30'
                          : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white'
                      }`}
                    >
                      {game.hidden ? '👁 Unhide' : '👁‍🗨 Hide'}
                    </button>
                  )}
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="px-4 py-2.5 bg-red-600/80 hover:bg-red-500 text-white font-medium rounded-lg transition-colors duration-200 text-sm"
                  >
                    🗑️ Delete
                  </button>
                  {game.vndbId && (
                    <a
                      href={`https://vndb.org/${game.vndbId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white font-medium rounded-lg transition-colors duration-200 text-sm inline-flex items-center gap-1.5"
                    >
                      VNDB
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                  )}
                </div>


                {/* 5. Synopsis */}
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    Synopsis
                  </h3>
                  {game.synopsis ? (
                    <div className="text-gray-700 dark:text-gray-300 text-sm leading-relaxed whitespace-pre-line">
                      {game.synopsis}
                    </div>
                  ) : (
                    <p className="text-gray-400 dark:text-gray-500 text-sm italic">No synopsis available.</p>
                  )}
                </div>

                {/* 6. Tags */}
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    Tags
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {nonSpoilerTags.map((tag) => (
                      <span
                        key={tag.id || tag.name}
                        className="group/tag inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
                      >
                        <button
                          onClick={() => onTagClick?.(tag.name)}
                          className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors cursor-pointer"
                          title={`Filter library by "${tag.name}"`}
                        >
                          {tag.name}
                        </button>
                        <button
                          onClick={() => handleRemoveTag(tag)}
                          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 opacity-0 group-hover/tag:opacity-100 transition-all"
                          aria-label={`Remove tag ${tag.name}`}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {spoilerTags.length > 0 && !showSpoilerTags && (
                      <button
                        onClick={() => setShowSpoilerTags(true)}
                        className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-yellow-600 dark:text-yellow-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      >
                        +{spoilerTags.length} spoiler tag{spoilerTags.length > 1 ? 's' : ''}
                      </button>
                    )}
                    {showSpoilerTags &&
                      spoilerTags.map((tag) => (
                        <span
                          key={tag.id || tag.name}
                          className="group/tag inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-900/40 text-yellow-300 border border-yellow-700/30 transition-colors hover:bg-yellow-900/60"
                        >
                          <button
                            onClick={() => onTagClick?.(tag.name)}
                            className="hover:text-yellow-100 hover:underline transition-colors cursor-pointer"
                            title={`Filter library by "${tag.name}"`}
                          >
                            {tag.name}
                          </button>
                          <button
                            onClick={() => handleRemoveTag(tag)}
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-yellow-400/60 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover/tag:opacity-100 transition-all"
                            aria-label={`Remove tag ${tag.name}`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}

                    {/* Add tag input or button */}
                    {showTagInput ? (
                      <form
                        className="inline-flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleAddTag(newTagName);
                        }}
                      >
                        <input
                          ref={tagInputRef}
                          type="text"
                          value={newTagName}
                          onChange={(e) => setNewTagName(e.target.value)}
                          onBlur={() => {
                            if (!newTagName.trim()) {
                              setShowTagInput(false);
                              setNewTagName('');
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setShowTagInput(false);
                              setNewTagName('');
                            }
                          }}
                          placeholder="Tag name…"
                          className="w-28 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 placeholder-gray-400 dark:placeholder-gray-500"
                          autoFocus
                        />
                        <button
                          type="submit"
                          disabled={!newTagName.trim()}
                          className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500 transition-colors"
                          aria-label="Confirm add tag"
                        >
                          ✓
                        </button>
                      </form>
                    ) : (
                      <button
                        onClick={() => setShowTagInput(true)}
                        className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 border border-dashed border-blue-300 dark:border-blue-700 transition-colors"
                        aria-label="Add a new tag"
                      >
                        + Add Tag
                      </button>
                    )}
                  </div>
                </div>

                {/* 7. Screenshots */}
                {screenshots.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Screenshots
                    </h3>
                    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
                      {screenshots.map((url, i) => (
                        <button
                          key={i}
                          onClick={() => setLightboxIndex(i)}
                          className="flex-shrink-0 rounded-lg overflow-hidden border-2 border-transparent hover:border-blue-500 transition-colors focus:outline-none focus:border-blue-500"
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

                {/* 8. Game info footer */}
                <div className="border-t border-gray-200 dark:border-gray-800 pt-4 space-y-1">
                  {game.directoryPath && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                      <span className="text-gray-500 dark:text-gray-600">Directory:</span> {game.directoryPath}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    <span className="text-gray-500 dark:text-gray-600">Game ID:</span> {game.id}
                  </p>
                  {game.createdAt && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      <span className="text-gray-500 dark:text-gray-600">Added:</span> {formatDate(game.createdAt)}
                    </p>
                  )}
                  {game.builtAt && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      <span className="text-gray-500 dark:text-gray-600">Last build:</span> {formatDate(game.builtAt)}
                    </p>
                  )}
                </div>
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

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md mx-4 shadow-2xl border border-gray-200 dark:border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
              Delete Game
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
              Are you sure you want to permanently delete <strong>{title}</strong>?
            </p>
            <p className="text-xs text-red-500 dark:text-red-400 mb-5">
              This will remove the game folder, all web-build files, and cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-red-800 disabled:text-red-300 text-white rounded-lg text-sm font-semibold transition-colors"
              >
                {deleting ? 'Deleting…' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Build options dialog */}
      {showBuildOptions && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowBuildOptions(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md mx-4 shadow-2xl border border-gray-200 dark:border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
              Build Options
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              Choose how to build <strong>{title}</strong> for the web.
            </p>
            <label className="flex items-start gap-3 mb-5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={compressAssets}
                onChange={(e) => setCompressAssets(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
              />
              <div>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Compress assets
                </span>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Extracts .rpa archives and compresses images for a smaller web build. Takes longer but produces a faster-loading game.
                </p>
              </div>
            </label>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowBuildOptions(false)}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBuild}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors"
              >
                🔨 Start Build
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Metadata edit modal */}
      {showEditModal && game && (
        <MetadataEditModal
          game={game}
          onClose={() => setShowEditModal(false)}
          onSaved={() => {
            setShowEditModal(false);
            refetchGame();
          }}
        />
      )}
    </>
  );
}
