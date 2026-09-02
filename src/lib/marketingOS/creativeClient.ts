/**
 * Post Creative Director — typed client wrappers (docs/creative-director-contracts.md §4).
 * One wrapper per /api/marketing-os action; transport is the shared mosCall
 * from client.ts (same auth headers, same MosApiError shape — the SPA reads
 * `error_ar` automatically on Arabic UI).
 */
import { mosCall } from './client';
import type {
  BasePackage, BrandKit, CreativeDerivativeRow, CreativeFlags, CreativeJobRow,
  CreativePackageRow, CreativeRefRow, DesignerHandoff, DerivativeTarget,
  ExampleKind, IntendedUse, PackageStatus, RoleMap, VisualAdaptation, WriterRules,
} from '../creative/contracts';

/* ── flags + targets ─────────────────────────────────────────────────────── */

export interface CreativeFlagsResult {
  flags: CreativeFlags;
  role_map: RoleMap;
  brand_kit_status: { status: BrandKit['status']; mode: BrandKit['mode']; version: number } | null;
}
export const fetchCreativeFlags = () => mosCall<CreativeFlagsResult>('creative_flags');

export interface CreativeOrganicTarget {
  platform: string;
  placement_type: string;
  publication_id: string | null;
  selected: boolean;
}
export interface CreativePaidTarget {
  platform: string;
  placement_type: string;
  execution_id: string;
  ad_set_id: string | null;
  ad_id: string | null;
  campaign_id: string;
  selected: boolean;
}
export interface CreativeTargetsResult {
  organic: CreativeOrganicTarget[];
  paid: CreativePaidTarget[];
  suggested_master_aspect: string;
}
export const fetchCreativeTargets = (contentId: string) =>
  mosCall<CreativeTargetsResult>('creative_targets', { content_id: contentId });

/* ── jobs ────────────────────────────────────────────────────────────────── */

export const writePostCreative = (payload: {
  content_id: string;
  targets: DerivativeTarget[];
  recipe?: string | null;
  intended_use?: IntendedUse;
}) => mosCall<{ job: CreativeJobRow }>('write_post_creative', payload as Record<string, unknown>);

export const selectCreativeConcept = (payload: {
  package_id: string;
  concept_id?: string | null;
  custom?: { title: string; angle: string; format: 'single' | 'carousel' };
}) => mosCall<{ job: CreativeJobRow }>('creative_concept_select', payload as Record<string, unknown>);

export const regenerateCreative = (packageId: string, revisionNote: string) =>
  mosCall<{ job: CreativeJobRow }>('creative_regenerate', { package_id: packageId, revision_note: revisionNote });

export const fetchCreativeJobStatus = (contentId: string) =>
  mosCall<{ job: CreativeJobRow | null }>('creative_job_status', { content_id: contentId });

/* ── packages ────────────────────────────────────────────────────────────── */

export const listCreativePackages = (contentId: string) =>
  mosCall<{ packages: CreativePackageRow[] }>('creative_package_list', { content_id: contentId });

export interface CreativePackageGetResult {
  package: CreativePackageRow;
  derivatives: CreativeDerivativeRow[];
  refs: CreativeRefRow[];
  previews: Record<string, string>;
}
export const fetchCreativePackage = (packageId: string) =>
  mosCall<CreativePackageGetResult>('creative_package_get', { package_id: packageId });

export interface CreativeDerivativeEdit {
  target_kind: 'organic' | 'paid';
  platform: string;
  placement_type: string;
  target_ref?: Record<string, string>;
  dimensions?: { aspect: string; px: [number, number] };
  adaptation?: VisualAdaptation;
  copy?: unknown;
  limits?: Record<string, unknown>;
  warnings?: string[];
}
export const saveCreativePackage = (payload: {
  package_id: string;
  base?: BasePackage;
  derivatives?: CreativeDerivativeEdit[];
  revision_note?: string | null;
}) => mosCall<{ package: CreativePackageRow; derivatives: CreativeDerivativeRow[] }>(
  'creative_package_save', payload as Record<string, unknown>);

export const replaceCreativeAsset = (packageId: string, assetIndex: number, fileId: string) =>
  mosCall<{ package: CreativePackageRow }>('creative_asset_replace', {
    package_id: packageId, asset_index: assetIndex, file_id: fileId,
  });

