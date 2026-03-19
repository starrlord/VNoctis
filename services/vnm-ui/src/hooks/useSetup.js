import { useState } from 'react';
import api from './useApi';

export default function useSetup() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const runSetup = async () => {
    setRunning(true);
    setResult(null);
    try {
      const data = await api.post('/settings/r2/setup');
      setResult(data);
    } catch (err) {
      setResult({ domainStatus: 'failed', ruleStatus: 'failed', errors: [err.message] });
    } finally {
      setRunning(false);
    }
  };

  return { runSetup, running, result };
}
