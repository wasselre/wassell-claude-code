# PRD: Whiteboard

**Status:** Live
**Last updated:** 2026-04-25 (**Multi-board + folders:** `/whiteboard` is now a hub page listing every board organized into flat folders instead of a single canvas. Clicking a board opens `/whiteboard/:boardId` with its own tldraw canvas. Boards auto-save to Supabase via `editor.store.listen({ source: 'user', scope: 'document' })` with a 1.5 s debounce, mirrored through localStorage per the CRM's standard pattern. Folders are flat (Miro-style spaces, no nesting), all boards are shared across every authenticated user in the workspace. Storage lives in two new Supabase tables — `whiteboard_folders` and `whiteboards(snapshot JSONB)`. 3-dot menu on each board card for rename / move-to-folder / delete; inline rename/delete on folders.) | 2026-04-24 (**Quick-connect handles:** hovering a geo shape surfaces four copper "+" buttons; clicking one creates a same-type shape 80 px away with both arrow ends bound.) | 2026-04-24 (**License wired:** `<Tldraw licenseKey>` reads `VITE_TLDRAW_LICENSE_KEY` at build time. Trial key expires **2026-08-02**.)
**Related PRDs:** navigation-layout.md, internationalization.md, data-storage.md

## What it is (in plain English)
A built-in library of interactive drawing boards. Users create folders (like "Marketing plans" or "Project maps"), drop boards inside, and open any board to sketch, drag shapes, pin images, and connect ideas with arrows. Everything autosaves as they draw — no save button. Boards are shared across every teammate in the workspace, so anyone can open, edit, and pick up where someone else left off.

## Why it exists
Real-estate teams often plan visually — site boundaries on a satellite image, a sales funnel on a whiteboard, a "who follows up with whom" map for a launch event. Without a built-in canvas, that work drifts into Miro/FigJam and loses the link back to the CRM. We use the tldraw SDK under the hood — enterprise-grade infinite-canvas engine — rather than rolling our own, organized into folders so 50 boards don't become a wall of tiles.

## Key behaviors
### Hub page (`/whiteboard`)
- **Two create buttons** at the top — "New folder" and "New board" (prompts for a name via native `window.prompt()`; upgrade to a proper modal later if team wants descriptions/icons).
- **Folder sections** render vertically, each with its name, a board-count, and inline "Board here" / rename / delete icons.
- **Unfiled section** appears at the bottom whenever boards exist without a folder.
- **Empty state** (no folders and no boards): a big "+ New board" CTA.
- **Board cards** show name and relative "last updated" (moments / mins / hours / days ago). A 3-dot menu on hover offers Rename, Move to folder (pick from existing folders or "No folder"), Delete.
- **Deleting a folder** cascades to loose boards: the DB has `ON DELETE SET NULL` on `whiteboards.folder_id`, and the client mirrors that (boards move to "Unfiled" instead of disappearing). Confirmation dialog spells this out when the folder has boards in it.

### Editor page (`/whiteboard/:boardId`)
- Page header has a back-arrow ("← Back to list"), the board name with an inline pencil to rename, and a small "Changes save automatically" hint.
- Canvas fills `calc(100vh - 10rem)` below the header, wrapped in a forced `dir="ltr"` container so tldraw's English UI chrome stays readable even in Arabic mode.
- **Tools** come from tldraw's default toolbar: select / hand / draw / eraser / shapes / arrow / text / sticky / laser / highlighter / image upload.
- **Quick-connect "+" handles** appear when hovering any geo shape (rectangle, ellipse, etc.) — four copper buttons just outside the shape's top / right / bottom / left edges. Clicking one creates a matching-type shape 80 px away in that direction and binds an arrow between them. Handles stay visible after each click so the user can fan out in multiple directions without re-hovering.
- **Autosave:** `editor.store.listen({ source: 'user', scope: 'document' })` fires on any user-originated document mutation. We debounce 1.5 s then call `saveWhiteboardSnapshot(boardId, editor.getSnapshot())`. The store action mirrors to `localStorage('wassell_whiteboards')` first, then `upsert` to Supabase (gated on an authenticated session — no-op when running unauthenticated locally).
- **Unmount flush:** if the user navigates away mid-debounce, the `onMount` cleanup flushes a final save so the last few strokes survive.
- **Board not found:** if `:boardId` doesn't match any row in the store, the editor shows a "Board not found" card with a link back to the list.

### Persistence model
- **Two tables in Supabase** — `whiteboard_folders(id, name, "order", timestamps)` and `whiteboards(id, folder_id FK nullable, name, snapshot JSONB, "order", timestamps)`.
- **RLS:** `FOR ALL TO authenticated USING (true) WITH CHECK (true)` — any signed-in user can read and write anything (workspace-shared).
- **Offline mirror:** `loadLocal<Whiteboard[]>('wassell_whiteboards')` and `loadLocal<WhiteboardFolder[]>('wassell_whiteboard_folders')` back up every change instantly, so drawings survive a reload even before the Supabase round-trip completes.
- **Language/direction:** the tldraw UI chrome (toolbar, menus, handles) is LTR-only. We force `dir="ltr"` on the canvas wrapper regardless of the app's current language so the chrome stays readable. Our own page headers, folder names, and board names still flip for Arabic.
- **Bundle isolation:** both `/whiteboard` and `/whiteboard/:id` are lazy-loaded via `React.lazy`, so tldraw's code and its stylesheet only download when a user first visits the Whiteboard section — the main app bundle stays lean.

### License
tldraw enforces its license in production by **unmounting the editor after 5 seconds** on any non-localhost hostname when it can't validate a key (see `@tldraw/editor` `LicenseProvider` — `LICENSE_TIMEOUT` + `shouldHideEditorAfterDelay`). We pass the key via `VITE_TLDRAW_LICENSE_KEY` at build time so it gets inlined by Vite and never lives in source. Current key is a 100-day trial expiring **2026-08-02**; renew to commercial or switch to the hobby license (watermark) before then.

## User flows
1. **Create a folder:** `/whiteboard` → "New folder" → enter name → folder section appears at the bottom, empty.
2. **Create a board in a folder:** hover folder header → "Board here" → enter name → redirects to the editor. Alternatively, click "New board" in the page header → enter name → board lands in "Unfiled".
3. **Open a board:** click a card → editor loads with the board's last saved state.
4. **Draw and leave:** sketch anything → wait 1.5 s for autosave → navigate away. Reopening the board later shows the same content.
5. **Rename:** inline pencil on the editor page, or 3-dot menu → Rename on a card. Rename a folder via the pencil next to its name.
6. **Move a board:** 3-dot menu → Move to folder → pick target (any folder or "No folder").
7. **Delete:** 3-dot on a card → Delete (confirms). Or delete a folder via its trash icon — boards inside get moved to Unfiled automatically.

## Data touched
- **Reads/writes:** `whiteboard_folders` and `whiteboards` (Supabase) — mirrored to `localStorage['wassell_whiteboard_folders']` and `localStorage['wassell_whiteboards']`.
- `whiteboards.snapshot` stores the full tldraw editor snapshot (`editor.getSnapshot()`) as JSONB.
- No reads/writes to `records`, `models`, or any other app table.

## Key files
| File | What it does |
|---|---|
| `src/pages/Whiteboard/WhiteboardListPage.tsx` | Hub page — folder sections + board cards + create/rename/delete/move actions |
| `src/pages/Whiteboard/WhiteboardEditorPage.tsx` | Per-board editor — loads snapshot, renders `<Tldraw>`, debounced autosave on user edits |
| `src/pages/Whiteboard/components/QuickConnectHandles.tsx` | Miro-style "+" handles on hover, create shape + arrow binding on click |
| `src/App.tsx` | Lazy-loads both pages; routes `/whiteboard` and `/whiteboard/:boardId` |
| `src/stores/appStore.ts` | `whiteboards` + `whiteboardFolders` state; CRUD actions (`createWhiteboard`, `saveWhiteboardSnapshot`, `moveWhiteboard`, …) mirror to localStorage + Supabase |
| `src/types/index.ts` | `Whiteboard` and `WhiteboardFolder` interfaces |
| `supabase/schema.sql` | `whiteboard_folders` + `whiteboards` table definitions, indexes, RLS policies, `updated_at` triggers |
| `src/components/layout/Sidebar.tsx` | Top-level "Whiteboard" nav entry (`SquarePen` icon) |
| `src/lib/i18n.ts` | `nav.whiteboard` and `whiteboard.title` strings in both languages |
| `package.json` | `tldraw` dependency (currently `^4.5.10`) |

## Open questions / known limitations
- **Sharing is workspace-wide only.** Every authenticated user sees and can edit every board. There's no per-user "my boards" filter, no "share with specific teammate" UI, no read-only mode. Fine for a small internal team today; add a `visibility` enum (`private | team`) and per-user ownership when it starts biting.
- **Not multiplayer.** Two users editing the same board at the same time will stomp on each other's saves (last write wins; no CRDT sync). tldraw supports real-time collaboration but it requires running a sync backend. Not set up.
- **Native `prompt()` dialogs** for create/rename. Functional but ugly; upgrade to styled modals when we want board descriptions, icons, or color accents.
- **No nesting.** Folders are flat (1 level, Miro-style). Adding a `parent_id` column gives us nesting when the board count demands it.
- **Legacy single-board not migrated.** The prior `persistenceKey="wassel-whiteboard-v1"` IndexedDB blob is orphaned when this change ships — it won't show up in the new list. Users who had content there would need to manually export and re-import (tldraw supports JSON export via its menu). Not painful for the one-week-old single-board era, but worth documenting.
- **RTL UI.** tldraw's toolbar and menus don't support right-to-left layout; Arabic users see English chrome by design. Our folder names, board names, and headers still honor language.
- **Trial license clock.** `VITE_TLDRAW_LICENSE_KEY` is a 100-day trial expiring **2026-08-02**. Renew to commercial or switch to the hobby license (adds a "Made with tldraw" watermark on the canvas) before expiry.
- **No thumbnails yet.** Cards show a generic pencil icon. tldraw has an SVG export API we could call periodically to generate a thumbnail, but it adds meaningful storage + compute; defer until a user asks.
- **No reordering.** Folders and boards sort by `order`/`name` or `updated_at`; no drag-to-reorder. Add when it starts feeling needed.
- **Unauthenticated writes are local-only.** By design, `canWriteToSupabase()` returns false without a signed-in session, so all CRUD falls back to localStorage. Matches the rest of the app — just worth remembering when testing.
