#!/usr/bin/env node
// Operations helper. Supply secrets through the environment (never CLI values).
import { readFileSync } from 'node:fs';

const projectRef = 'zhqqsxwealdwqzrbpwyv';
export async function query(sql) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required');
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase SQL HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/binghatti-db.mjs')) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node --env-file=<private env> scripts/binghatti-db.mjs <SQL file>');
  console.log(JSON.stringify(await query(readFileSync(file, 'utf8')), null, 2));
}
