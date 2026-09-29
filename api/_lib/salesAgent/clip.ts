/**
 * Cut a string to at most `max` UTF-16 units WITHOUT splitting a surrogate pair.
 *
 * `String.slice` counts UTF-16 units, and an emoji (📸 🏠 📍 …) is two of them.
 * A plain `.slice(0, n)` that lands between the two leaves a lone high
 * surrogate, which is not valid Unicode: JSON.stringify emits it as-is and the
 * Anthropic API rejects the whole request ("no low surrogate in string"). That
 * is exactly what broke the sales agent on 2026-09-29, when project cards
 * gained emoji-led tracked-link lines — every turn after a project send failed
 * at the first model call and fell back to the rules agent.
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}
