-- Competitor visual intelligence: Video → Shot → Frame, its own job queue, chunked
-- manifest ingest, hybrid search, cost ledger and health. Frames live in the
-- existing PUBLIC marketing-assets bucket under content/frame/<video_id>/ (the
-- storage model is unchanged by decision). RLS enabled, no policies: the API
-- reads/writes through the service client after a wassell_mkt_can gate; the Fly
-- worker and the Modal service use service_role.

-- ── videos ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_cv_videos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_media_id   uuid UNIQUE REFERENCES public.mkt_content_media(id) ON DELETE CASCADE,
  content_post_id    uuid REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  organization_id    uuid,
  owner              text NOT NULL DEFAULT 'competitor' CHECK (owner IN ('competitor','wassel')),
  wassel_asset_id    uuid,
  source_url         text,
  duration_ms        int,
  fps                numeric,
  width              int,
  height             int,
  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','processing','frames_done','analyzing','analyzed','failed','partial')),
  shot_count         int NOT NULL DEFAULT 0,
  frame_count        int NOT NULL DEFAULT 0,
  keyframe_count     int NOT NULL DEFAULT 0,
  detector_version   text,
  embedding_version  text,
  analysis_version   text,
  ocr_engine         text,
  structure          jsonb,
  cost_usd           numeric NOT NULL DEFAULT 0,
  error              text,
  processed_at       timestamptz,
  analyzed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_cv_videos_status ON public.mkt_cv_videos (status);
CREATE INDEX IF NOT EXISTS mkt_cv_videos_post ON public.mkt_cv_videos (content_post_id);

