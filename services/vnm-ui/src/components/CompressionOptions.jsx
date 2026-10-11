import { useEffect, useState } from 'react';
import api from '../hooks/useApi';

export default function CompressionOptions({ gameId, onChange, dark = false }) {
  const [info, setInfo] = useState(null);
  const [checked, setChecked] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setInfo(null);
    onChange({ compressAssets: true, forceRecompress: false, ready: false });
    api.get(`/library/${gameId}/compression`, { signal: controller.signal }).catch(() => ({ compressed: null, reusableImages: 0 })).then(result => {
      if (!active) return;
      setInfo(result); setChecked(!result.reusableImages);
      onChange({ compressAssets: true, forceRecompress: false, ready: true });
    });
    return () => { active = false; controller.abort(); };
  }, [gameId, onChange]);
  const reusable = info?.reusableImages > 0;
  return <div className="mb-5 text-left">
    <p className={`text-xs mb-2 ${dark ? 'text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>
      {!info ? 'Checking asset compression…' : reusable ? `${info.reusableImages.toLocaleString()} previously optimized images available.` : info.compressed === false ? 'Published assets are not optimized.' : info.compressed ? 'Previous optimization recorded; no reusable image files available.' : 'No reusable compression record. Older builds need one tracked optimization build.'}
    </p>
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <input type="checkbox" disabled={!info} checked={checked} onChange={event => {
        const value = event.target.checked; setChecked(value);
        onChange({ compressAssets: reusable || value, forceRecompress: reusable && value, ready: true });
      }} className="mt-0.5 w-4 h-4 rounded text-blue-600 border-gray-400 dark:border-gray-600" />
      <div>
        <span className={`text-sm font-medium ${dark ? 'text-white' : 'text-gray-900 dark:text-white'}`}>{reusable ? 'Force recompress assets' : 'Compress assets'}</span>
        <p className={`text-xs mt-0.5 ${dark ? 'text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>{reusable ? 'Leave unchecked to reuse unchanged images from the published build. New or changed images are optimized as needed. Checking starts again from original files.' : 'Optimize images for a smaller web build. Temporary processing files are removed afterward.'}</p>
      </div>
    </label>
  </div>;
}