export interface CreativeOverwrite {
  headlines?: boolean;
  design_brief?: boolean;
  captions?: boolean;
  ad_copy?: boolean;
}
export const applyCreativePackage = (
  packageId: string,
  overwrite: CreativeOverwrite = {},
  confirmUnverifiedRights = false,
) => mosCall<{ applied: boolean; package_id: string }>('creative_package_apply', {
  package_id: packageId, overwrite, confirm_unverified_rights: confirmUnverifiedRights,
});

export const revertCreativePackage = (packageId: string) =>
  mosCall<{ ok: true; restored: string[]; restore_failed: string[] }>(
    'creative_package_revert', { package_id: packageId });

/* ── AI recommendations ──────────────────────────────────────────────────── */

export const approveCreativeAi = (packageId: string, index: number) =>
  mosCall<{ job_id: string }>('creative_ai_approve', { package_id: packageId, index });

export const dismissCreativeAi = (packageId: string, index: number) =>
  mosCall<{ ok: true }>('creative_ai_dismiss', { package_id: packageId, index });

/* ── handoff + performance ───────────────────────────────────────────────── */

export interface CreativeHandoffResult {
  handoff: DesignerHandoff;
  role_map: RoleMap;
  draft: boolean;
  package_status: PackageStatus;
}
export const fetchCreativeHandoff = (contentId: string) =>
  mosCall<CreativeHandoffResult>('creative_handoff', { content_id: contentId });

export interface CreativePerformanceRow {
  content_id: string;
  publications: number;
  views: number;
  engagement: number;
  likes: number;
  comments: number;
  saves: number;
  enquiries: number;
  last_captured_at: string | null;
}
export interface CreativePerformanceResult {
  performance: CreativePerformanceRow | null;
  package: {
    id: string; version: number; intended_use: IntendedUse;
    applied_at: string | null; cost_usd: number | null; derivative_count: number;
  } | null;
}
export const fetchCreativePerformance = (contentId: string) =>
  mosCall<CreativePerformanceResult>('creative_performance', { content_id: contentId });

/* ── settings: brand kit / writer rules / role map / flags / ai roles ────── */

export const fetchBrandKit = () => mosCall<{ kit: BrandKit | null }>('brand_kit_get');
export const saveBrandKit = (kit: Partial<BrandKit>) =>
  mosCall<{ kit: BrandKit }>('brand_kit_save', { kit: kit as Record<string, unknown> });
export const reviewBrandKit = () => mosCall<{ kit: BrandKit }>('brand_kit_review');

export const fetchWriterRules = () => mosCall<{ rules: WriterRules }>('writer_rules_get');
export const saveWriterRules = (rules: WriterRules) =>
  mosCall<{ rules: WriterRules }>('writer_rules_save', { rules: rules as unknown as Record<string, unknown> });

export const fetchRoleMap = () => mosCall<{ role_map: RoleMap }>('role_map_get');
export const saveRoleMap = (roleMap: RoleMap) =>
  mosCall<{ role_map: RoleMap }>('role_map_save', { role_map: roleMap as unknown as Record<string, unknown> });

export const saveCreativeFlags = (flags: Partial<CreativeFlags>) =>
  mosCall<{ flags: CreativeFlags }>('creative_flags_save', { flags: flags as Record<string, unknown> });

export interface AiRoleConfig {
  provider: string;
  model: string;
  version?: string;
  params?: Record<string, unknown>;
}
export const fetchAiRoles = () => mosCall<{ roles: Record<string, AiRoleConfig> }>('ai_roles_get');
export const saveAiRoles = (roles: Record<string, AiRoleConfig>) =>
  mosCall<{ roles: Record<string, AiRoleConfig> }>('ai_roles_save', { roles: roles as Record<string, unknown> });

/* ── design examples ─────────────────────────────────────────────────────── */

export interface DesignExampleRow {
  id: string;
  subject_kind: 'wassel_content' | 'wassel_file' | 'competitor_post';
  subject_id: string;
  example_kind: ExampleKind;
  strengths: string[];
  caveats: string[];
  note: string | null;
  approved_by_user_id: string;
  approved_at: string;
  retired_at: string | null;
}
export const setDesignExample = (payload: {
  subject_kind: DesignExampleRow['subject_kind'];
  subject_id: string;
  example_kind?: ExampleKind;
  strengths?: string[];
  caveats?: string[];
  note?: string | null;
  retire?: boolean;
}) => mosCall<{ example?: DesignExampleRow; ok?: true; retired?: boolean }>(
  'design_example_set', payload as Record<string, unknown>);

export const listDesignExamples = (includeRetired = false) =>
  mosCall<{ examples: DesignExampleRow[]; previews: Record<string, string> }>(
    'design_example_list', { include_retired: includeRetired });
