import { useEffect, useState } from 'react';

/** Brief notices for startup, acknowledged save slots, and sync problems. */
export default function SaveSyncToast({ message, saveNoticeId, noticeId }) {
  const [visible, setVisible] = useState(true);
  const routine = message === 'Starting save sync…' || message === 'Syncing…' || message === 'Saves synced';
  const issue = routine ? null : message;

  useEffect(() => {
    setVisible(true);
    const timeout = setTimeout(() => setVisible(false), issue ? 8000 : 4000);
    return () => clearTimeout(timeout);
  }, [issue, saveNoticeId, noticeId]);

  if (!visible) return null;
  return (
    <div role="status" aria-label="Save synchronization" className="absolute bottom-3 left-3 right-3 w-fit max-w-[calc(100%-1.5rem)] z-10 flex items-center gap-2 bg-gray-900/90 text-white text-xs rounded px-3 py-1">
      <span>{!issue && saveNoticeId > 0 ? 'Save synced' : message === 'Saves synced' ? 'Saved files synced' : message}</span>
      <button
        type="button"
        aria-label="Dismiss save sync notice"
        onClick={() => setVisible(false)}
        className="shrink-0 min-h-[44px] min-w-[44px] text-lg rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
      >
        ×
      </button>
    </div>
  );
}