-- ── shots ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_cv_shots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id                uuid NOT NULL REFERENCES public.mkt_cv_videos(id) ON DELETE CASCADE,
  shot_no                 int NOT NULL,
  start_ms                int NOT NULL,
  end_ms                  int NOT NULL,
  duration_ms             int GENERATED ALWAYS AS (end_ms - start_ms) STORED,
  transition_in           text CHECK (transition_in IN ('cut','fade','dissolve','graphic','start')),
  transition_out          text CHECK (transition_out IN ('cut','fade','dissolve','graphic','end')),
  is_static               boolean NOT NULL DEFAULT false,
  is_micro                boolean NOT NULL DEFAULT false,
  internal_change         boolean NOT NULL DEFAULT false,
  edit_pace_local         numeric,
  representative_frame_id uuid,
  keyframe_ids            jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript_text         text,
  transcript_segments     jsonb,
  ocr_text                text,
  analysis                jsonb,
  tags                    text[] NOT NULL DEFAULT '{}',
  summary                 text,
  embedding_visual        extensions.vector(768),
  embedding_text          extensions.vector(1024),
  search_tsv              tsvector GENERATED ALWAYS AS (
                            to_tsvector('simple', coalesce(summary,'') || ' ' || coalesce(ocr_text,'') || ' ' || coalesce(transcript_text,''))) STORED,
  analysis_status         text NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending','done','failed')),
  analysis_error          text,
  analysis_cost_usd       numeric NOT NULL DEFAULT 0,
  analysis_role           jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, shot_no)
);
CREATE INDEX IF NOT EXISTS mkt_cv_shots_video ON public.mkt_cv_shots (video_id, shot_no);
CREATE INDEX IF NOT EXISTS mkt_cv_shots_tags ON public.mkt_cv_shots USING gin (tags);
CREATE INDEX IF NOT EXISTS mkt_cv_shots_tsv ON public.mkt_cv_shots USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS mkt_cv_shots_vis_hnsw ON public.mkt_cv_shots USING hnsw (embedding_visual extensions.vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS mkt_cv_shots_txt_hnsw ON public.mkt_cv_shots USING hnsw (embedding_text extensions.vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ── frames ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_cv_frames (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id       uuid NOT NULL REFERENCES public.mkt_cv_videos(id) ON DELETE CASCADE,
  shot_id        uuid REFERENCES public.mkt_cv_shots(id) ON DELETE SET NULL,
  frame_no       int,
  ts_ms          int NOT NULL,
  is_boundary    boolean NOT NULL DEFAULT false,
  is_keyframe    boolean NOT NULL DEFAULT false,
  dup_group_id   uuid,
  phash          text,
  storage_path   text,
  public_url     text,
  width          int,
  height         int,
  bytes          int,
  quality        jsonb,
  ocr            jsonb,
  labels         text[] NOT NULL DEFAULT '{}',
  embedding      extensions.vector(768),
  analysis       jsonb,
  described_at   timestamptz,
  describe_role  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, ts_ms)
);
CREATE INDEX IF NOT EXISTS mkt_cv_frames_shot ON public.mkt_cv_frames (shot_id, ts_ms);
CREATE INDEX IF NOT EXISTS mkt_cv_frames_labels ON public.mkt_cv_frames USING gin (labels);
CREATE INDEX IF NOT EXISTS mkt_cv_frames_hnsw ON public.mkt_cv_frames USING hnsw (embedding extensions.vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS public.mkt_cv_dup_groups (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id                uuid NOT NULL REFERENCES public.mkt_cv_videos(id) ON DELETE CASCADE,
  group_no                int NOT NULL,
  representative_frame_id uuid,
  size                    int NOT NULL DEFAULT 1,
  UNIQUE (video_id, group_no)
);

-- ── cost ledger (every paid call appends one row) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_cv_cost_ledger (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,        -- cv_process | frame_describe | shot_analyze | embed | ocr | describe_on_demand
  video_id    uuid,
  role        text,
  provider    text,
  model       text,
  cost_usd    numeric NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_cv_cost_ledger_time ON public.mkt_cv_cost_ledger (created_at DESC);

-- ── dedicated queue ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_cv_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('cv_process','cv_analyze','cv_describe_frame','cv_embed_wassel')),
  video_id          uuid REFERENCES public.mkt_cv_videos(id) ON DELETE CASCADE,
  frame_id          uuid REFERENCES public.mkt_cv_frames(id) ON DELETE CASCADE,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  priority          int NOT NULL DEFAULT 100,
  attempts          int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 3,
  next_run_at       timestamptz NOT NULL DEFAULT now(),
  worker_id         text,
  lease_expires_at  timestamptz,
  error             text,
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_cv_jobs_one_active
  ON public.mkt_cv_jobs (kind, video_id, COALESCE(frame_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS mkt_cv_jobs_claim ON public.mkt_cv_jobs (priority, next_run_at) WHERE status = 'queued';

ALTER TABLE public.mkt_cv_videos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_cv_shots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_cv_frames      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_cv_dup_groups  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_cv_cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_cv_jobs        ENABLE ROW LEVEL SECURITY;

INSERT INTO public.mkt_settings (key, value) VALUES
  ('cv.enabled', 'false'::jsonb),
  ('cv.daily_budget_usd', '30'::jsonb),
  ('cv.max_frames_per_video', '2000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── settings helpers ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_cv_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT (value)::boolean FROM public.mkt_settings WHERE key = 'cv.enabled'), false);
$$;
CREATE OR REPLACE FUNCTION public.mkt_cv_cost_today() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(sum(cost_usd), 0) FROM public.mkt_cv_cost_ledger
   WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh';
$$;
CREATE OR REPLACE FUNCTION public.mkt_cv_budget_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.mkt_cv_cost_today() < COALESCE((SELECT (value)::numeric FROM public.mkt_settings WHERE key = 'cv.daily_budget_usd'), 30);
$$;
CREATE OR REPLACE FUNCTION public.mkt_cv_cost_add(p_kind text, p_video_id uuid, p_role text, p_provider text, p_model text, p_cost numeric)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.mkt_cv_cost_ledger (kind, video_id, role, provider, model, cost_usd)
  VALUES (p_kind, p_video_id, p_role, p_provider, p_model, COALESCE(p_cost, 0));
  UPDATE public.mkt_cv_videos SET cost_usd = cost_usd + COALESCE(p_cost, 0), updated_at = now() WHERE id = p_video_id;
$$;

-- ── queue RPCs ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_cv_job_enqueue(p_kind text, p_video_id uuid, p_frame_id uuid, p_params jsonb DEFAULT '{}'::jsonb, p_priority int DEFAULT 100)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.mkt_cv_jobs
   WHERE kind = p_kind AND video_id IS NOT DISTINCT FROM p_video_id AND frame_id IS NOT DISTINCT FROM p_frame_id
     AND status IN ('queued','running') LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO public.mkt_cv_jobs (kind, video_id, frame_id, params, priority)
  VALUES (p_kind, p_video_id, p_frame_id, COALESCE(p_params, '{}'::jsonb), p_priority) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.mkt_cv_job_claim_next(p_worker_id text, p_kinds text[], p_lease_seconds int DEFAULT 900)
RETURNS TABLE (job_id uuid, kind text, video_id uuid, frame_id uuid, params jsonb, attempts int, max_attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.mkt_cv_enabled() THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.mkt_cv_jobs j
     SET status = 'running', worker_id = p_worker_id, started_at = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = j.attempts + 1
   WHERE j.id = (
     SELECT c.id FROM public.mkt_cv_jobs c
      WHERE c.status = 'queued' AND c.next_run_at <= now() AND c.kind = ANY(p_kinds)
      ORDER BY c.priority, c.next_run_at
      FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING j.id, j.kind, j.video_id, j.frame_id, j.params, j.attempts, j.max_attempts;
END; $$;

CREATE OR REPLACE FUNCTION public.mkt_cv_job_complete(p_job_id uuid, p_result jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mkt_cv_jobs SET status = 'completed', result = p_result, error = NULL, finished_at = now()
   WHERE id = p_job_id AND status = 'running';
$$;

-- fail: requeue with backoff while attempts remain; terminal failure otherwise.
CREATE OR REPLACE FUNCTION public.mkt_cv_job_fail(p_job_id uuid, p_error text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE j record;
BEGIN
  SELECT * INTO j FROM public.mkt_cv_jobs WHERE id = p_job_id AND status = 'running';
  IF NOT FOUND THEN RETURN 'noop'; END IF;
  IF j.attempts < j.max_attempts AND COALESCE(p_error,'') NOT LIKE 'budget_exceeded:%' AND COALESCE(p_error,'') NOT LIKE 'permanent:%' THEN
    UPDATE public.mkt_cv_jobs SET status = 'queued', error = LEFT(p_error, 2000), worker_id = NULL, lease_expires_at = NULL,
           next_run_at = now() + make_interval(mins => 2 * j.attempts) WHERE id = p_job_id;
    RETURN 'requeued';
  END IF;
  UPDATE public.mkt_cv_jobs SET status = 'failed', error = LEFT(p_error, 2000), finished_at = now() WHERE id = p_job_id;
  IF j.kind = 'cv_process' AND j.video_id IS NOT NULL THEN
    UPDATE public.mkt_cv_videos SET status = 'failed', error = LEFT(p_error, 500), updated_at = now() WHERE id = j.video_id AND status IN ('queued','processing');
  END IF;
  RETURN 'failed';
END; $$;

CREATE OR REPLACE FUNCTION public.mkt_cv_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n int := 0; r record;
BEGIN
  FOR r IN SELECT id FROM public.mkt_cv_jobs WHERE status = 'running' AND lease_expires_at < now() LOOP
    PERFORM public.mkt_cv_job_fail(r.id, 'watchdog: lease expired');
    n := n + 1;
  END LOOP;
  RETURN n;
END; $$;

-- ── enqueue a stored competitor video ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_cv_enqueue_video(p_content_media_id uuid, p_priority int DEFAULT 100)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE m record; v_id uuid; v_status text;
BEGIN
  SELECT cm.id, cm.content_post_id, cm.stored_url, cm.duration_ms, cm.width, cm.height, p.organization_id
    INTO m FROM public.mkt_content_media cm JOIN public.mkt_content_posts p ON p.id = cm.content_post_id
   WHERE cm.id = p_content_media_id AND cm.media_kind = 'video' AND cm.download_status = 'stored' AND cm.stored_url IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'permanent: media % is not a stored video', p_content_media_id; END IF;
  INSERT INTO public.mkt_cv_videos (content_media_id, content_post_id, organization_id, source_url, duration_ms, width, height)
  VALUES (m.id, m.content_post_id, m.organization_id, m.stored_url, m.duration_ms, m.width, m.height)
  ON CONFLICT (content_media_id) DO UPDATE SET source_url = EXCLUDED.source_url, updated_at = now()
  RETURNING id, status INTO v_id, v_status;
  IF v_status IN ('queued','failed','partial') THEN
    UPDATE public.mkt_cv_videos SET status = 'queued', error = NULL WHERE id = v_id;
    PERFORM public.mkt_cv_job_enqueue('cv_process', v_id, NULL, '{}'::jsonb, p_priority);
  END IF;
  RETURN v_id;
END; $$;

-- ── chunked manifest ingest ──────────────────────────────────────────────────
-- 1) video header + shots (idempotent upsert on (video_id, shot_no))
CREATE OR REPLACE FUNCTION public.mkt_cv_ingest_manifest(p_video_id uuid, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v jsonb := p_manifest->'video'; s jsonb; n_shots int := 0;
BEGIN
  UPDATE public.mkt_cv_videos
     SET status = 'processing',
         duration_ms = COALESCE((v->>'duration_ms')::int, duration_ms), fps = COALESCE((v->>'fps')::numeric, fps),
         width = COALESCE((v->>'width')::int, width), height = COALESCE((v->>'height')::int, height),
         detector_version = COALESCE(v->>'detector_version', detector_version),
         embedding_version = COALESCE(v->>'embedding_version', embedding_version),
         ocr_engine = COALESCE(v->>'ocr_engine', ocr_engine), updated_at = now()
   WHERE id = p_video_id;
  FOR s IN SELECT * FROM jsonb_array_elements(COALESCE(p_manifest->'shots', '[]'::jsonb)) LOOP
    INSERT INTO public.mkt_cv_shots (video_id, shot_no, start_ms, end_ms, transition_in, transition_out, is_static, internal_change, is_micro)
    VALUES (p_video_id, (s->>'shot_no')::int, (s->>'start_ms')::int, (s->>'end_ms')::int,
            NULLIF(s->>'transition_in',''), NULLIF(s->>'transition_out',''),
            COALESCE((s->>'is_static')::boolean, false), COALESCE((s->>'internal_change')::boolean, false),
            ((s->>'end_ms')::int - (s->>'start_ms')::int) < 400)
    ON CONFLICT (video_id, shot_no) DO UPDATE SET
      start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms, transition_in = EXCLUDED.transition_in,
      transition_out = EXCLUDED.transition_out, is_static = EXCLUDED.is_static, internal_change = EXCLUDED.internal_change,
      is_micro = EXCLUDED.is_micro, updated_at = now();
    n_shots := n_shots + 1;
  END LOOP;
  -- local editing pace: cuts per minute within ±5 s of each shot start
  UPDATE public.mkt_cv_shots t SET edit_pace_local = sub.pace
    FROM (SELECT a.id, (SELECT count(*) FROM public.mkt_cv_shots b WHERE b.video_id = a.video_id AND abs(b.start_ms - a.start_ms) <= 5000) * 6.0 AS pace
            FROM public.mkt_cv_shots a WHERE a.video_id = p_video_id) sub
   WHERE t.id = sub.id;
  RETURN jsonb_build_object('shots', n_shots);
END; $$;

-- 2) frames, in chunks (idempotent upsert on (video_id, ts_ms)); shot resolved by shot_no
CREATE OR REPLACE FUNCTION public.mkt_cv_ingest_frames(p_video_id uuid, p_frames jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE f jsonb; n int := 0; v_shot uuid;
BEGIN
  FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(p_frames, '[]'::jsonb)) LOOP
    SELECT id INTO v_shot FROM public.mkt_cv_shots WHERE video_id = p_video_id AND shot_no = (f->>'shot_no')::int;
    INSERT INTO public.mkt_cv_frames (video_id, shot_id, frame_no, ts_ms, is_boundary, phash, storage_path, public_url, width, height, bytes, quality, ocr, labels, embedding)
    VALUES (p_video_id, v_shot, (f->>'frame_no')::int, (f->>'ts_ms')::int, COALESCE((f->>'is_boundary')::boolean, false),
            f->>'phash', f->>'storage_path', f->>'public_url', (f->>'width')::int, (f->>'height')::int, (f->>'bytes')::int,
            f->'quality', f->'ocr',
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(COALESCE(f->'labels','[]'::jsonb)) x), '{}'),
            CASE WHEN f ? 'embedding' AND jsonb_typeof(f->'embedding') = 'array' THEN (f->'embedding')::text::extensions.vector ELSE NULL END)
    ON CONFLICT (video_id, ts_ms) DO UPDATE SET
      shot_id = EXCLUDED.shot_id, frame_no = EXCLUDED.frame_no, is_boundary = EXCLUDED.is_boundary, phash = EXCLUDED.phash,
      storage_path = EXCLUDED.storage_path, public_url = EXCLUDED.public_url, width = EXCLUDED.width, height = EXCLUDED.height,
      bytes = EXCLUDED.bytes, quality = EXCLUDED.quality, ocr = EXCLUDED.ocr, labels = EXCLUDED.labels,
      embedding = COALESCE(EXCLUDED.embedding, public.mkt_cv_frames.embedding);
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('frames', n);
END; $$;

-- 3) finalize: dup groups (frames carry dup_group ints via p_groups), representatives,
--    keyframes, inherited OCR, counts, status.
CREATE OR REPLACE FUNCTION public.mkt_cv_finalize_video(p_video_id uuid, p_groups jsonb, p_shot_keyframes jsonb, p_cost_usd numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE g jsonb; k jsonb; v_rep uuid; v_group uuid; v_frames int; v_shots int; v_keys int; v_shot uuid; v_ids jsonb; ts int;
BEGIN
  -- dup groups: {group, representative_ts_ms, members_ts_ms[], size}
  FOR g IN SELECT * FROM jsonb_array_elements(COALESCE(p_groups, '[]'::jsonb)) LOOP
    SELECT id INTO v_rep FROM public.mkt_cv_frames WHERE video_id = p_video_id AND ts_ms = (g->>'representative_ts_ms')::int;
    INSERT INTO public.mkt_cv_dup_groups (video_id, group_no, representative_frame_id, size)
    VALUES (p_video_id, (g->>'group')::int, v_rep, COALESCE((g->>'size')::int, 1))
    ON CONFLICT (video_id, group_no) DO UPDATE SET representative_frame_id = EXCLUDED.representative_frame_id, size = EXCLUDED.size
    RETURNING id INTO v_group;
    UPDATE public.mkt_cv_frames SET dup_group_id = v_group
     WHERE video_id = p_video_id AND ts_ms IN (SELECT (x)::int FROM jsonb_array_elements_text(COALESCE(g->'members_ts_ms','[]'::jsonb)) x);
    -- inherited OCR for non-representative members that carry none
    UPDATE public.mkt_cv_frames m SET ocr = jsonb_set(COALESCE(r.ocr, '{}'::jsonb), '{inherited_from}', to_jsonb(r.id))
      FROM public.mkt_cv_frames r
     WHERE r.id = v_rep AND m.dup_group_id = v_group AND m.id <> r.id AND (m.ocr IS NULL OR m.ocr = '{}'::jsonb) AND r.ocr IS NOT NULL;
  END LOOP;
  -- shot representatives + keyframes: [{shot_no, representative_ts_ms, keyframe_ts_ms:[...]}]
  UPDATE public.mkt_cv_frames SET is_keyframe = false WHERE video_id = p_video_id;
  FOR k IN SELECT * FROM jsonb_array_elements(COALESCE(p_shot_keyframes, '[]'::jsonb)) LOOP
    SELECT id INTO v_shot FROM public.mkt_cv_shots WHERE video_id = p_video_id AND shot_no = (k->>'shot_no')::int;
    SELECT id INTO v_rep FROM public.mkt_cv_frames WHERE video_id = p_video_id AND ts_ms = (k->>'representative_ts_ms')::int;
    v_ids := '[]'::jsonb;
    FOR ts IN SELECT (x)::int FROM jsonb_array_elements_text(COALESCE(k->'keyframe_ts_ms','[]'::jsonb)) x LOOP
      UPDATE public.mkt_cv_frames SET is_keyframe = true WHERE video_id = p_video_id AND ts_ms = ts RETURNING id INTO v_rep;
      IF v_rep IS NOT NULL THEN v_ids := v_ids || to_jsonb(v_rep); END IF;
    END LOOP;
    SELECT id INTO v_rep FROM public.mkt_cv_frames WHERE video_id = p_video_id AND ts_ms = (k->>'representative_ts_ms')::int;
    UPDATE public.mkt_cv_shots SET representative_frame_id = v_rep, keyframe_ids = v_ids, updated_at = now() WHERE id = v_shot;
  END LOOP;
  SELECT count(*) INTO v_frames FROM public.mkt_cv_frames WHERE video_id = p_video_id;
  SELECT count(*) INTO v_shots FROM public.mkt_cv_shots WHERE video_id = p_video_id;
  SELECT count(*) INTO v_keys FROM public.mkt_cv_frames WHERE video_id = p_video_id AND is_keyframe;
  UPDATE public.mkt_cv_videos SET status = 'frames_done', shot_count = v_shots, frame_count = v_frames, keyframe_count = v_keys,
         processed_at = now(), error = NULL, updated_at = now() WHERE id = p_video_id;
  IF COALESCE(p_cost_usd, 0) > 0 THEN PERFORM public.mkt_cv_cost_add('cv_process', p_video_id, 'embed_image', 'modal', NULL, p_cost_usd); END IF;
  RETURN jsonb_build_object('shots', v_shots, 'frames', v_frames, 'keyframes', v_keys);
END; $$;

-- ── search: RRF over visual / text / lexical channels (diversity in the API) ─
CREATE OR REPLACE FUNCTION public.mkt_cv_search(
  p_qvec_image extensions.vector(768), p_qvec_text extensions.vector(1024), p_query_text text,
  p_filters jsonb DEFAULT '{}'::jsonb, p_mode text DEFAULT 'shot', p_limit int DEFAULT 60)
RETURNS TABLE (
  shot_id uuid, video_id uuid, frame_id uuid, content_media_id uuid, content_post_id uuid, organization_id uuid, org_name text,
  owner text, platform text, published_at timestamptz, post_url text, stored_url text, start_ms int, end_ms int, duration_ms int,
  representative_frame_url text, summary text, tags text[], score numeric, why jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
  WITH base AS (
    SELECT s.*, v.content_media_id AS cmid, v.content_post_id AS cpid, v.organization_id AS org, v.owner AS vowner, v.source_url
      FROM public.mkt_cv_shots s JOIN public.mkt_cv_videos v ON v.id = s.video_id
     WHERE v.status IN ('frames_done','analyzing','analyzed','partial')
       AND (COALESCE((p_filters->>'exclude_micro')::boolean, true) = false OR NOT s.is_micro)
       AND (p_filters->>'organization_id' IS NULL OR v.organization_id = (p_filters->>'organization_id')::uuid)
       AND (p_filters->>'owner' IS NULL OR v.owner = p_filters->>'owner')
       AND (p_filters->>'min_duration_ms' IS NULL OR s.duration_ms >= (p_filters->>'min_duration_ms')::int)
       AND (p_filters->>'max_duration_ms' IS NULL OR s.duration_ms <= (p_filters->>'max_duration_ms')::int)
       AND (NOT (p_filters ? 'tags') OR s.tags @> (SELECT array_agg(x) FROM jsonb_array_elements_text(p_filters->'tags') x))
  ),
  vis AS (SELECT id, row_number() OVER (ORDER BY embedding_visual <=> p_qvec_image) AS rk, 1 - (embedding_visual <=> p_qvec_image) AS sim
            FROM base WHERE p_qvec_image IS NOT NULL AND embedding_visual IS NOT NULL ORDER BY embedding_visual <=> p_qvec_image LIMIT 200),
  txt AS (SELECT id, row_number() OVER (ORDER BY embedding_text <=> p_qvec_text) AS rk, 1 - (embedding_text <=> p_qvec_text) AS sim
            FROM base WHERE p_qvec_text IS NOT NULL AND embedding_text IS NOT NULL ORDER BY embedding_text <=> p_qvec_text LIMIT 200),
  lex AS (SELECT id, row_number() OVER (ORDER BY ts_rank(search_tsv, plainto_tsquery('simple', p_query_text)) DESC) AS rk,
                 ts_rank(search_tsv, plainto_tsquery('simple', p_query_text)) AS sim
            FROM base WHERE COALESCE(p_query_text,'') <> '' AND search_tsv @@ plainto_tsquery('simple', p_query_text) LIMIT 200),
  fused AS (
    SELECT id, sum(1.0 / (60 + rk)) AS score,
           jsonb_build_object('visual', max(CASE WHEN ch='vis' THEN sim END), 'text', max(CASE WHEN ch='txt' THEN sim END), 'lexical', max(CASE WHEN ch='lex' THEN sim END)) AS why
      FROM (SELECT id, rk, sim, 'vis' AS ch FROM vis UNION ALL SELECT id, rk, sim, 'txt' FROM txt UNION ALL SELECT id, rk, sim, 'lex' FROM lex) u
     GROUP BY id)
  SELECT b.id, b.video_id, b.representative_frame_id, b.cmid, b.cpid, b.org, o.name_ar, b.vowner, p.platform, p.published_at, p.post_url,
         b.source_url, b.start_ms, b.end_ms, b.duration_ms, f.public_url, b.summary, b.tags, fused.score::numeric, fused.why
    FROM fused JOIN base b ON b.id = fused.id
    LEFT JOIN public.mkt_cv_frames f ON f.id = b.representative_frame_id
    LEFT JOIN public.mkt_content_posts p ON p.id = b.cpid
    LEFT JOIN public.mkt_organizations o ON o.id = b.org
   ORDER BY fused.score DESC LIMIT GREATEST(p_limit, 1);
$$;

-- frame-mode search (exact look / text-in-frame)
CREATE OR REPLACE FUNCTION public.mkt_cv_search_frames(p_qvec_image extensions.vector(768), p_query_text text, p_filters jsonb DEFAULT '{}'::jsonb, p_limit int DEFAULT 60)
RETURNS TABLE (frame_id uuid, shot_id uuid, video_id uuid, ts_ms int, public_url text, labels text[], ocr_text text, score numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
  SELECT f.id, f.shot_id, f.video_id, f.ts_ms, f.public_url, f.labels, f.ocr->>'text',
         ((CASE WHEN p_qvec_image IS NOT NULL AND f.embedding IS NOT NULL THEN 1 - (f.embedding <=> p_qvec_image) ELSE 0 END)
          + (CASE WHEN COALESCE(p_query_text,'') <> '' AND COALESCE(f.ocr->>'text','') ILIKE '%' || p_query_text || '%' THEN 0.5 ELSE 0 END))::numeric AS score
    FROM public.mkt_cv_frames f JOIN public.mkt_cv_videos v ON v.id = f.video_id
   WHERE (p_filters->>'owner' IS NULL OR v.owner = p_filters->>'owner')
     AND (p_filters->>'organization_id' IS NULL OR v.organization_id = (p_filters->>'organization_id')::uuid)
     AND (f.dup_group_id IS NULL OR f.id = (SELECT representative_frame_id FROM public.mkt_cv_dup_groups d WHERE d.id = f.dup_group_id))
   ORDER BY score DESC LIMIT GREATEST(p_limit, 1);
$$;

-- ── detail + health ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_cv_shot(p_shot_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'shot', to_jsonb(s) - 'embedding_visual' - 'embedding_text' - 'search_tsv',
    'video', jsonb_build_object('id', v.id, 'content_media_id', v.content_media_id, 'content_post_id', v.content_post_id,
                                'organization_id', v.organization_id, 'org_name', o.name_ar, 'owner', v.owner, 'source_url', v.source_url,
                                'duration_ms', v.duration_ms, 'status', v.status, 'structure', v.structure),
    'post', (SELECT jsonb_build_object('platform', p.platform, 'post_url', p.post_url, 'published_at', p.published_at, 'caption', LEFT(p.caption, 300))
               FROM public.mkt_content_posts p WHERE p.id = v.content_post_id),
    'frames', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'ts_ms', f.ts_ms, 'public_url', f.public_url, 'is_keyframe', f.is_keyframe,
                 'is_boundary', f.is_boundary, 'labels', f.labels, 'ocr_text', f.ocr->>'text', 'has_analysis', f.analysis IS NOT NULL, 'dup_group_id', f.dup_group_id) ORDER BY f.ts_ms), '[]'::jsonb)
                 FROM public.mkt_cv_frames f WHERE f.shot_id = s.id),
    'neighbours', (SELECT COALESCE(jsonb_agg(jsonb_build_object('shot_no', n.shot_no, 'summary', n.summary, 'start_ms', n.start_ms) ORDER BY n.shot_no), '[]'::jsonb)
                     FROM public.mkt_cv_shots n WHERE n.video_id = s.video_id AND abs(n.shot_no - s.shot_no) = 1))
    FROM public.mkt_cv_shots s JOIN public.mkt_cv_videos v ON v.id = s.video_id LEFT JOIN public.mkt_organizations o ON o.id = v.organization_id
   WHERE s.id = p_shot_id;
$$;

CREATE OR REPLACE FUNCTION public.mkt_cv_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'enabled', public.mkt_cv_enabled(),
    'videos', (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) n FROM public.mkt_cv_videos GROUP BY status) x),
    'shots', (SELECT COALESCE(jsonb_object_agg(analysis_status, n), '{}'::jsonb) FROM (SELECT analysis_status, count(*) n FROM public.mkt_cv_shots GROUP BY analysis_status) x),
    'frames', (SELECT count(*) FROM public.mkt_cv_frames),
    'keyframes_described', (SELECT count(*) FROM public.mkt_cv_frames WHERE analysis IS NOT NULL),
    'jobs', (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT kind || ':' || status AS k, count(*) n FROM public.mkt_cv_jobs GROUP BY kind, status) x),
    'oldest_running_s', (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(started_at)))::int, 0) FROM public.mkt_cv_jobs WHERE status = 'running'),
    'cost_today_usd', public.mkt_cv_cost_today(),
    'cost_month_usd', (SELECT COALESCE(sum(cost_usd),0) FROM public.mkt_cv_cost_ledger WHERE created_at >= date_trunc('month', now())),
    'budget_usd', COALESCE((SELECT (value)::numeric FROM public.mkt_settings WHERE key='cv.daily_budget_usd'), 30),
    'budget_ok', public.mkt_cv_budget_ok());
$$;

-- grants: service_role for everything; authenticated may read health/shot/search through the API only
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'mkt_cv_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
