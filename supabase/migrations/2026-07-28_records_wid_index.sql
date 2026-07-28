-- Index the conversation lookup that WA-01 put on the hot send path.
--
-- authorizeWhatsappSend resolves the conversation by `data->>'wid'` under the
-- caller's RLS before every send. `records` holds ~87,000 rows and had NO index
-- on that expression, so every send became a sequential scan with a per-row RLS
-- evaluation. On a busy database it hit the statement timeout, and the endpoint
-- reported `lookup_failed` and REFUSED the send.
--
-- A regression introduced by the authorization work itself: the check was
-- right, the access path was not. Seen live twice on 2026-07-28 -- a rep denied
-- at 13:10, and again on a verification send.
--
-- NOT a partial index on the chats model, which was the first attempt: a
-- partial index is only usable when the planner can PROVE the predicate holds,
-- and this lookup filters on wid alone -- it does not know the model. The
-- partial index was ignored and the plan stayed a seq scan. `wid` only exists
-- on chats rows, so a plain expression index is sparse in practice anyway.
--
-- Measured on production:
--   before  684 ms, 86,962 rows discarded, 195,273 buffers
--   after     0.15 ms, index scan, 3 buffers

CREATE INDEX IF NOT EXISTS records_wid_idx ON public.records ((data->>'wid'));

ANALYZE public.records;
