#!/usr/bin/env node
/**
 * PostToolUse hook: remind Claude to update the matching PRD after any Edit/Write/MultiEdit in src/**.
 *
 * Claude Code passes the hook event as JSON on stdin. We parse it, figure out which file
 * was touched, map it to the PRD(s) it belongs to, and print a reminder on stderr so
 * Claude sees it as feedback.
 *
 * Skips non-src files (configs, docs, PRDs themselves) to avoid reminder spam.
 */

const { readFileSync } = require('fs');
const { resolve, relative, sep } = require('path');

// Map src-path prefixes to PRD filenames. Longest prefix wins.
const PRD_MAP = [
  ['src/pages/Builder/',                'docs/prd/model-builder.md'],
  ['src/pages/Records/',                'docs/prd/record-management.md'],
  ['src/pages/Workflow/',               'docs/prd/workflow-automation.md'],
  ['src/lib/workflowEngine.ts',         'docs/prd/workflow-automation.md'],
  ['src/pages/Dashboard/',              'docs/prd/dashboards.md'],
  ['src/lib/dashboardUtils.ts',         'docs/prd/dashboards.md'],
  ['src/lib/widgetLayout.ts',           'docs/prd/dashboards.md'],
  ['src/pages/Settings/UsersPage.tsx',  'docs/prd/access-control.md'],
  ['src/pages/Settings/RolesPage.tsx',  'docs/prd/access-control.md'],
  ['src/pages/Settings/ProfilesPage.tsx','docs/prd/access-control.md'],
  ['src/pages/Settings/components/PermissionMatrix.tsx', 'docs/prd/access-control.md'],
  ['src/pages/Settings/components/RoleFieldEditor.tsx',  'docs/prd/access-control.md'],
  ['src/hooks/usePermission.ts',        'docs/prd/access-control.md'],
  ['src/lib/permissions.ts',            'docs/prd/access-control.md'],
  ['src/pages/Settings/TranslationSettingsPage.tsx', 'docs/prd/internationalization.md'],
  ['src/lib/i18n.ts',                   'docs/prd/internationalization.md'],
  ['src/lib/autoTranslate.ts',          'docs/prd/internationalization.md'],
  ['src/lib/excelUtils.ts',             'docs/prd/import-export.md'],
  ['src/lib/pdfGenerator.ts',           'docs/prd/import-export.md'],
  ['src/pages/Records/components/ImportModal.tsx',        'docs/prd/import-export.md'],
  ['src/pages/Records/components/ResearchPDFTemplate.tsx','docs/prd/import-export.md'],
  ['src/components/layout/',            'docs/prd/navigation-layout.md'],
  ['src/pages/Settings/SettingsPage.tsx', 'docs/prd/navigation-layout.md'],
  ['src/App.tsx',                       'docs/prd/navigation-layout.md'],
  ['src/lib/supabase.ts',               'docs/prd/data-storage.md'],
  ['src/stores/appStore.ts',            'docs/prd/data-storage.md'],
  ['src/data/seedModels.ts',            'docs/prd/data-storage.md'],
  ['src/data/seedUsers.ts',             'docs/prd/data-storage.md'],
  ['src/pages/Home/',                   'docs/prd/home-dashboard.md'],
  // Types + shared UI touch many PRDs — flag for manual review
  ['src/types/index.ts',                'MULTIPLE'],
  ['src/components/ui/',                'MULTIPLE'],
];

function normalize(p) {
  return String(p || '').split(sep).join('/');
}

function findPrd(filePath) {
  const rel = normalize(filePath);
  // Sort matches longest-prefix-first so a specific file beats a folder prefix.
  const hits = PRD_MAP
    .filter(([prefix]) => rel.includes(prefix))
    .sort((a, b) => b[0].length - a[0].length);
  return hits.length ? hits[0][1] : null;
}

let payload = '';
try {
  payload = readFileSync(0, 'utf8');
} catch {
  // No stdin payload — nothing to do.
  process.exit(0);
}

let event;
try {
  event = JSON.parse(payload);
} catch {
  process.exit(0);
}

const toolInput = event.tool_input || {};
const filePath = toolInput.file_path || toolInput.notebook_path || '';

if (!filePath) process.exit(0);

const relPath = normalize(filePath);

// Ignore edits that aren't in src/ (configs, docs, PRDs themselves, node_modules).
if (!relPath.includes('/src/') && !relPath.startsWith('src/')) process.exit(0);

const prd = findPrd(relPath);
if (!prd) process.exit(0);

const shortPath = relPath.slice(relPath.indexOf('src/'));

let msg;
if (prd === 'MULTIPLE') {
  msg =
    `[PRD reminder] You edited ${shortPath}. This file is cross-cutting and may affect multiple PRDs in docs/prd/. ` +
    `Review which PRDs are impacted and update them. Skip only for pure refactors/typo fixes.`;
} else {
  msg =
    `[PRD reminder] You edited ${shortPath}. This maps to ${prd}. ` +
    `If the change affects user-facing behavior (flows, rules, new fields/actions/widgets), update that PRD and bump its 'Last updated' date. ` +
    `Skip only for pure refactors/typo/comment/test-only changes.`;
}

// stderr is shown to Claude as hook feedback.
process.stderr.write(msg + '\n');
process.exit(0);
