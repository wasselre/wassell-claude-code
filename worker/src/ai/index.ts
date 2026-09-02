/**
 * Public surface of the AI role adapter (contracts §4). Import from here:
 *
 *   import { callRole, embed, embedQuery, resolveRoles, createRoleLedger, recordRoleUse } from './ai/index.js';
 */

export * from './types.js';
export { PRICING, priceFor, computeCostUsd, sumCosts, type ModelPrice, type TokenUsage } from './pricing.js';
export {
  CODE_DEFAULTS,
  ROLES_CACHE_TTL_MS,
  resolveRoles,
  mergeRoles,
  callRole,
  embed,
  embedQuery,
  createRoleLedger,
  recordRoleUse,
  ledgerToJson,
  resetAiState,
  type AiContext,
  type ProviderRegistry,
  type ResolveOptions,
  type RoleUseEntry,
  type RoleUseLedger,
  type SettingsClient,
} from './roles.js';
export { createAnthropicProvider, resetAnthropicProviderState, type AnthropicLike, type AnthropicProviderOptions } from './providers/anthropic.js';
export { createModalEmbedProvider, type ModalEmbedOptions, type ModalEmbedProvider } from './providers/modalEmbed.js';
