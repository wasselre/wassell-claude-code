# PRD: Whiteboard

**Status:** Live
**Last updated:** 2026-04-24
**Related PRDs:** navigation-layout.md, internationalization.md

## What it is (in plain English)
A full-bleed drawing canvas embedded in the app. The user can sketch, drop shapes and arrows, pin text, paste images (e.g. a project site plan or floor plan screenshot), and annotate on top. Think of it as a built-in whiteboard for quick visual planning — marketing campaigns, plot maps, sales funnels, brainstorming — without leaving the CRM. The board is **personal to the browser**: everything the user draws is saved locally and reloads automatically on next visit.

## Why it exists
Real-estate teams often plan visually (site boundaries, journey maps, campaign funnels) but today they'd bounce to Miro/FigJam and lose the link back to the CRM. A lightweight built-in whiteboard removes that friction. We use the tldraw SDK under the hood — enterprise-grade infinite-canvas engine — rather than rolling our own.

## Key behaviors
- URL: `/whiteboard` (top-level, sits next to Home, Presentations, etc. in the sidebar).
- Canvas fills a fixed viewport-relative box (`calc(100vh - 10rem)`) below the page header.
- **Tools included out of the box** (from tldraw): select, hand, draw, eraser, rectangle / ellipse / triangle / diamond / arrow / line / frame shapes, text, sticky note, laser pointer, highlighter, image upload.
- **Persistence:** the canvas auto-saves to the browser's **IndexedDB** under the `persistenceKey` `wassel-whiteboard-v1`. No Save button — every edit is persisted within milliseconds, and reopening the page restores the last state. Nothing is synced to Supabase yet, so it is per-browser-profile only.
- **Language/direction:** the tldraw UI chrome (toolbar, menus, handle controls) is English-LTR only. We force `dir="ltr"` on the canvas wrapper regardless of the app's current language so the chrome stays readable. Our own page header (title + subtitle) still follows the app language.
- **Bundle isolation:** the Whiteboard route is lazy-loaded via `React.lazy`, so tldraw's code and its stylesheet are only downloaded when a user first visits `/whiteboard` — the main bundle stays lean.
- **License posture:** the tldraw SDK's default terms permit **development use only**. Before shipping to production we must either (a) acquire a commercial license and pass it as `<Tldraw licenseKey=…>`, or (b) fall back to the free hobby license which forces a "Made with tldraw" watermark on the canvas. This decision is currently open — see Limitations.

## User flows
1. **Open the whiteboard:** sidebar → "Whiteboard" → canvas renders with whatever was drawn last time (or a blank board on first visit).
2. **Draw / annotate:** pick a tool from the bottom toolbar → draw → tldraw auto-saves as you go.
3. **Add an image:** drag an image file into the canvas, or use the image tool from the toolbar → annotate on top.
4. **Reset the board:** tldraw's "Edit → Select All → Delete" clears the current canvas. There is no dedicated "new board" button in v1 — the board is a single persistent document per browser profile.
5. **Empty state:** first visit shows a blank infinite canvas with the default tldraw toolbar. Title + one-line subtitle appear in our own page header above.

## Data touched
- **Writes:** browser IndexedDB (owned and managed by the tldraw SDK, keyed by `persistenceKey`).
- **Reads:** same IndexedDB entry on subsequent visits.
- Nothing is read from or written to Supabase, `records`, `models`, or any other app table.

## Key files
| File | What it does |
|---|---|
| `src/pages/Whiteboard/WhiteboardPage.tsx` | Page component — renders `<Tldraw>` inside a sized, LTR-forced wrapper |
| `src/App.tsx` | Lazy-loads `WhiteboardPage` and mounts the `/whiteboard` route under `AppLayout` |
| `src/components/layout/Sidebar.tsx` | Nav entry ("Whiteboard" / "اللوحة البيضاء") using the `SquarePen` icon |
| `src/lib/i18n.ts` | `nav.whiteboard` and `whiteboard.title` strings in both languages |
| `package.json` | `tldraw` dependency (currently `^4.5.10`) |

## Open questions / known limitations
- **Per-browser only.** Because persistence is IndexedDB and not Supabase, the user loses the board when switching browsers/devices and it isn't shareable with teammates. Next step when the need arises: serialize tldraw's store snapshot to a new `whiteboards` table (one row, JSONB), plus the obvious multi-board list page.
- **Not multiplayer.** tldraw supports real-time collaboration but it requires running a sync backend. Not set up in v1.
- **RTL UI.** tldraw's toolbar and menus don't support right-to-left layout; Arabic users see English chrome by design. The user-facing page header (above the canvas) still honors language.
- **Production license.** We're running under tldraw's development-only default terms. Before this is exposed to paying customers we need to either pay for a commercial license or accept the hobby-license watermark — see CLAUDE.md for the eventual choice.
- **No export / import.** Users can't yet export the canvas as PNG/SVG or import a saved board. tldraw supports both APIs; we just haven't surfaced them.
- **Single board per browser.** `persistenceKey` is hard-coded. There's no way to have multiple named boards (one per project, one per campaign) without introducing a list page + board-id URL param.
