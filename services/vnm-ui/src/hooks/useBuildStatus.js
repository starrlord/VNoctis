import { useState, useEffect, useRef, useCallback } from 'react';
import api from './useApi';

/**
 * Derives a UI build-state string from the raw game.buildStatus value.
 *
 * @param {string|null} status  The game's buildStatus field
 * @returns {'ready'|'not_built'|'queued'|'building'|'failed'|'stale'}
 */
function deriveBuildState(status) {
  switch (status) {
    case 'built':
      return 'ready';
    case 'stale':
      return 'stale';
    case 'queued':
      return 'queued';
    case 'building':
      return 'building';
    case 'failed':
      return 'failed';
    case 'not_built':
    default:
      return 'not_built';
  }
}

/**
 * Custom hook for managing build lifecycle for a game.
 *
 * Fetches the game detail on mount, derives the current build state,
 * and provides actions to trigger / cancel / retry builds.  Polls
 * the build-job status every 2 seconds while a build is in progress
 * and refetches the game record when the build completes.
 *
 * @param {string} gameId  32-char hex game identifier
 * @returns {{
 *   game: object|null,
 *   loading: boolean,
 *   buildState: string,
 *   jobId: string|null,
 *   triggerBuild: () => Promise<void>,
 *   cancelBuild: () => Promise<void>,
 *   retryBuild: () => Promise<void>,
 * }}
 */
export default function useBuildStatus(gameId) {
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [buildState, setBuildState] = useState('not_built');
  const [jobId, setJobId] = useState(null);

  const pollRef = useRef(null);

  // ------------------------------------------------------------------
  // Fetch the game detail from the library endpoint
  // ------------------------------------------------------------------
  const fetchGame = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get(`/library/${gameId}`);
      setGame(data);
      const state = deriveBuildState(data.buildStatus);
      setBuildState(state);

      // If the game references an active build job, track it
      if (data.buildJobId && (data.buildStatus === 'queued' || data.buildStatus === 'building')) {
        setJobId(data.buildJobId);
      } else {
        setJobId(null);
      }
    } catch {
      // If fetch fails, leave game null — Player will show an error
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    fetchGame();
  }, [fetchGame]);

  // ------------------------------------------------------------------
  // Poll build-job status while queued or building
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!jobId || (buildState !== 'queued' && buildState !== 'building')) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const job = await api.get(`/build/${jobId}`);

        if (job.status === 'building' && buildState !== 'building') {
          setBuildState('building');
        }

        if (job.status === 'done') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // Refetch game to pick up webBuildPath / builtAt
          await fetchGame();
        }

        if (job.status === 'failed') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setBuildState('failed');
        }

        if (job.status === 'cancelled') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setJobId(null);
          // Refetch game to get canonical state from the API
          await fetchGame();
        }
      } catch {
        // Transient polling error — will retry next interval
      }
    }, 2000);

    return () => {
      clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [jobId, buildState, fetchGame]);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  /** Queue a new web build for the game. */
  const triggerBuild = useCallback(async ({ compressAssets = true } = {}) => {
    try {
      setBuildState('queued');
      const result = await api.post(`/build/${gameId}`, { compressAssets });
      setJobId(result.jobId);
    } catch (err) {
      setBuildState('failed');
      // Surface error info on game object for display
      setGame((prev) =>
        prev ? { ...prev, buildError: err.message } : prev
      );
    }
  }, [gameId]);

  /** Cancel the currently running build. */
  const cancelBuild = useCallback(async () => {
    if (!jobId) return;
    try {
      await api.delete(`/build/${jobId}`);
      clearInterval(pollRef.current);
      pollRef.current = null;
      setJobId(null);
      setBuildState('not_built');
      // Refetch to get canonical state
      await fetchGame();
    } catch {
      // If cancel fails, keep current state — user can retry
    }
  }, [jobId, fetchGame]);

  /** Retry a failed build (alias for triggerBuild). */
  const retryBuild = useCallback(() => triggerBuild(), [triggerBuild]);

  /** Manually mark the game as playable (web build already exists on disk). */
  const markPlayable = useCallback(async () => {
    try {
      await api.post(`/library/${gameId}/mark-playable`);
      await fetchGame();
    } catch (err) {
      throw err;
    }
  }, [gameId, fetchGame]);

  return {
    game,
    loading,
    buildState,
    jobId,
    triggerBuild,
    cancelBuild,
    retryBuild,
    markPlayable,
  };
}
