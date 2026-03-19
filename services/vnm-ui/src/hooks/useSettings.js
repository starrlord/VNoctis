import { useState, useEffect, useCallback } from 'react';
import api from './useApi';

/**
 * Hook for loading and saving R2 settings.
 * Returns null config if R2 mode is not enabled on the server.
 */
export default function useSettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [testResult, setTestResult] = useState(null); // { success, message }

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/settings/r2');
      setConfig(data);
    } catch (err) {
      setError(err.message || 'Failed to load R2 settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const saveConfig = useCallback(async (values) => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/settings/r2', values);
      setConfig(values);
      return true;
    } catch (err) {
      setSaveError(err.message || 'Failed to save settings');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const testConnection = useCallback(async (values) => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post('/settings/r2/test', values);
      setTestResult({ success: true, message: result.message });
    } catch (err) {
      setTestResult({ success: false, message: err.message || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  }, []);

  return {
    config,
    loading,
    error,
    saving,
    saveError,
    testing,
    testResult,
    saveConfig,
    testConnection,
    refetch: fetchConfig,
  };
}
