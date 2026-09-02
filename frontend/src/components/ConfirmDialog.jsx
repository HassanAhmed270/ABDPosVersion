import { createContext, useContext, useCallback, useRef, useState } from 'react';

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { message, confirmText, cancelText }
  const resolverRef = useRef(null);

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({
        message,
        confirmText: options.confirmText || 'Confirm',
        cancelText: options.cancelText || 'Cancel',
      });
    });
  }, []);

  const settle = useCallback((result) => {
    setState(null);
    if (resolverRef.current) {
      resolverRef.current(result);
      resolverRef.current = null;
    }
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => settle(false)}
        >
          <div
            className="bg-white p-6 rounded-lg shadow-xl w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-gray-800 mb-4 whitespace-pre-line">{state.message}</p>
            <div className="text-center pt-2 flex gap-2 justify-center">
              <button
                type="button"
                autoFocus
                onClick={() => settle(true)}
                className="bg-brand text-white px-6 py-1.5 rounded hover:bg-brand-dark transition"
              >
                {state.confirmText}
              </button>
              <button
                type="button"
                onClick={() => settle(false)}
                className="bg-gray-200 text-gray-700 px-4 py-1.5 rounded hover:bg-gray-300"
              >
                {state.cancelText}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
