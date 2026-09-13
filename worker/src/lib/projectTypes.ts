/**
 * Minimal structural type shims for the ported Projects/Units resolvers.
 *
 * The worker is a standalone npm package and cannot import `@/types`. The full
 * AppModel/ModelField/FieldOption types in src/types/index.ts carry dozens of
 * Builder-only fields the resolvers never read; these shims declare ONLY the
 * subset `projectView.ts` / `unitView.ts` actually touch. They are structurally
 * compatible with the real types (a real AppModel/AppRecord satisfies them), so
 * the resolver logic ports verbatim. Keep in sync with the fields the resolvers
 * reference if the canonical resolvers change.
 */

export interface FieldOption {
  id?: string;
  label_ar: string;
  label_en: string;
  value: string;
  color?: string;
}

export interface ModelField {
  id: string;
  name: string;
  type: string;
  section_id?: string;
  options?: FieldOption[];
  lookup_model_id?: string | null;
  lookup_display_field?: string | null;
  is_multi?: boolean;
  /** Rollup marker read by rollupByKind (legacy alias: computed_kind). */
  rollup_kind?: string;
  computed_kind?: string;
}

export interface ModelSection {
  id: string;
  fields: ModelField[];
}

export interface ModelSchema {
  sections: ModelSection[];
}

export interface AppModel {
  id: string;
  name: string;
  schema: ModelSchema;
}

export interface AppRecord {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
}
