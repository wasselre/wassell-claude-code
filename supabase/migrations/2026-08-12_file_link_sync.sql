-- ============================================================================
-- Phase 2 — transactional synchronisation of the file-link projection
--
-- Phase 1 built the projection and a backfill. It was explicitly a SNAPSHOT:
-- the moment the backfill finished it began drifting, and `file_links_reconcile`
-- could only MEASURE that drift. Phase 2 makes the projection converge inside
-- the same transaction as the authoritative write, so source and projection
-- commit or roll back together and there is no window in which they disagree.
--
-- The projection stays DERIVED. No user authors it. This migration adds no
-- write grant, no authorization branch, and no relationship-derived access.
--
-- ── WHY TRIGGERS ───────────────────────────────────────────────────────────
-- Writes to the four authoritative sources arrive through the SPA store, the
-- record_save/record_delete RPCs, six Fly worker lanes, Vercel API routes,
-- migrations and ad-hoc SQL. Verified on production 2026-08-12: `records`
-- already carries 26 user triggers, `files` 2, `mos_assets` 2, and
-- `document_links` none. An API-layer sync would silently miss every path that
-- does not go through it; an async queue would reintroduce exactly the
-- staleness Phase 2 exists to remove. A trigger is the only mechanism that
-- sees every writer and shares the writer's transaction.
--
-- ── THE STRUCTURAL INSIGHT ─────────────────────────────────────────────────
-- Every source belongs to exactly ONE target (model_id, record_id):
--   field       the record it lives on
--   attachment  files.model_id / files.record_id
--   manual      document_links.model_id / document_links.record_id
--   marketing   (all_projects, mos_assets.project_id)
-- and edge identity is (file_id, model_id, record_id, role), which CONTAINS the
-- target. Therefore EDGES ARE PARTITIONED BY TARGET: two different targets can
-- never share an edge. That gives a correct scoping unit (recompute one target,
-- never the whole graph) and a correct lock granularity (one lock per target is
-- exactly a lock over the complete set of that target's edge identities).
-- `smoke_file_link_sync.sql` part 2.1 asserts the partition property directly.
--
-- ── WHY CONVERGENCE IS DEFERRED TO COMMIT (measured, not assumed) ──────────
-- The obvious design — converge the target inside the row trigger, taking a
-- per-target advisory lock, sorting when an operation touches two targets —
-- WAS BUILT AND IT DEADLOCKS. Reproduced 11 times in 12 runs on PostgreSQL
-- 16.13 with two concurrent sessions:
--
--   ERROR: deadlock detected
--   DETAIL: Process 10874 waits for ExclusiveLock on advisory lock [...];
--           blocked by process 10873.
--           Process 10873 waits for ExclusiveLock on advisory lock [...];
--           blocked by process 10874.
--   CONTEXT: SQL statement "SELECT pg_advisory_xact_lock(r.k)"
--
-- pg_advisory_xact_lock is TRANSACTION-scoped. Sorting inside one call orders
-- only the locks that call takes; it says nothing about locks the same
-- transaction already took in earlier statements. A transaction therefore
-- accumulates its lock set in data-dependent order, and two transactions that
-- write the same two records in opposite order deadlock. That is not an exotic
-- shape: saving R1 then R2 while another session saves R2 then R1 is enough,
-- and one bulk UPDATE fires the trigger per row in scan order. Those
-- transactions did NOT deadlock before Phase 2, so an immediate per-target lock
-- is a regression, not a safeguard.
--
-- Deadlock-freedom requires a transaction to acquire its ENTIRE lock set in one
-- ascending batch. The full set is only known once the transaction stops
-- writing — so convergence runs from a DEFERRED CONSTRAINT TRIGGER at commit:
--
--   row triggers        mark the affected target(s) dirty. No locks. No reads
--                       of the projection. Cannot deadlock.
--   deferred drain      at COMMIT, takes every lock the transaction needs in
--                       one ascending batch, converges each dirty target once,
--                       and clears the set.
--
-- Lock order, obeyed by every path, giving a total order and therefore no cycle:
--      1. the global projection key   (SHARED normally, EXCLUSIVE for a bulk
--                                      transaction, so the two never interleave)
--      2. per-target keys, ASCENDING
--
-- A transaction dirtying more than FILE_LINK_BULK_TARGETS targets takes the
-- global key EXCLUSIVELY and no per-target keys at all. Without that, a 10,000
-- row import would hold 10,000 transaction-scoped advisory locks at once and
-- exhaust the shared lock table for the whole cluster.
--
-- Deferral is still fully transactional: a deferred constraint trigger runs
-- inside the committing transaction, so the projection commits or rolls back
-- with its source and there is no window in which they disagree. It also does
-- strictly LESS work than the immediate design — a target touched sixty times
-- in one transaction converges once.
--
-- THE ONE BEHAVIOURAL CONSEQUENCE, stated plainly: within a transaction that
-- has not yet committed, the projection still shows the pre-transaction state.
-- Nothing in the application reads it that way (the SPA, the API routes and the
-- workers all read it in a later request), but a migration or script that
-- writes a source and then reads `file_links` in the SAME transaction must call
-- `file_links_drain_dirty()` first. `file_links_reconcile()` is unaffected: it
-- runs in its own transaction.
--
-- ROLLBACK: at the foot of this file. It drops only Phase 2 objects; the
-- Phase 1 tables, backfill and reconciliation survive untouched.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- A. The scoped derivation.
--
-- The trigger must recompute ONE target; Phase 1's reconciler derives the WHOLE
-- graph. The tempting design is a single parameterised body where NULL means
-- "everything", so trigger and reconciler can never disagree. IT WAS BUILT AND
-- MEASURED, AND IT IS 400x TOO SLOW ON THE SAVE PATH. Per scoped call, same
-- body, ephemeral PostgreSQL 16.13:
--
--   formulation                                 13 rows    9,211 rows
--   -----------------------------------------   --------   -----------
--   plain equality, REQUIRED scope               0.074 ms     0.087 ms   O(1)
--   `p IS NULL OR col = p`      (SQL function)        --    620    ms
--   `p IS NULL OR col = p`      (plpgsql)             --     35    ms
--   `col BETWEEN coalesce(...)` (SQL function)        --    620    ms
--   `col BETWEEN coalesce(...)` (plpgsql)         0.115 ms     7.06 ms   O(N)
--   the same, force_custom_plan (plpgsql)         0.496 ms     6.82 ms   O(N)
--   one shared VIEW + equality pushdown               --     37    ms   O(N)
--
-- The identical SQL INLINE with constants costs 0.246 ms, so the cost is not
-- the query — it is that an OPTIONAL scope can never be planned as an equality
-- probe. Production `records` is 38,996 rows, and convergence derives three
-- times per save, so the shared-body design would have added hundreds of
-- milliseconds to every record save in the app.
--
-- So Phase 2 does NOT touch Phase 1's global functions. They stay byte-identical
-- — no regression to backfill or reconciliation, and a smaller rollback surface.
-- Phase 2 adds these scoped twins, whose scope is REQUIRED and matched by plain
-- equality, which is sargable even under a generic plan.
--
-- TWO TEXTS NOW EXIST, AND THE RISK IS THAT THEY DRIFT. That risk is not
-- managed by careful reading; it is managed by an executable proof. Part 2 of
-- `smoke_file_link_sync.sql` asserts, on every CI run, that the global function
-- equals the UNION of the scoped function over every target — in both
-- directions, for both the occurrence classifier and the live-source set. If
-- anyone edits one and not the other, CI fails.
--
-- WHY EVERY SAVE-PATH FUNCTION SETS `jit = 'off'` (measured):
-- PostgreSQL was JIT-COMPILING a query that returns ONE row. auto_explain on
-- a single scoped call:
--
--   Index Scan using records_pkey on records r   (actual rows=1)
--         Index Cond: (id = $2)
--   JIT: Functions: 65 ... Emission 72.262 ms, Total 96.908 ms
--
-- The plan is perfect and the query itself costs ~0.3 ms; the compilation costs
-- ~97 ms. Because JIT engages on an estimated-cost threshold, it switches on as
-- the table grows — which is exactly why this looked like an O(N) derivation
-- when it never was. Measured, 100 scoped calls on 9,211 records:
--
--   jit on   3,414 ms   (34.1 ms per call)
--   jit off     87 ms   ( 0.87 ms per call)      39x
--   converge_target: 112.6 ms -> 5.06 ms per target
--
-- `SET jit = 'off'` is per-function and changes nothing else in the database.
-- It belongs on every function the save path executes, because all of them are
-- small, single-target queries where compilation can only lose. Do NOT put it
-- on file_links_resync_all: that is a whole-graph pass where JIT may genuinely
-- pay, and it delegates per-target work to converge_target anyway.
--
-- Everything else is byte-for-byte the Phase 1 logic: same classification, same
-- source keys, same attachment rule, same exclusion of frozen models.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_link_field_occurrences_scoped(
  p_model_id uuid, p_record_id uuid
)
RETURNS TABLE (
  model_id uuid, model text, record_id uuid, field text, ftype text,
  raw_value text, declared_kind text, source_position int, role text, class text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
  WITH flds AS (
    SELECT m.id AS model_id, m.name AS model, fld->>'name' AS field, fld->>'type' AS ftype
      FROM public.models m,
           LATERAL jsonb_array_elements(m.schema->'sections') sec,
           LATERAL jsonb_array_elements(sec->'fields') fld
     WHERE m.is_hardcoded IS NOT TRUE
       AND fld->>'type' = ANY (public.file_link_candidate_types())
       AND m.id = p_model_id
  ),
  raw AS (
    SELECT f.model_id, f.model, r.id AS record_id, f.field, f.ftype,
           x.v AS raw_value, x.kind AS declared_kind, x.pos AS source_position
      FROM flds f
      JOIN public.records r ON r.model_id = f.model_id
       AND r.id = p_record_id
      CROSS JOIN LATERAL (
        SELECT r.data->>f.field AS v, NULL::text AS kind, 0 AS pos
         WHERE jsonb_typeof(r.data->f.field) = 'string'
        UNION ALL
        SELECT r.data->f.field->>'id', r.data->f.field->>'type', 0
         WHERE jsonb_typeof(r.data->f.field) = 'object'
        UNION ALL
        SELECT CASE WHEN jsonb_typeof(e.val)='object' THEN e.val->>'id'
                    WHEN jsonb_typeof(e.val)='string' THEN e.val #>> '{}'
                    ELSE NULL END,
               CASE WHEN jsonb_typeof(e.val)='object' THEN e.val->>'type' ELSE NULL END,
               (e.ord-1)::int
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(r.data->f.field)='array'
                      THEN r.data->f.field ELSE '[]'::jsonb END
               ) WITH ORDINALITY AS e(val, ord)
      ) x
     WHERE x.v IS NOT NULL AND x.v <> ''
  )
  SELECT raw.model_id, raw.model, raw.record_id, raw.field, raw.ftype,
         raw.raw_value, raw.declared_kind, raw.source_position,
         public.file_link_role_for(raw.model, raw.field, raw.ftype),
         CASE
           WHEN raw.declared_kind = 'folder' THEN 'folder'
           WHEN raw.raw_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN CASE
                    WHEN EXISTS (SELECT 1 FROM public.files fi WHERE fi.id = raw.raw_value::uuid) THEN 'file'
                    WHEN EXISTS (SELECT 1 FROM public.folders fo WHERE fo.id = raw.raw_value::uuid) THEN 'folder'
                    ELSE 'dangling'
                  END
           WHEN raw.raw_value ~* '^(https?:)?//' OR raw.raw_value ~* '^data:' THEN 'external'
           ELSE 'invalid'
         END
    FROM raw;
$$;

CREATE OR REPLACE FUNCTION public.file_link_live_sources_scoped(
  p_model_id uuid, p_record_id uuid
)
RETURNS TABLE (
  source_key text, origin text, file_id uuid, model_id uuid, record_id uuid,
  role text, source_field text, source_position int
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
  WITH field_valid AS (
    SELECT o.model_id, o.record_id, o.raw_value::uuid AS file_id, o.field,
           o.source_position, o.role
      FROM public.file_link_field_occurrences_scoped(p_model_id, p_record_id) o
     WHERE o.class = 'file'
  ),
  tri AS (
    SELECT fv.file_id, fv.model_id, fv.record_id,
           count(DISTINCT fv.role) AS n_roles,
           min(fv.role)            AS only_role
      FROM field_valid fv
     GROUP BY 1,2,3
  )
  SELECT 'field:'||fv.model_id||':'||fv.record_id||':'||fv.field||':'||fv.source_position||':'||fv.file_id,
         'field', fv.file_id, fv.model_id, fv.record_id, fv.role, fv.field, fv.source_position
    FROM field_valid fv
  UNION ALL
  SELECT 'attachment:'||fi.id||':'||fi.model_id||':'||fi.record_id,
         'attachment', fi.id, fi.model_id, fi.record_id,
         CASE WHEN t.n_roles = 1 THEN t.only_role ELSE 'attachment' END,
         NULL, NULL
    FROM public.files fi
    LEFT JOIN tri t
      ON t.file_id = fi.id AND t.model_id = fi.model_id AND t.record_id = fi.record_id
   WHERE fi.record_id IS NOT NULL AND fi.model_id IS NOT NULL
     AND fi.model_id  = p_model_id
     AND fi.record_id = p_record_id
  UNION ALL
  SELECT 'manual:'||dl.file_id||':'||dl.model_id||':'||dl.record_id,
         'manual', dl.file_id, dl.model_id, dl.record_id,
         'supporting_document', NULL, NULL
    FROM public.document_links dl
   WHERE dl.model_id IS NOT NULL AND dl.record_id IS NOT NULL AND dl.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = dl.file_id)
     AND dl.model_id  = p_model_id
     AND dl.record_id = p_record_id
  UNION ALL
  SELECT 'marketing:'||a.id||':'||a.file_id||':'||mp.id||':'||a.project_id,
         'marketing', a.file_id, mp.id, a.project_id, 'marketing_asset', NULL, NULL
    FROM public.mos_assets a
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE a.file_id IS NOT NULL AND a.project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = a.file_id)
     AND mp.id        = p_model_id
     AND a.project_id = p_record_id;
