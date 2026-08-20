import { useEffect, useState } from 'react';

/**
 * `true` on a phone-sized viewport (below Tailwind's `md` breakpoint, 768px) —
 * live across resizes. Used to keep the in-chat popup behaviours mobile-only
 * while the laptop keeps its original navigate / new-tab behaviour.
 */
export function useIsMobile(): boolean {
  const query = '(max-width: 767px)';
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent): void => setMobile(e.matches);
    mq.addEventListener('change', on);
    // Sync in case the width changed between the initial state and mount.
    setMobile(mq.matches);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

export default useIsMobile;
