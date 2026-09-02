import { useEffect, useState } from 'react';

// Returns `value`, but only updates ~`delay`ms after the last change —
// used so a search input doesn't fire a server request on every
// keystroke (Stage 8).
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}