$$;

-- ---------------------------------------------------------------------------
-- B. Concurrency control.
--
-- THE RACE (real, and NOT prevented by ON CONFLICT): under READ COMMITTED, T1
-- recomputes a target, sees no surviving source for edge E and deletes E, while
-- T2 concurrently inserts a source FOR E that T1 cannot see. T2's foreign-key
-- check takes only a KEY SHARE lock on E, so when T1's DELETE unblocks it
-- re-checks its qual against an UNCHANGED row using its ORIGINAL snapshot,
-- still sees no sources, and deletes E — cascading away T2's committed source.
-- No ON CONFLICT clause fixes that: the hazard is a read-then-delete decision
-- made on a stale snapshot, not an insert conflict.
--
-- The fix is mutual exclusion per target, taken in a deadlock-free order. See
-- the header for why that order can only be established at commit.
--
-- LOCK IDENTITY: the key is the TARGET, and edge identity contains the target,
-- so "same edge" implies "same target" implies "same lock" — the property that
-- actually matters. It is deliberately coarser than a per-edge lock, which is
-- not merely acceptable but REQUIRED: the legacy attachment's role is a
-- function of the other field roles on the same triple and must be recomputed
-- atomically with them.
--
-- COLLISIONS: hashtextextended packs the target into 64 bits, so two unrelated
-- targets can share a key. The consequence is bounded extra serialisation
-- between two records, never incorrect data — over-locking cannot corrupt.
-- Verified empirically: the whole suite still passes with the lock key degraded
-- to a constant (every target colliding).
--
-- It does NOT serialise unrelated relationships: distinct targets take distinct
-- keys, hold only the SHARED global key in common, and never block one another.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_link_target_lock_key(p_model_id uuid, p_record_id uuid)
RETURNS bigint LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT hashtextextended(p_model_id::text || ':' || p_record_id::text, 0) $$;

