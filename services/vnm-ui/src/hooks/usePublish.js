import { useState, useCallback } from 'react';
import api from './useApi';

/**
 * Hook for publishing and unpublishing games to Cloudflare R2.
 *
 * @returns {{
 *   publishGame: (gameId: string) => Promise<{jobId: string}>,
 *   unpublishGame: (gameId: string) => Promise<void>,
 *   regenGallery: () => Promise<void>,
 *   activeJob: {jobId: string, gameId: string} | null,
 *   clearJob: () => void,
 * }}
 */
export default function usePublish() {
  const [activeJob, setActiveJob] = useState(null); // { jobId, gameId }

  const publishGame = useCallback(async (gameId) => {
    const { jobId } = await api.post(`/publish/${gameId}`);
    setActiveJob({ jobId, gameId });
    return { jobId };
  }, []);

  const unpublishGame = useCallback(async (gameId) => {
    await api.delete(`/publish/${gameId}`);
  }, []);

  const regenGallery = useCallback(async () => {
    await api.post('/publish/gallery');
  }, []);

  const clearJob = useCallback(() => setActiveJob(null), []);

  return { publishGame, unpublishGame, regenGallery, activeJob, clearJob };
}
