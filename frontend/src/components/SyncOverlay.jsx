import { useEffect, useState, useRef } from 'react';
import { subscribeAutoSync, isAutoSyncing } from '../lib/offlineSync';

const SHOW_DELAY_MS = 400; // only show the overlay if a sync takes longer than this

export default function SyncOverlay() {
  const [syncing, setSyncing] = useState(isAutoSyncing());
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => subscribeAutoSync(setSyncing), []);

  useEffect(() => {
    if (syncing) {
      // don't show immediately — wait to see if this is a real, longer sync
      timerRef.current = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    } else {
      clearTimeout(timerRef.current);
      setVisible(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [syncing]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-lg px-6 py-4 flex items-center gap-3">
        <div className="h-5 w-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-medium text-gray-700">Syncing offline sales…</span>
      </div>
    </div>
  );
}