-- Rank 1 of the lock order. Held SHARED by ordinary transactions (so they do
-- not block each other) and EXCLUSIVE by a bulk transaction that has opted out
-- of per-target locks.
CREATE OR REPLACE FUNCTION public.file_link_global_lock_key()
RETURNS bigint LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT hashtextextended('wassell.file_links.projection', 0) $$;

-- Above this many distinct targets in ONE transaction, per-target locks are
-- replaced by a single exclusive global lock. Purely a lock-table budget: the
-- shared lock table is a fixed cluster-wide resource and a large import must
-- not be able to exhaust it.
CREATE OR REPLACE FUNCTION public.file_link_bulk_target_threshold()
RETURNS int LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT 100 $$;

-- The marketing branch filters mos_assets by project_id on every convergence.
-- files (model_id, record_id) and document_links (model_id, record_id) already
-- have covering indexes; mos_assets had none on project_id. 1,586 rows in
-- production, so this is instant to build and turns a scan into a probe.
CREATE INDEX IF NOT EXISTS idx_mos_assets_project ON public.mos_assets (project_id);

-- The per-transaction dirty set. UNLOGGED: it never survives a crash and never
-- needs to — it is scratch space whose lifetime is one transaction. Rows are
-- inserted by the row triggers and deleted by the drain; a rolled-back
-- transaction's rows vanish with it.
CREATE UNLOGGED TABLE IF NOT EXISTS public.file_link_dirty_targets (
  xid       xid8 NOT NULL,
  model_id  uuid NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (xid, model_id, record_id)
);
ALTER TABLE public.file_link_dirty_targets ENABLE ROW LEVEL SECURITY;
-- No policies: RLS with no policy denies everything. Only the SECURITY DEFINER
-- functions below touch this table, and they run as its owner.

