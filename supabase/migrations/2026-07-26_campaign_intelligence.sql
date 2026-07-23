-- ============================================================================
-- Cross-platform campaign intelligence. Groups ORGANIC content (IG/TikTok/
-- YouTube posts, reels, shorts, carousels) AND Meta PAID ads into unified
-- campaigns using DETERMINISTIC signals — never "same org/project alone".
--
-- Grouping key (stable + idempotent): sha1(org | project | distinguishing-signal)
-- where the distinguishing signal is the normalized offer, else the campaign
-- message, else the content objective. A project with no distinguishing signal
-- does NOT force-merge unrelated posts; two different offers for one project are
-- two campaigns. General branding (no project) is not campaigned. Reused
-- creatives (exact media checksum shared across items) are detected as evidence.
--
-- Manual corrections are respected: a member marked confirmed/rejected/moved is
-- never silently re-grouped by the worker.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mkt_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature       text NOT NULL UNIQUE,
  organization_id uuid NOT NULL,
  project_id      uuid,
  label           text,                 -- generated label
  manual_label    text,                 -- human rename (wins in UI)
  objective       text,
  platforms       text[] NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  first_seen_at   timestamptz,
  last_seen_at    timestamptz,
  member_count    int NOT NULL DEFAULT 0,
  organic_count   int NOT NULL DEFAULT 0,
  paid_count      int NOT NULL DEFAULT 0,
  offers          text[] NOT NULL DEFAULT '{}',
  payment_plans   text[] NOT NULL DEFAULT '{}',
  ctas            text[] NOT NULL DEFAULT '{}',
  key_message     text,
  reused_creatives int NOT NULL DEFAULT 0,
  confidence      numeric NOT NULL DEFAULT 0,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  grouping_version text NOT NULL DEFAULT 'cg-v1',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_campaigns_org_idx     ON public.mkt_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS mkt_campaigns_project_idx ON public.mkt_campaigns(project_id);

CREATE TABLE IF NOT EXISTS public.mkt_campaign_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES public.mkt_campaigns(id) ON DELETE CASCADE,
  member_type     text NOT NULL,        -- content | ad
  content_post_id uuid REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  paid_ad_id      uuid REFERENCES public.mkt_paid_ads(id) ON DELETE CASCADE,
  signals         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'auto',  -- auto | confirmed | rejected | moved
  added_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_campaign_members_type_check CHECK (member_type IN ('content','ad')),
  CONSTRAINT mkt_campaign_members_status_check CHECK (status IN ('auto','confirmed','rejected','moved'))
);
-- one campaign per content item / per ad at a time
CREATE UNIQUE INDEX IF NOT EXISTS mkt_campaign_members_content_uq ON public.mkt_campaign_members(content_post_id) WHERE content_post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_campaign_members_ad_uq      ON public.mkt_campaign_members(paid_ad_id) WHERE paid_ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_campaign_members_campaign_idx ON public.mkt_campaign_members(campaign_id);

CREATE TABLE IF NOT EXISTS public.mkt_campaign_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES public.mkt_campaigns(id) ON DELETE CASCADE,
  kind         text NOT NULL,  -- new_campaign|campaign_resumed|campaign_ended|new_platform|new_creative|creative_reused|offer_changed|landing_changed
  dedup_key    text NOT NULL UNIQUE,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_campaign_events_campaign_idx ON public.mkt_campaign_events(campaign_id, at DESC);

CREATE TABLE IF NOT EXISTS public.mkt_campaign_corrections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action       text NOT NULL,  -- move | merge | split | rename | reject | confirm
  campaign_id  uuid,
  to_campaign_id uuid,
  member_id    uuid,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  at           timestamptz NOT NULL DEFAULT now()
);

-- job kind
ALTER TABLE public.mkt_collection_jobs DROP CONSTRAINT IF EXISTS mkt_collection_jobs_kind_check;
ALTER TABLE public.mkt_collection_jobs ADD CONSTRAINT mkt_collection_jobs_kind_check CHECK (kind = ANY (ARRAY[
  'discover','discover_advertiser','organization_discovery','account_verification',
  'backfill','incremental','post_metrics','account_metrics','paid_ads','attribution','reprocess',
  'content_process','campaign_group'
]));

