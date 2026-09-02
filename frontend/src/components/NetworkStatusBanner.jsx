import { useEffect, useState } from 'react';
import { isOffline, subscribeNetworkStatus } from '../lib/networkStatus';

// Stage 17 — driven entirely by real request outcomes (lib/api.js calls
// markOffline()/markOnline()), not navigator.onLine, so it also fires
// when the network adapter is fine but the backend itself is down.
export default function NetworkStatusBanner() {
  const [offline, setOffline] = useState(isOffline());

  useEffect(() => subscribeNetworkStatus(setOffline), []);

  if (!offline) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[60] bg-amber-500 text-white text-sm text-center py-1.5 shadow">
      Can't reach the server. You're still logged in — some pages won't
      load new data until the connection comes back.
    </div>
  );
}