-- ---------------------------------------------------------------------------
-- C. Convergence — recompute ONE target and diff it into place.
--
-- Never touches any other target. Never reads the whole graph. Assumes the
-- caller already holds the target's lock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_links_converge_target(p_model_id uuid, p_record_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
BEGIN
  IF p_model_id IS NULL OR p_record_id IS NULL THEN RETURN; END IF;

  -- 1. every edge the live sources require must exist
  INSERT INTO public.file_links (file_id, model_id, record_id, role)
  SELECT DISTINCT d.file_id, d.model_id, d.record_id, d.role
    FROM public.file_link_live_sources_scoped(p_model_id, p_record_id) d
  ON CONFLICT (file_id, model_id, record_id, role) DO NOTHING;

  -- 2. every live source is present and attached to the edge it actually
  --    proves. DO UPDATE (not DO NOTHING) because a source can legitimately
  --    move between edges when the attachment role is re-evaluated.
  INSERT INTO public.file_link_sources (link_id, origin, source_key, source_field, source_position)
  SELECT l.id, d.origin, d.source_key, d.source_field, d.source_position
    FROM public.file_link_live_sources_scoped(p_model_id, p_record_id) d
    JOIN public.file_links l
      ON l.file_id = d.file_id AND l.model_id = d.model_id
     AND l.record_id = d.record_id AND l.role = d.role
  ON CONFLICT (source_key) DO UPDATE
     SET link_id         = EXCLUDED.link_id,
         origin          = EXCLUDED.origin,
         source_field    = EXCLUDED.source_field,
         source_position = EXCLUDED.source_position;

  -- 3. drop projected sources of THIS target that no longer exist live
  DELETE FROM public.file_link_sources s
   USING public.file_links l
   WHERE s.link_id = l.id
     AND l.model_id = p_model_id AND l.record_id = p_record_id
     AND NOT EXISTS (
       SELECT 1 FROM public.file_link_live_sources_scoped(p_model_id, p_record_id) d
        WHERE d.source_key = s.source_key);

  -- 4. drop edges of THIS target that nothing proves any more
  DELETE FROM public.file_links l
   WHERE l.model_id = p_model_id AND l.record_id = p_record_id
     AND NOT EXISTS (SELECT 1 FROM public.file_link_sources s WHERE s.link_id = l.id);
