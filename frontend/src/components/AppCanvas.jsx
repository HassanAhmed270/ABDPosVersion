import { useEffect, useState } from 'react';

// The whole app is authored for a single fixed reference layout. Every
// page keeps using its existing `h-screen` / `overflow-y-auto` scroll
// regions unchanged — index.css remaps those from the real viewport to
// this canvas (see `.app-canvas` rules) so internal scrolling still sizes
// itself off the 1536x898 design box instead of the real (unscaled)
// window height.
export const APP_DESIGN_WIDTH = 1536;
export const APP_DESIGN_HEIGHT = 898;

function computeScale() {
  const scale = Math.min(
    window.innerWidth / APP_DESIGN_WIDTH,
    window.innerHeight / APP_DESIGN_HEIGHT,
    1
  );
  return scale > 0 ? scale : 1;
}

// Wraps the entire app in a fixed 1536x898 canvas. At that size (or
// larger) the canvas renders at its native size with any extra space left
// unused around it. Below it, the whole canvas is scaled down uniformly
// with a CSS transform — the layout itself never reflows into a separate
// mobile/tablet arrangement, it just shrinks as one unit.
export default function AppCanvas({ children }) {
  const [scale, setScale] = useState(() =>
    typeof window === 'undefined' ? 1 : computeScale()
  );

  useEffect(() => {
    const handleResize = () => setScale(computeScale());
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="app-viewport">
      <div
        className="app-canvas"
        style={{
          width: APP_DESIGN_WIDTH,
          height: APP_DESIGN_HEIGHT,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
