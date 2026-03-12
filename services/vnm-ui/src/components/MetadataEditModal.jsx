import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../hooks/useApi';

/** Minimum characters before triggering autocomplete search */
const AUTOCOMPLETE_MIN_CHARS = 4;

/** Debounce delay in ms for autocomplete requests */
const AUTOCOMPLETE_DEBOUNCE_MS = 400;

/**
 * Modal form for manually editing game metadata.
 * Pre-populates fields from current game data and saves via PATCH /api/v1/library/:gameId.
 * Supports linking to both VNDB and Steam as metadata sources.
 *
 * @param {{ game: object, onClose: () => void, onSaved: () => void }} props
 */
export default function MetadataEditModal({ game, onClose, onSaved }) {
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);

  // Form state — pre-populated with current values
  const [form, setForm] = useState({
    vndbTitle: game.vndbTitle || '',
    vndbTitleOriginal: game.vndbTitleOriginal || '',
    developer: game.developer || '',
    releaseDate: game.releaseDate ? game.releaseDate.slice(0, 10) : '',
    synopsis: game.synopsis || '',
    vndbId: game.vndbId || '',
    steamAppId: game.steamAppId || '',
    lengthMinutes: game.lengthMinutes ?? '',
    coverUrl: '',
  });

  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const [linkError, setLinkError] = useState(null);
  const [linkSuccess, setLinkSuccess] = useState(false);

  // ── Source toggle (VNDB vs Steam) ─────────────────────
  const [searchSource, setSearchSource] = useState(
    game.steamAppId && !game.vndbId ? 'steam' : 'vndb'
  );

  // ── Autocomplete state ────────────────────────────────
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const debounceRef = useRef(null);
  const dropdownRef = useRef(null);
  const sourceInputRef = useRef(null);

  // Track which fields differ from original to highlight overrides
  const isOverridden = useCallback(
    (field) => {
      const original = game[field];
      const current = form[field];
      if (field === 'releaseDate') {
        const origDate = original ? original.slice(0, 10) : '';
        return current !== origDate;
      }
      if (field === 'lengthMinutes') {
        return String(current) !== String(original ?? '');
      }
      return current !== (original || '');
    },
    [form, game]
  );

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
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

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        sourceInputRef.current &&
        !sourceInputRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Reset autocomplete when switching sources
  useEffect(() => {
    setSearchResults([]);
    setShowDropdown(false);
    setHighlightIdx(-1);
    setSearchError(null);
    setLinkError(null);
    setLinkSuccess(false);
  }, [searchSource]);

  // Field change handler
  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setError(null);
  };

  // ── VNDB-specific helpers ─────────────────────────────

  /** Validate VNDB ID format */
  const isValidVndbId = (id) => {
    if (!id) return true;
    return /^v\d+$/.test(id);
  };

  // ── Steam-specific helpers ────────────────────────────

  /** Validate Steam App ID format (numeric) */
  const isValidSteamAppId = (id) => {
    if (!id) return true;
    return /^\d+$/.test(id);
  };

  // ── Unified source input handler ──────────────────────

  const handleSourceIdChange = (e) => {
    const value = e.target.value;

    if (searchSource === 'vndb') {
      setForm((prev) => ({ ...prev, vndbId: value }));
    } else {
      setForm((prev) => ({ ...prev, steamAppId: value }));
    }

    setError(null);
    setLinkError(null);
    setLinkSuccess(false);

    // Clear any pending debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchSource === 'vndb') {
      // If the value looks like a VNDB ID (v + digits) or is too short, hide dropdown
      if (/^v\d*$/.test(value) || value.length < AUTOCOMPLETE_MIN_CHARS) {
        setShowDropdown(false);
        setSearchResults([]);
        setHighlightIdx(-1);
        return;
      }

      // Debounced VNDB search
      debounceRef.current = setTimeout(async () => {
        setSearching(true);
        setSearchError(null);
        try {
          const results = await api.get(
            `/metadata/vndb/search?q=${encodeURIComponent(value)}`
          );
          setSearchResults(results);
          setShowDropdown(results.length > 0);
          setHighlightIdx(-1);
        } catch {
          setSearchResults([]);
          setShowDropdown(false);
          setSearchError('Error searching VNDB. Please try again.');
        } finally {
          setSearching(false);
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);
    } else {
      // Steam: if value looks like an appid (all digits) or too short, hide dropdown
      if (/^\d*$/.test(value) || value.length < AUTOCOMPLETE_MIN_CHARS) {
        setShowDropdown(false);
        setSearchResults([]);
        setHighlightIdx(-1);
        return;
      }

      // Debounced Steam search
      debounceRef.current = setTimeout(async () => {
        setSearching(true);
        setSearchError(null);
        try {
          const results = await api.get(
            `/metadata/steam/search?q=${encodeURIComponent(value)}`
          );
          setSearchResults(results);
          setShowDropdown(results.length > 0);
          setHighlightIdx(-1);
        } catch {
          setSearchResults([]);
          setShowDropdown(false);
          setSearchError('Error retrieving Steam app list. Please try again later.');
        } finally {
          setSearching(false);
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);
    }
  };

  // Select from autocomplete dropdown
  const handleSelectResult = (result) => {
    if (searchSource === 'vndb') {
      setForm((prev) => ({ ...prev, vndbId: result.id }));
    } else {
      setForm((prev) => ({ ...prev, steamAppId: String(result.appid) }));
    }
    setShowDropdown(false);
    setSearchResults([]);
    setHighlightIdx(-1);
    setLinkError(null);
    setLinkSuccess(false);
  };

  // Keyboard navigation for autocomplete dropdown
  const handleSourceKeyDown = (e) => {
    if (!showDropdown || searchResults.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) =>
        prev < searchResults.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) =>
        prev > 0 ? prev - 1 : searchResults.length - 1
      );
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      handleSelectResult(searchResults[highlightIdx]);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // Don't close the modal, just the dropdown
      setShowDropdown(false);
      setHighlightIdx(-1);
    }
  };

  // ── Link handler (VNDB or Steam) ──────────────────────

  const handleLink = async () => {
    if (searchSource === 'vndb') {
      if (!form.vndbId) return;
      if (!isValidVndbId(form.vndbId)) {
        setLinkError('VNDB ID must be in format "v" + digits (e.g., v12345)');
        return;
      }
    } else {
      if (!form.steamAppId) return;
      if (!isValidSteamAppId(form.steamAppId)) {
        setLinkError('Steam App ID must be numeric (e.g., 1172470)');
        return;
      }
    }

    setLinking(true);
    setLinkError(null);
    setLinkSuccess(false);

    try {
      const refreshBody =
        searchSource === 'vndb'
          ? { vndbId: form.vndbId }
          : { steamAppId: form.steamAppId };

      await api.post(`/metadata/${game.id}/refresh`, refreshBody);

      // Re-fetch game data to get updated fields
      const updated = await api.get(`/library/${game.id}`);

      // Update form with refreshed data
      setForm({
        vndbTitle: updated.vndbTitle || '',
        vndbTitleOriginal: updated.vndbTitleOriginal || '',
        developer: updated.developer || '',
        releaseDate: updated.releaseDate ? updated.releaseDate.slice(0, 10) : '',
        synopsis: updated.synopsis || '',
        vndbId: updated.vndbId || form.vndbId,
        steamAppId: updated.steamAppId || form.steamAppId,
        lengthMinutes: updated.lengthMinutes ?? '',
        coverUrl: '',
      });
      setLinkSuccess(true);
    } catch (err) {
      setLinkError(
        err.message ||
          `Failed to link ${searchSource === 'vndb' ? 'VNDB' : 'Steam'} data`
      );
    } finally {
      setLinking(false);
    }
  };

  // Save — calls PATCH /api/v1/library/:gameId
  const handleSave = async () => {
    // Validate IDs if provided
    if (form.vndbId && !isValidVndbId(form.vndbId)) {
      setError('VNDB ID must be in format "v" + digits (e.g., v12345)');
      return;
    }
    if (form.steamAppId && !isValidSteamAppId(form.steamAppId)) {
      setError('Steam App ID must be numeric (e.g., 1172470)');
      return;
    }

    setSaving(true);
    setError(null);

    // Build payload with only changed fields
    const payload = {};
    if (form.vndbTitle !== (game.vndbTitle || '')) payload.vndbTitle = form.vndbTitle || null;
    if (form.vndbTitleOriginal !== (game.vndbTitleOriginal || ''))
      payload.vndbTitleOriginal = form.vndbTitleOriginal || null;
    if (form.developer !== (game.developer || '')) payload.developer = form.developer || null;
    if (form.synopsis !== (game.synopsis || '')) payload.synopsis = form.synopsis || null;
    if (form.vndbId !== (game.vndbId || '')) payload.vndbId = form.vndbId || null;
    if (form.steamAppId !== (game.steamAppId || '')) payload.steamAppId = form.steamAppId || null;

    const origDate = game.releaseDate ? game.releaseDate.slice(0, 10) : '';
    if (form.releaseDate !== origDate) {
      payload.releaseDate = form.releaseDate ? new Date(form.releaseDate).toISOString() : null;
    }

    const origLen = game.lengthMinutes ?? '';
    if (String(form.lengthMinutes) !== String(origLen)) {
      payload.lengthMinutes = form.lengthMinutes ? parseInt(form.lengthMinutes, 10) : null;
    }

    if (form.coverUrl) {
      payload.coverPath = form.coverUrl;
    }

    try {
      await api.patch(`/library/${game.id}`, payload);
      onSaved();
    } catch (err) {
      setError(err.message || 'Failed to save metadata');
    } finally {
      setSaving(false);
    }
  };

  const labelClass = (field) =>
    `block text-sm mb-1 transition-colors ${
      isOverridden(field)
        ? 'font-bold text-blue-400 dark:text-blue-400'
        : 'font-medium text-gray-700 dark:text-gray-400'
    }`;

  const inputClass =
    'w-full px-3 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors';

  // Current source input value and placeholder
  const sourceInputValue =
    searchSource === 'vndb' ? form.vndbId : form.steamAppId;
  const sourceInputPlaceholder =
    searchSource === 'vndb'
      ? 'v12345 or type a title to search…'
      : '1172470 or type a title to search…';
  const sourceLinkDisabled =
    linking ||
    (searchSource === 'vndb' ? !form.vndbId : !form.steamAppId);
  const sourceLinkLabel =
    searchSource === 'vndb'
      ? linking
        ? '🔄 Linking…'
        : '🔗 Link to VNDB'
      : linking
        ? '🔄 Linking…'
        : '🔗 Link to Steam';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Edit Metadata"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">✏️ Edit Metadata</h2>
          <button
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-200 dark:bg-gray-800/80 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-600 dark:text-white text-lg transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className={labelClass('vndbTitle')}>Title</label>
            <input
              type="text"
              value={form.vndbTitle}
              onChange={handleChange('vndbTitle')}
              placeholder="Game title"
              className={inputClass}
            />
          </div>

          {/* Original Title */}
          <div>
            <label className={labelClass('vndbTitleOriginal')}>Original Title</label>
            <input
              type="text"
              value={form.vndbTitleOriginal}
              onChange={handleChange('vndbTitleOriginal')}
              placeholder="原題 (original language title)"
              className={inputClass}
            />
          </div>

          {/* Developer + Release Date row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass('developer')}>Developer</label>
              <input
                type="text"
                value={form.developer}
                onChange={handleChange('developer')}
                placeholder="Studio / developer name"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass('releaseDate')}>Release Date</label>
              <input
                type="date"
                value={form.releaseDate}
                onChange={handleChange('releaseDate')}
                className={inputClass}
              />
            </div>
          </div>

          {/* Synopsis */}
          <div>
            <label className={labelClass('synopsis')}>Synopsis</label>
            <textarea
              rows={4}
              value={form.synopsis}
              onChange={handleChange('synopsis')}
              placeholder="Game description / synopsis"
              className={inputClass + ' resize-y'}
            />
          </div>

          {/* Metadata source toggle + ID input + Link button + autocomplete */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-400 mb-2">
              Metadata Source
            </label>

            {/* Source toggle tabs */}
            <div className="flex gap-1 mb-2">
              <button
                type="button"
                onClick={() => setSearchSource('vndb')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchSource === 'vndb'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                VNDB
              </button>
              <button
                type="button"
                onClick={() => setSearchSource('steam')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchSource === 'steam'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                Steam
              </button>
            </div>

            {/* Source ID input + link button */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  ref={sourceInputRef}
                  type="text"
                  value={sourceInputValue}
                  onChange={handleSourceIdChange}
                  onKeyDown={handleSourceKeyDown}
                  placeholder={sourceInputPlaceholder}
                  className={inputClass}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={showDropdown}
                  aria-autocomplete="list"
                  aria-controls="source-autocomplete-list"
                />

                {/* Searching spinner */}
                {searching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <svg
                      className="animate-spin h-4 w-4 text-gray-400"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                  </div>
                )}

                {/* Autocomplete dropdown */}
                {showDropdown && searchResults.length > 0 && (
                  <ul
                    ref={dropdownRef}
                    id="source-autocomplete-list"
                    role="listbox"
                    className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg"
                  >
                    {searchSource === 'vndb'
                      ? searchResults.map((vn, idx) => (
                          <li
                            key={vn.id}
                            role="option"
                            aria-selected={idx === highlightIdx}
                            className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
                              idx === highlightIdx
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-900 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                            }`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleSelectResult(vn);
                            }}
                            onMouseEnter={() => setHighlightIdx(idx)}
                          >
                            <div className="font-medium">
                              {vn.title}
                              {vn.alttitle && (
                                <span className={`ml-2 text-xs ${idx === highlightIdx ? 'text-blue-200' : 'text-gray-400'}`}>
                                  {vn.alttitle}
                                </span>
                              )}
                            </div>
                            <div className={`text-xs mt-0.5 ${idx === highlightIdx ? 'text-blue-200' : 'text-gray-500 dark:text-gray-400'}`}>
                              <span className="font-mono">{vn.id}</span>
                              {vn.developer && <span> · {vn.developer}</span>}
                              {vn.released && <span> · {vn.released}</span>}
                            </div>
                          </li>
                        ))
                      : searchResults.map((app, idx) => (
                          <li
                            key={app.appid}
                            role="option"
                            aria-selected={idx === highlightIdx}
                            className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
                              idx === highlightIdx
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-900 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                            }`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleSelectResult(app);
                            }}
                            onMouseEnter={() => setHighlightIdx(idx)}
                          >
                            <div className="font-medium">{app.name}</div>
                            <div className={`text-xs mt-0.5 ${idx === highlightIdx ? 'text-blue-200' : 'text-gray-500 dark:text-gray-400'}`}>
                              <span className="font-mono">App ID: {app.appid}</span>
                              {app.score < 1 && (
                                <span> · Match: {Math.round(app.score * 100)}%</span>
                              )}
                            </div>
                          </li>
                        ))}
                  </ul>
                )}
              </div>
              <button
                onClick={handleLink}
                disabled={sourceLinkDisabled}
                className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  searchSource === 'vndb'
                    ? 'bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:text-indigo-400'
                    : 'bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-blue-400'
                }`}
              >
                {sourceLinkLabel}
              </button>
            </div>
            {linkError && (
              <p className="text-xs text-red-400 mt-1">{linkError}</p>
            )}
            {linkSuccess && (
              <p className="text-xs text-green-400 mt-1">
                ✅ {searchSource === 'vndb' ? 'VNDB' : 'Steam'} data imported successfully
              </p>
            )}
            {searchError && (
              <p className="text-xs text-red-400 mt-1">⚠️ {searchError}</p>
            )}
          </div>

          {/* Length in minutes */}
          <div>
            <label className={labelClass('lengthMinutes')}>Length (minutes)</label>
            <input
              type="number"
              min="0"
              value={form.lengthMinutes}
              onChange={handleChange('lengthMinutes')}
              placeholder="Estimated play time in minutes"
              className={inputClass}
            />
          </div>

          {/* Cover Image */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-400 mb-1">
              Cover Image
            </label>

            {/* Steam cover picker — shown when steamAppId is populated */}
            {form.steamAppId && /^\d+$/.test(form.steamAppId) && (
              <div className="mb-2">
                <p className="text-xs text-gray-500 mb-2">
                  Choose a Steam cover image, or keep the current one:
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Portrait', file: 'library_600x900.jpg' },
                    { label: 'Capsule', file: 'hero_capsule.jpg' },
                    { label: 'Banner', file: 'header.jpg' },
                    { label: 'Wide', file: 'capsule_616x353.jpg' },
                  ].map(({ label, file }) => {
                    const url = `https://cdn.akamai.steamstatic.com/steam/apps/${form.steamAppId}/${file}`;
                    const isSelected = form.coverUrl === url;
                    return (
                      <button
                        key={file}
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            coverUrl: isSelected ? '' : url,
                          }))
                        }
                        className={`relative rounded-md overflow-hidden border-2 transition-all ${
                          isSelected
                            ? 'border-blue-500 ring-2 ring-blue-500/30'
                            : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                        }`}
                      >
                        <div className="aspect-[2/3] bg-gray-800">
                          <img
                            src={url}
                            alt={label}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.target.style.display = 'none';
                            }}
                          />
                        </div>
                        <div className={`text-center py-1 text-xs font-medium ${
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }`}>
                          {label}
                        </div>
                        {isSelected && (
                          <div className="absolute top-1 right-1 w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center">
                            <span className="text-white text-xs">✓</span>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Click to select · Click again to deselect (keeps current cover)
                </p>
              </div>
            )}

            {/* Manual URL input (always available) */}
            <input
              type="text"
              value={form.coverUrl}
              onChange={handleChange('coverUrl')}
              placeholder="https://example.com/cover.jpg"
              className={inputClass}
            />
            <p className="text-xs text-gray-500 mt-1">
              Or paste a direct image URL
            </p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="px-6 pb-2">
            <p className="text-sm text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2">
              ⚠️ {error}
            </p>
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-800">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-blue-400 text-white font-semibold rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            {saving && (
              <svg
                className="animate-spin h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
