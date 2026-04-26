import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GoogleDriveOAuth } from '../env.ts';
import { WEB_SEARCH_TOOL, WEB_FETCH_TOOL, CODE_EXECUTION_TOOL } from './builtin.ts';
import { RECORD_LOOKUP_TOOL, runRecordLookup, type RecordLookupInput } from './recordLookup.ts';
import { DRIVE_UPLOAD_TOOL, runDriveUpload, type DriveUploadInput } from './driveUpload.ts';

/**
 * The full set of tools available to a Phase 1B agent run. Phase 3 will
 * filter this per-template based on the user's checkbox selections in the
 * Template Builder; for now, every job sees every tool.
 */
export const ALL_TOOL_DEFS = [
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  CODE_EXECUTION_TOOL,
  RECORD_LOOKUP_TOOL,
  DRIVE_UPLOAD_TOOL,
];

/** Names of the tools the cloud worker executes itself (i.e. not Anthropic-
 *  hosted server-side tools). When the agent emits a `tool_use` block with
 *  one of these names, we run the matching function and pass the result
 *  back as a `tool_result` block. */
const CLIENT_SIDE_TOOL_NAMES = new Set([RECORD_LOOKUP_TOOL.name, DRIVE_UPLOAD_TOOL.name]);

export function isClientSideTool(name: string): boolean {
  return CLIENT_SIDE_TOOL_NAMES.has(name);
}

export interface ToolExecutionDeps {
  supabase: SupabaseClient;
  anthropic: Anthropic;
  driveOAuth: GoogleDriveOAuth | null;
  parentFolderId: string | null;
}

export async function executeToolCall(
  deps: ToolExecutionDeps,
  name: string,
  input: unknown,
): Promise<string> {
  switch (name) {
    case 'record_lookup':
      return runRecordLookup(deps.supabase, input as RecordLookupInput);
    case 'drive_upload':
      return runDriveUpload(
        {
          anthropic: deps.anthropic,
          oauth: deps.driveOAuth,
          parentFolderId: deps.parentFolderId,
        },
        input as DriveUploadInput,
      );
    default:
      return `Error: unknown tool "${name}". This is a worker bug — the tool was declared but not wired up.`;
  }
}
