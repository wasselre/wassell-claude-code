# PRD: Navigation & Layout

**Status:** Live
**Last updated:** 2026-05-31 (**Back-to-Settings link on every page reachable from the Settings hub:** each such page now renders a shared "← Settings" link (`BackToSettings.tsx`) at the top of its content that returns to the Settings hub. Covers the `/settings/*` pages (Translations, Profiles, Roles, Users, Webhooks, WhatsApp Numbers, Audit Log, Menu Arrangement, Project Details) AND the standalone destinations linked from Settings cards (Model Builder, Workflows, Workflow Execution Logs, Dashboards). The two pages that already had ad-hoc back controls were unified onto the shared component. The Website Settings card redirects into the generic record form for the `site_settings` singleton; that form shows the link (and routes its back-arrow to `/settings`) only when `model.name === 'site_settings'`, so the link never leaks onto ordinary record forms.) 2026-05-09 (**Sidebar groups now collapse by default:** model groups in the sidebar (Projects, Marketing, etc.) start collapsed on every load. Click the group header to expand. Per-group state is not persisted — reload returns all groups to collapsed.) 2026-04-27 (**Presentations feature removed:** the top-level Presentations nav entry, its sub-links to Templates and Brands, and the related routes were deleted. The sidebar now goes Home → Whiteboard directly. Whiteboard nav entry added 2026-04-24.)
**Related PRDs:** model-builder.md, internationalization.md, home-dashboard.md, whiteboard.md

## What it is (in plain English)
The "shell" of the app: the persistent sidebar on one edge, the header across the top, and the main content area where pages render. The sidebar shows navigation organized into folder-like groups (Projects, People, etc.), plus links to Builder, Workflows, Dashboards, and Settings. The header holds the Wassell logo, the language toggle, and user/profile menu. Everything flips correctly when switching between Arabic (sidebar on the right) and English (sidebar on the left).

## Why it exists
A consistent, always-visible shell orients the user no matter how many models exist. The sidebar's grouping mechanism keeps navigation scalable when the team has 20+ models.

## Key behaviors
- **Layout** (`AppLayout.tsx`): renders `<Sidebar />`, `<Header />`, and `<Outlet />` from React Router. Wraps the whole app except the public dashboard route.
- **Sidebar**:
  - Top: Wassell logo + app name.
  - Sections: Home, Whiteboard, "Models" group (expandable by `model_groups`, **collapsed by default on every load** — click a group header to expand; state is in-session only and not persisted), "Builder", "Workflow", "Dashboards", "Settings".
  - Each model row shows its icon, color dot, AR/EN name.
  - Click a model → navigates to `/model/:modelName`.
  - Active route is highlighted.
  - Background is Charcoal Slate Gray (`#4A4E54`) per brand.
  - **Desktop (≥768px):** always-visible fixed rail; main content is offset by the sidebar width via `margin-inline-start`. A chevron toggle button in the sidebar header collapses the rail to a narrow icon-only column (72px). When collapsed, labels, section headings ("Dashboard", "System"), the group/folder layer, and the user's email are hidden — group members render as a flat list of icons, and each icon gets a `title` tooltip with its full label. The collapsed/expanded state is persisted in `localStorage` (key: `sidebar_collapsed`) via an `html.sidebar-collapsed` class that CSS uses to resize both the sidebar and the main-content margin together.
  - **Mobile (<768px):** off-canvas drawer, closed by default. Opens when the header hamburger is tapped and closes on route change, backdrop click, or the in-drawer X button. A semi-transparent backdrop dims the page content while the drawer is open. The desktop collapse toggle is hidden on mobile (the drawer replaces it).
- **Header**:
  - Language toggle (AR / EN).
  - Current user indicator.
  - **Mobile hamburger** (visible only below 768px) that opens the sidebar drawer.
  - Padding and font size scale down on mobile (`px-4 md:px-8`, `text-lg md:text-xl`).
- **Settings hub** (`/settings`): a page with cards linking to Translations, Profiles, Roles, Users, and more. Every page reachable from the hub renders a shared **"← Settings" back link** (`src/pages/Settings/components/BackToSettings.tsx`) at the top of its content to return here without using the sidebar or browser back button — this includes the `/settings/*` sub-pages, the standalone destinations the hub links to (Model Builder, Workflows, Workflow Execution Logs, Dashboards), and the Website Settings card's target (the `site_settings` singleton's record form, where the link is shown conditionally so it never appears on ordinary record forms).
- **Public dashboard** route (`/public/dashboard/:token`) intentionally skips the layout — no sidebar, no header.
- **Model groups** come from the `model_groups` table and can be reordered; sidebar respects that order.
- **RTL support** — margins/padding use logical properties so the sidebar position flips automatically.

## User flows
1. **Navigate to a model:** Click model name in sidebar → records list loads.
2. **Jump to Builder:** Click "Builder" in sidebar → `/builder` opens.
3. **Change language:** Click AR/EN toggle in header → whole app flips direction.
4. **Access admin settings:** Click "Settings" → hub page → pick Users, Roles, Profiles, or Translations.
5. **Share a dashboard externally:** Dashboard editor → copy public URL → share. The recipient lands on a layout-free page.
6. **Collapse the sidebar to a rail (desktop):** Click the chevron in the sidebar header → sidebar shrinks to icons only, main content expands. Hovering an icon reveals the label as a tooltip. Click the chevron again to expand. Choice persists across reloads.

## Data touched
- Reads: `model_groups` and `models` (to render sidebar).
- Reads: `useAppStore().language` (for direction and labels).

## Key files
| File | What it does |
|---|---|
| `src/App.tsx` | Route definitions |
| `src/components/layout/AppLayout.tsx` | Shell wrapper with Outlet |
| `src/components/layout/Sidebar.tsx` | Sidebar navigation |
| `src/components/layout/Header.tsx` | Top bar, language toggle |
| `src/pages/Settings/SettingsPage.tsx` | Settings hub page |
| `src/pages/Settings/components/BackToSettings.tsx` | Shared "← Settings" back link shown on every settings sub-page |
| `src/index.css` | `.sidebar`, `.main-content`, `.nav-item` styles |
| `tailwind.config.js` | Brand color and font setup |

## Open questions / known limitations
- No breadcrumbs yet — deep pages (e.g. a record inside a model inside a group) don't show the full path.
- No keyboard shortcuts for navigation.
- When the sidebar is collapsed to the rail, groups lose their folder structure and are flattened into a single icon list — there's no popout or hover-to-reveal per group.
- No per-user favorites or pinned models.
- Mobile layout uses Tailwind's default `md` breakpoint (768px) as the desktop threshold. Tablets in portrait (<768px) get the mobile drawer.
