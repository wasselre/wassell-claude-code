-- Configurable AI roles + script-writer rules as DATA. No model choice here is
-- final: the comparison harness (scripts/eval) decides defaults later. The
-- worker merges mos_settings.ai_roles over its code defaults at runtime.
INSERT INTO public.mos_settings (key, value) VALUES
  ('ai_roles', '{
     "script_writer":       {"provider":"anthropic","model":"claude-opus-5","params":{"max_tokens":6000,"thinking":"adaptive","effort":"high"}},
     "script_reviewer":     {"provider":"anthropic","model":"claude-sonnet-5","params":{"max_tokens":3000,"thinking":"adaptive","effort":"medium"}},
     "claim_classifier":    {"provider":"anthropic","model":"claude-haiku-4-5-20251001","params":{"max_tokens":1200}},
     "frame_describer":     {"provider":"anthropic","model":"claude-haiku-4-5-20251001","params":{"max_tokens":1500}},
     "shot_analyzer":       {"provider":"anthropic","model":"claude-sonnet-5","params":{"max_tokens":2500,"thinking":"adaptive","effort":"medium"}},
     "reference_explainer": {"provider":"anthropic","model":"claude-haiku-4-5-20251001","params":{"max_tokens":800}},
     "embed_text":          {"provider":"modal","model":"bge-m3","version":"1"},
     "embed_image":         {"provider":"modal","model":"siglip2-base-patch16-256","version":"1"}
   }'::jsonb),
  ('script_writer_rules', '{
     "marketer_name": "وصل العقارية",
     "cta_default": "للحجز والاستفسار: وصل العقارية",
     "allow_developer_name": true,
     "numerals_on_screen": "arabic_indic",
     "hook_style": "question_or_variety_or_price_never_greeting",
     "forbidden_claim_classes": ["return","financing","yield"],
     "max_exemplar_overlap_words": 12
   }'::jsonb),
  ('script_writer_v2', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
