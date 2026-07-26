#!/usr/bin/env node
/**
 * Read-only DB access for headless whatsapp-reply sessions.
 *   node tools/db.mjs "SELECT ..."
 * Runs ONE statement through the `claude_runner_sql` RPC (read-only enforced
 * server-side) and prints rows as JSON. The Supabase MCP needs an interactive
 * OAuth flow that cannot happen in a container, hence this helper.
 */
import { createClient } from '@supabase/supabase-js';

const sql = process.argv.slice(2).join(' ').trim();
if (!sql) { console.error('usage: db.mjs "<SELECT ...>"'); process.exit(2); }

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(2); }

const supa = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await supa.rpc('claude_runner_sql', { p_sql: sql });
if (error) { console.error('SQL error:', error.message); process.exit(1); }
console.log(JSON.stringify(data, null, 1));