END;
$$;

-- Mark a target for convergence at commit. This is ALL the row triggers do:
-- one indexed insert, no locks, no projection reads. It cannot deadlock and it
-- cannot block on another transaction's projection work.
CREATE OR REPLACE FUNCTION public.file_links_mark_dirty(p_model_id uuid, p_record_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
BEGIN
  IF p_model_id IS NULL OR p_record_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.file_link_dirty_targets (xid, model_id, record_id)
  VALUES (pg_current_xact_id(), p_model_id, p_record_id)
  ON CONFLICT DO NOTHING;
END;
$$;

-- Drain: take every lock this transaction needs in ONE ascending batch, then
-- converge each dirty target exactly once. Runs from the deferred constraint
-- trigger at commit; also callable by hand when a script must read the
-- projection before its own transaction ends.
CREATE OR REPLACE FUNCTION public.file_links_drain_dirty()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
DECLARE v_xid xid8 := pg_current_xact_id(); v_n int; r record;
BEGIN
  SELECT count(*) INTO v_n FROM public.file_link_dirty_targets WHERE xid = v_xid;
  IF v_n = 0 THEN RETURN 0; END IF;

  -- rank 1 of the lock order, always taken first
  IF v_n > public.file_link_bulk_target_threshold() THEN
    -- bulk: one exclusive lock instead of thousands, so the shared lock table
    -- cannot be exhausted by a large import
    PERFORM pg_advisory_xact_lock(public.file_link_global_lock_key());
  ELSE
    PERFORM pg_advisory_xact_lock_shared(public.file_link_global_lock_key());
    -- rank 2: every per-target lock, ASCENDING, in one batch. Because this is
    -- the only place a transaction takes target locks, and it takes all of them
    -- here, two transactions can never hold-and-wait in opposite order.
    FOR r IN
      SELECT public.file_link_target_lock_key(d.model_id, d.record_id) AS k
        FROM public.file_link_dirty_targets d
       WHERE d.xid = v_xid
       GROUP BY 1
       ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(r.k);
    END LOOP;
  END IF;

  FOR r IN SELECT d.model_id, d.record_id FROM public.file_link_dirty_targets d WHERE d.xid = v_xid
  LOOP
    PERFORM public.file_links_converge_target(r.model_id, r.record_id);
  END LOOP;

  DELETE FROM public.file_link_dirty_targets WHERE xid = v_xid;
  RETURN v_n;
END;
$$;

-- Converge one target on its own, taking the locks in canonical order. For
-- operators and tests; the trigger path uses mark_dirty + drain instead.
CREATE OR REPLACE FUNCTION public.file_links_sync_target(p_model_id uuid, p_record_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_model_id IS NULL OR p_record_id IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(public.file_link_global_lock_key());
  PERFORM pg_advisory_xact_lock(public.file_link_target_lock_key(p_model_id, p_record_id));
  PERFORM public.file_links_converge_target(p_model_id, p_record_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- D. Trigger functions — one per authoritative source, each exiting cheaply.
--    None of them reads or writes the projection; they only mark targets.
-- ---------------------------------------------------------------------------

-- records: the hot path. 26 other user triggers already run here, so the first
-- thing this does is the cheapest possible test, exactly as
-- tg_records_enqueue_translation does: if `data` is byte-identical the write
-- cannot have changed a file reference. Only then does it look at whether a
-- CANDIDATE field actually moved — an unrelated column or field change costs
-- one primary-key lookup on `models` and nothing else.
CREATE OR REPLACE FUNCTION public.tg_records_sync_file_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
DECLARE v_relevant boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The record's FIELD sources are gone. Attachment / manual / marketing
    -- sources for the same target live in other tables and still assert, so
    -- the recompute keeps them — which is why a deleted record can legitimately
    -- retain edges. Both-sides RLS already hides those from every reader.
    PERFORM public.file_links_mark_dirty(OLD.model_id, OLD.id);
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.data IS NOT DISTINCT FROM NEW.data THEN
    RETURN NULL;                                   -- cheapest exit
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.models m,
           LATERAL jsonb_array_elements(m.schema->'sections') sec,
           LATERAL jsonb_array_elements(sec->'fields') fld
     WHERE m.id = NEW.model_id
       AND m.is_hardcoded IS NOT TRUE
       AND fld->>'type' = ANY (public.file_link_candidate_types())
       AND (TG_OP = 'INSERT'
            OR (OLD.data->(fld->>'name')) IS DISTINCT FROM (NEW.data->(fld->>'name')))
  ) INTO v_relevant;

  IF NOT v_relevant THEN RETURN NULL; END IF;

  PERFORM public.file_links_mark_dirty(NEW.model_id, NEW.id);
  RETURN NULL;
END;
$$;

-- files: only the legacy attachment pair matters. A rename, a folder move or a
-- preview-status change must cost nothing.
CREATE OR REPLACE FUNCTION public.tg_files_sync_file_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.model_id  IS NOT DISTINCT FROM NEW.model_id
     AND OLD.record_id IS NOT DISTINCT FROM NEW.record_id THEN
    RETURN NULL;                                   -- cheapest exit
  END IF;

  IF TG_OP <> 'INSERT' THEN
    PERFORM public.file_links_mark_dirty(OLD.model_id, OLD.record_id);
  END IF;
  PERFORM public.file_links_mark_dirty(NEW.model_id, NEW.record_id);
  RETURN NULL;
END;
$$;

-- document_links: insert / delete / retarget. The table had no triggers at all
-- before this one.
CREATE OR REPLACE FUNCTION public.tg_document_links_sync_file_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.file_links_mark_dirty(OLD.model_id, OLD.record_id);
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.model_id  IS NOT DISTINCT FROM NEW.model_id
       AND OLD.record_id IS NOT DISTINCT FROM NEW.record_id
       AND OLD.file_id   IS NOT DISTINCT FROM NEW.file_id THEN
      RETURN NULL;
    END IF;
    PERFORM public.file_links_mark_dirty(OLD.model_id, OLD.record_id);
  END IF;
  PERFORM public.file_links_mark_dirty(NEW.model_id, NEW.record_id);
  RETURN NULL;
END;
$$;

-- mos_assets: the Marketing Library sidecar. Only file_id / project_id matter;
-- a title, ref or aspect-ratio edit must cost nothing. Touches no Marketing
-- permission and no Phase 0 canonical-storage behaviour.
CREATE OR REPLACE FUNCTION public.tg_mos_assets_sync_file_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
DECLARE v_ap uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.file_id    IS NOT DISTINCT FROM NEW.file_id
     AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id THEN
    RETURN NULL;                                   -- cheapest exit
  END IF;

  SELECT id INTO v_ap FROM public.models WHERE name = 'all_projects';
  IF v_ap IS NULL THEN RETURN NULL; END IF;

  IF TG_OP <> 'INSERT' THEN
    PERFORM public.file_links_mark_dirty(v_ap, OLD.project_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.file_links_mark_dirty(v_ap, NEW.project_id);
  END IF;
  RETURN NULL;
END;
$$;

-- The drain, wired to the end of the transaction.
CREATE OR REPLACE FUNCTION public.tg_file_links_drain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET jit = 'off'
AS $$
BEGIN
  PERFORM public.file_links_drain_dirty();
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- E. The triggers. AFTER ROW so the source row is already visible, and so a
--    BEFORE trigger that rewrites or rejects the row runs first (records has
--    six of those, including records_block_frozen_writes).
--
--    Deliberately NOT created on file_links / file_link_sources — the
--    projection must carry no synchronisation trigger, or a sync could
--    re-enter itself. The smoke asserts that.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS records_sync_file_links        ON public.records;
CREATE TRIGGER records_sync_file_links
  AFTER INSERT OR UPDATE OR DELETE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_sync_file_links();

DROP TRIGGER IF EXISTS files_sync_file_links          ON public.files;
CREATE TRIGGER files_sync_file_links
  AFTER INSERT OR UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_sync_file_links();
-- No DELETE trigger on `files` on purpose: file_links.file_id is
-- ON DELETE CASCADE, so the edges and (via their own cascade) their sources
-- disappear with the file, and a field value still naming the dead uuid
-- re-classifies as 'dangling', which is not a live source. The projection is
-- already convergent without a trigger, and the smoke proves it.

DROP TRIGGER IF EXISTS document_links_sync_file_links ON public.document_links;
CREATE TRIGGER document_links_sync_file_links
  AFTER INSERT OR UPDATE OR DELETE ON public.document_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_document_links_sync_file_links();

DROP TRIGGER IF EXISTS mos_assets_sync_file_links     ON public.mos_assets;
CREATE TRIGGER mos_assets_sync_file_links
  AFTER INSERT OR UPDATE OR DELETE ON public.mos_assets
  FOR EACH ROW EXECUTE FUNCTION public.tg_mos_assets_sync_file_links();

-- The deferred drain. A CONSTRAINT TRIGGER is the only per-row trigger that can
-- be deferred to commit; it fires once per newly dirtied target, and the first
-- invocation drains the whole set so the rest are empty no-ops. It runs INSIDE
-- the committing transaction, so an error here still aborts the commit.
DROP TRIGGER IF EXISTS file_link_dirty_drain ON public.file_link_dirty_targets;
CREATE CONSTRAINT TRIGGER file_link_dirty_drain
  AFTER INSERT ON public.file_link_dirty_targets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.tg_file_links_drain();

-- ---------------------------------------------------------------------------
-- F. Operator recovery.
--
-- Phase 1's backfill only INSERTS, so it cannot undo drift accumulated while
-- the triggers were disabled. This converges EVERY target in both directions
-- and is the correct recovery after a disable window. It takes the global lock
-- EXCLUSIVELY — one lock for the whole run, so a whole-graph pass can never
-- exhaust the shared lock table. Service-role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_links_resync_all()
RETURNS TABLE (metric text, value bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r record; v_targets bigint := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(public.file_link_global_lock_key());

  FOR r IN
    SELECT DISTINCT model_id, record_id FROM public.file_link_live_sources()
    UNION
    SELECT DISTINCT model_id, record_id FROM public.file_links
  LOOP
    PERFORM public.file_links_converge_target(r.model_id, r.record_id);
    v_targets := v_targets + 1;
  END LOOP;

  RETURN QUERY
  SELECT 'targets_converged', v_targets
  UNION ALL SELECT 'semantic_edges',     (SELECT count(*) FROM public.file_links)
  UNION ALL SELECT 'source_occurrences', (SELECT count(*) FROM public.file_link_sources);
END;
$$;

-- ---------------------------------------------------------------------------
-- G. Function security — same posture as Phase 1.
--
-- Postgres grants EXECUTE to PUBLIC by default, so PUBLIC must be named
-- explicitly; revoking from `authenticated` alone would leave it open. A
-- trigger function is invoked by the system and does NOT require the writing
-- role to hold EXECUTE, so revoking it does not break the sync — the smoke
-- proves that by writing as a role with every grant removed.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.file_link_field_occurrences_scoped(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_link_live_sources_scoped(uuid,uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_converge_target(uuid,uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_sync_target(uuid,uuid)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_mark_dirty(uuid,uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_drain_dirty()                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_resync_all()                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_records_sync_file_links()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_files_sync_file_links()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_document_links_sync_file_links()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_mos_assets_sync_file_links()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_file_links_drain()                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_link_target_lock_key(uuid,uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_link_global_lock_key()                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_link_bulk_target_threshold()             FROM PUBLIC, anon, authenticated;
-- The dirty set is internal scratch reached only through the SECURITY DEFINER
-- functions above, which run as its owner. Nothing else needs a grant on it —
-- including service_role, which Supabase's ALTER DEFAULT PRIVILEGES would
-- otherwise hand full DML on a table whose rows drive convergence.
REVOKE ALL ON TABLE    public.file_link_dirty_targets                       FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.file_link_field_occurrences_scoped(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.file_link_live_sources_scoped(uuid,uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.file_links_sync_target(uuid,uuid)             TO service_role;
GRANT EXECUTE ON FUNCTION public.file_links_drain_dirty()                      TO service_role;
GRANT EXECUTE ON FUNCTION public.file_links_resync_all()                       TO service_role;

-- Same reason as Phase 1's file_links_reconcile(): a whole-graph convergence
-- pass legitimately runs for minutes and must not die on PostgREST's default.
-- MEASURED: 9,211 targets converge in 82 s, and production `records` is 38,996
-- rows, so 300 s was not enough headroom — it would have aborted the rollout's
-- very first step. 30 minutes is deliberate slack for a once-per-recovery call.
ALTER FUNCTION public.file_links_resync_all() SET statement_timeout = '1800s';

COMMIT;

-- ============================================================================
-- ROLLBACK — fast, and Phase 1 survives intact.
--
-- FASTEST (stops synchronising immediately, keeps every object):
--   ALTER TABLE public.records        DISABLE TRIGGER records_sync_file_links;
--   ALTER TABLE public.files          DISABLE TRIGGER files_sync_file_links;
--   ALTER TABLE public.document_links DISABLE TRIGGER document_links_sync_file_links;
--   ALTER TABLE public.mos_assets     DISABLE TRIGGER mos_assets_sync_file_links;
--
-- Disabling the four SOURCE triggers is sufficient and is the safe order:
-- nothing is marked dirty, so the deferred drain has nothing to do. Do NOT
-- disable only the drain trigger — that would let the dirty set accumulate
-- rows that are never cleared.
--
-- While disabled the projection drifts again exactly as in Phase 1, and
-- `file_links_reconcile()` reports that drift. `file_links_resync_all()`
-- converges it afterwards in BOTH directions; `file_links_backfill()` alone
-- would not, because it never deletes.
--
-- FULL (drops Phase 2 only — Phase 1 tables, backfill and reconciliation stay):
-- BEGIN;
-- DROP TRIGGER IF EXISTS records_sync_file_links        ON public.records;
-- DROP TRIGGER IF EXISTS files_sync_file_links          ON public.files;
-- DROP TRIGGER IF EXISTS document_links_sync_file_links ON public.document_links;
-- DROP TRIGGER IF EXISTS mos_assets_sync_file_links     ON public.mos_assets;
-- DROP TRIGGER IF EXISTS file_link_dirty_drain          ON public.file_link_dirty_targets;
-- DROP FUNCTION IF EXISTS public.tg_records_sync_file_links();
-- DROP FUNCTION IF EXISTS public.tg_files_sync_file_links();
-- DROP FUNCTION IF EXISTS public.tg_document_links_sync_file_links();
-- DROP FUNCTION IF EXISTS public.tg_mos_assets_sync_file_links();
-- DROP FUNCTION IF EXISTS public.tg_file_links_drain();
-- DROP FUNCTION IF EXISTS public.file_links_resync_all();
-- DROP FUNCTION IF EXISTS public.file_links_drain_dirty();
-- DROP FUNCTION IF EXISTS public.file_links_mark_dirty(uuid,uuid);
-- DROP FUNCTION IF EXISTS public.file_links_sync_target(uuid,uuid);
-- DROP FUNCTION IF EXISTS public.file_links_converge_target(uuid,uuid);
-- DROP TABLE    IF EXISTS public.file_link_dirty_targets;
-- DROP INDEX    IF EXISTS public.idx_mos_assets_project;
-- DROP FUNCTION IF EXISTS public.file_link_bulk_target_threshold();
-- DROP FUNCTION IF EXISTS public.file_link_global_lock_key();
-- DROP FUNCTION IF EXISTS public.file_link_target_lock_key(uuid,uuid);
-- -- restore the Phase 1 zero-arg functions to their standalone bodies BEFORE
-- -- dropping the scoped ones, or the wrappers are left dangling:
-- --   \i supabase/migrations/2026-08-10_file_links_projection.sql   (idempotent)
-- DROP FUNCTION IF EXISTS public.file_link_live_sources_scoped(uuid,uuid);
-- DROP FUNCTION IF EXISTS public.file_link_field_occurrences_scoped(uuid,uuid);
-- COMMIT;
-- ============================================================================
