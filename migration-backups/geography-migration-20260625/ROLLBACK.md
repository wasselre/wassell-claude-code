# Geography migration — rollback (2026-06-25)

DB-level snapshots (authoritative rollback; created before any change):

| Backup table | Contents |
|---|---|
| `public._backup_geo_20260625_models` | full `models` table (40 rows) — all model schemas pre-change |
| `public._backup_geo_20260625_profiles` | full `profiles` table (5 rows) — pre-grant `model_permissions` |
| `public._backup_geo_20260625_records` | `records` rows for districts, all_projects, our_projects, units, clients, followups, marketing_operations (3,526 rows) |

## To roll back

1. **Disable lookup-primary matching** — set the matching engine back to legacy-text (the dual-read flag; or revert the `matchAgent.ts` commit). Legacy text fields are intact, so matching keeps working.
2. **Restore a model schema** (e.g. all_projects/clients/units/districts/marketing_operations):
   ```sql
   UPDATE public.models m SET schema = b.schema
   FROM public._backup_geo_20260625_models b WHERE b.id = m.id AND m.name = '<name>';
   ```
3. **Restore profile permissions** (undo the geography view grants):
   ```sql
   UPDATE public.profiles p SET model_permissions = b.model_permissions
   FROM public._backup_geo_20260625_profiles b WHERE b.id = p.id;
   ```
4. **Restore changed records** (only if a backfill wrote bad data):
   ```sql
   UPDATE public.records r SET data = b.data
   FROM public._backup_geo_20260625_records b WHERE b.id = r.id;
   ```
5. **Remove imported geography** only if necessary:
   - Records-models: `DELETE FROM records WHERE model_id IN (<regions>,<cities>); DELETE FROM records WHERE model_id='<districts>' AND data->>'source' LIKE 'SPL%';` then delete the Regions/Cities model rows.
   - Physical tables: `DROP TABLE public.district_boundaries, public.district_aliases, public.geography_import_runs;` and `DROP EXTENSION postgis;` (only if nothing else uses it).

**Never delete legacy district/neighborhood fields** — they are the rollback safety net. They were preserved (renamed to `legacy_*`), not dropped.

Keep these backup tables until the migration is validated in production. Drop with `DROP TABLE public._backup_geo_20260625_*;` once confirmed unneeded.
