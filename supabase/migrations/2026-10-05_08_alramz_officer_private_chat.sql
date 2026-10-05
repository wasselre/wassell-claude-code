-- Read the Al-Ramz officer's PRIVATE chat with the operations line as an
-- Al-Ramz source (2026-10-05).
--
-- Al-Ramz units update from WhatsApp only (operator decision 2026-10-05), and
-- their officer (عبدالعزيز المطلب, +966554081507) sends availability sheets and
-- price lists in the private chat with wassel_ops, not only in the broker
-- group — e.g. 2026-10-05 11:26 UTC: 3 PDFs + 4 images «تحديث اسعار ريا
-- النخيل الجديد المعتمد والمتبقي من الوحدات», answering our request that
-- morning. Same reader, same rules (company = Al-Ramz; only his incoming
-- messages are read; evidence must be verbatim; bookings move forward only).
-- read_through starts the morning of the request so those files are read.
-- The per-message trigger only fires for groups (@g.us); a private chat is
-- picked up by the 10-minute sweep (project_update_enqueue_groups).

INSERT INTO public.project_update_groups (chat_wid, label, company_ids, is_enabled, read_through)
VALUES ('966554081507@c.us', 'الرمز — عبدالعزيز المطلب (خاص)',
        ARRAY['dfe055a2-de6a-49e6-8502-14d10d6d6b62']::uuid[], true, '2026-10-05 07:00:00+00')
ON CONFLICT (chat_wid) DO NOTHING;