-- RLS
ALTER TABLE public.mkt_campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_campaign_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_campaign_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_campaign_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_campaigns_read        ON public.mkt_campaigns;
DROP POLICY IF EXISTS mkt_campaign_members_read ON public.mkt_campaign_members;
DROP POLICY IF EXISTS mkt_campaign_events_read  ON public.mkt_campaign_events;
DROP POLICY IF EXISTS mkt_campaign_corr_read    ON public.mkt_campaign_corrections;
CREATE POLICY mkt_campaigns_read        ON public.mkt_campaigns            FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_campaign_members_read ON public.mkt_campaign_members     FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_campaign_events_read  ON public.mkt_campaign_events      FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_campaign_corr_read    ON public.mkt_campaign_corrections FOR SELECT TO authenticated USING (true);

-- ── RPCs ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_campaign_upsert(
  p_signature text, p_org uuid, p_project uuid, p_label text, p_objective text,
  p_platforms text[], p_first timestamptz, p_last timestamptz, p_active boolean,
  p_offers text[], p_payment_plans text[], p_ctas text[], p_key_message text,
  p_reused int, p_confidence numeric, p_evidence jsonb, p_version text)
RETURNS TABLE(id uuid, was_inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_ins boolean := false;
BEGIN
  INSERT INTO public.mkt_campaigns(signature,organization_id,project_id,label,objective,platforms,first_seen_at,last_seen_at,is_active,offers,payment_plans,ctas,key_message,reused_creatives,confidence,evidence,grouping_version)
  VALUES (p_signature,p_org,p_project,p_label,p_objective,COALESCE(p_platforms,'{}'),p_first,p_last,COALESCE(p_active,true),COALESCE(p_offers,'{}'),COALESCE(p_payment_plans,'{}'),COALESCE(p_ctas,'{}'),p_key_message,COALESCE(p_reused,0),COALESCE(p_confidence,0),COALESCE(p_evidence,'{}'::jsonb),COALESCE(p_version,'cg-v1'))
  ON CONFLICT (signature) DO UPDATE SET
    project_id=COALESCE(EXCLUDED.project_id, mkt_campaigns.project_id),
    label=COALESCE(mkt_campaigns.manual_label, EXCLUDED.label),
    objective=EXCLUDED.objective, platforms=EXCLUDED.platforms,
    first_seen_at=LEAST(mkt_campaigns.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at=GREATEST(mkt_campaigns.last_seen_at, EXCLUDED.last_seen_at),
    is_active=EXCLUDED.is_active, offers=EXCLUDED.offers, payment_plans=EXCLUDED.payment_plans,
    ctas=EXCLUDED.ctas, key_message=EXCLUDED.key_message, reused_creatives=EXCLUDED.reused_creatives,
    confidence=EXCLUDED.confidence, evidence=EXCLUDED.evidence, updated_at=now()
  RETURNING mkt_campaigns.id, (xmax = 0) INTO v_id, v_ins;
  RETURN QUERY SELECT v_id, v_ins;
END $$;

-- Attach a member, RESPECTING manual status (confirmed/rejected/moved are never
-- re-grouped). Returns was_inserted so the caller can emit a new_creative event.
CREATE OR REPLACE FUNCTION public.mkt_campaign_member_upsert(
  p_campaign uuid, p_member_type text, p_content_post uuid, p_paid_ad uuid, p_signals jsonb)
RETURNS TABLE(id uuid, was_inserted boolean, moved boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing record; v_id uuid; v_ins boolean := false; v_moved boolean := false;
BEGIN
  SELECT * INTO v_existing FROM public.mkt_campaign_members
   WHERE (p_content_post IS NOT NULL AND content_post_id = p_content_post)
      OR (p_paid_ad IS NOT NULL AND paid_ad_id = p_paid_ad)
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    -- never override a human decision
    IF v_existing.status IN ('confirmed','rejected','moved') THEN
      RETURN QUERY SELECT v_existing.id, false, false; RETURN;
    END IF;
    IF v_existing.campaign_id <> p_campaign THEN v_moved := true; END IF;
    UPDATE public.mkt_campaign_members SET campaign_id=p_campaign, signals=COALESCE(p_signals,'{}'::jsonb)
     WHERE mkt_campaign_members.id=v_existing.id RETURNING mkt_campaign_members.id INTO v_id;
    RETURN QUERY SELECT v_id, false, v_moved; RETURN;
  END IF;
  INSERT INTO public.mkt_campaign_members(campaign_id,member_type,content_post_id,paid_ad_id,signals,status)
  VALUES (p_campaign,p_member_type,p_content_post,p_paid_ad,COALESCE(p_signals,'{}'::jsonb),'auto')
  RETURNING mkt_campaign_members.id INTO v_id; v_ins := true;
  RETURN QUERY SELECT v_id, v_ins, false;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_campaign_event_emit(p_campaign uuid, p_kind text, p_dedup text, p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_campaign_events(campaign_id,kind,dedup_key,payload)
  VALUES (p_campaign,p_kind,p_dedup,COALESCE(p_payload,'{}'::jsonb))
  ON CONFLICT (dedup_key) DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Recompute member/platform/count rollups from the members table.
CREATE OR REPLACE FUNCTION public.mkt_campaign_refresh_rollups(p_campaign uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.mkt_campaigns c SET
    member_count = (SELECT count(*) FROM mkt_campaign_members m WHERE m.campaign_id=c.id AND m.status<>'rejected'),
    organic_count = (SELECT count(*) FROM mkt_campaign_members m WHERE m.campaign_id=c.id AND m.member_type='content' AND m.status<>'rejected'),
    paid_count = (SELECT count(*) FROM mkt_campaign_members m WHERE m.campaign_id=c.id AND m.member_type='ad' AND m.status<>'rejected'),
    updated_at = now()
  WHERE c.id=p_campaign;
END $$;

-- Manual correction: move a member to another campaign (marks it 'moved' so the
-- grouper won't pull it back). Records an audit row.
CREATE OR REPLACE FUNCTION public.mkt_campaign_move_member(p_member uuid, p_to_campaign uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from uuid;
BEGIN
  SELECT campaign_id INTO v_from FROM mkt_campaign_members WHERE id=p_member;
  UPDATE mkt_campaign_members SET campaign_id=p_to_campaign, status='moved' WHERE id=p_member;
  INSERT INTO mkt_campaign_corrections(action,campaign_id,to_campaign_id,member_id,actor_user_id) VALUES ('move',v_from,p_to_campaign,p_member,p_actor);
  PERFORM mkt_campaign_refresh_rollups(v_from); PERFORM mkt_campaign_refresh_rollups(p_to_campaign);
END $$;

CREATE OR REPLACE FUNCTION public.mkt_campaign_set_member_status(p_member uuid, p_status text, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c uuid;
BEGIN
  UPDATE mkt_campaign_members SET status=p_status WHERE id=p_member RETURNING campaign_id INTO v_c;
  INSERT INTO mkt_campaign_corrections(action,campaign_id,member_id,detail,actor_user_id) VALUES (p_status,v_c,p_member,jsonb_build_object('status',p_status),p_actor);
  PERFORM mkt_campaign_refresh_rollups(v_c);
END $$;

CREATE OR REPLACE FUNCTION public.mkt_campaign_rename(p_campaign uuid, p_label text, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE mkt_campaigns SET manual_label=p_label, label=COALESCE(p_label,label), updated_at=now() WHERE id=p_campaign;
  INSERT INTO mkt_campaign_corrections(action,campaign_id,detail,actor_user_id) VALUES ('rename',p_campaign,jsonb_build_object('label',p_label),p_actor);
END $$;

-- Merge: repoint all members of src into dst, mark them moved, delete src.
CREATE OR REPLACE FUNCTION public.mkt_campaign_merge(p_src uuid, p_dst uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE mkt_campaign_members SET campaign_id=p_dst, status=CASE WHEN status='auto' THEN 'moved' ELSE status END WHERE campaign_id=p_src;
  INSERT INTO mkt_campaign_corrections(action,campaign_id,to_campaign_id,actor_user_id) VALUES ('merge',p_src,p_dst,p_actor);
  DELETE FROM mkt_campaigns WHERE id=p_src;
  PERFORM mkt_campaign_refresh_rollups(p_dst);
END $$;

GRANT EXECUTE ON FUNCTION public.mkt_campaign_upsert(text,uuid,uuid,text,text,text[],timestamptz,timestamptz,boolean,text[],text[],text[],text,int,numeric,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_member_upsert(uuid,text,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_event_emit(uuid,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_refresh_rollups(uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_move_member(uuid,uuid,uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_set_member_status(uuid,text,uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_rename(uuid,text,uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_merge(uuid,uuid,uuid) TO service_role, authenticated;
