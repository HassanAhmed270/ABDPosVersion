import { useCallback, useRef, useState } from 'react';

/**
 * Guards an async action (button click / form submit) against being
 * run twice from a single user action.
 *
 * Why this exists: disabling a button from React state alone isn't
 * enough. State updates aren't synchronous, so a fast double-click or
 * double-tap — routine in the Electron build, where the renderer can
 * lag a frame behind the click events — can fire the handler twice
 * before the re-render that disables the button ever paints. For
 * anything that touches stock, balances, or money (generating a bill,
 * adding/deducting stock, refunds, customer payments) that second run
 * means double-charging a customer, double-deducting stock, or double
 * -posting a balance entry.
 *
 * `guard` closes over a plain ref (checked synchronously, not subject
 * to React's batching) as the real lock, and mirrors it into
 * `submitting` state purely so the UI can disable the button and show
 * a spinner/label while the action is in flight. The ref is what
 * actually blocks the second call; the state is just for rendering.
 *
 * Usage:
 *   const { submitting, guard } = useSubmitGuard();
 *   const handleGenerateBill = guard(async () => { ... });
 *   <button onClick={handleGenerateBill} disabled={submitting}>
 *     {submitting ? 'Saving…' : 'Generate Bill'}
 *   </button>
 */
export function useSubmitGuard() {
  const runningRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const guard = useCallback((handler) => {
    return async (...args) => {
      if (runningRef.current) {
        // Ignore the duplicate click/tap outright — do not queue or
        // retry it, just drop it silently. The first run is already
        // handling this action.
        return;
      }

      runningRef.current = true;
      setSubmitting(true);

      try {
        return await handler(...args);
      } finally {
        runningRef.current = false;
        setSubmitting(false);
      }
    };
  }, []);

  return { submitting, guard };
}
