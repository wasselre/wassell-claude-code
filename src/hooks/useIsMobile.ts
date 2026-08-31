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

/**
 * `true` on a wide desktop viewport (Tailwind's `xl` breakpoint, ≥1280px) —
 * live across resizes. Used to decide whether a side panel can be DOCKED
 * beside content (splitting the view) rather than shown as a full-screen
 * modal. The threshold is `xl`, not `lg`: the chats page already spends width
 * on the app nav rail + the 360px conversation list, so a comfortable third
 * column needs ≥1280px — below that the docked panel would squeeze the chat
 * too far and the full-screen modal is the better experience.
 */
export function useIsWideScreen(): boolean {
  const query = '(min-width: 1280px)';
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent): void => setWide(e.matches);
    mq.addEventListener('change', on);
    setWide(mq.matches);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export default useIsMobile;
