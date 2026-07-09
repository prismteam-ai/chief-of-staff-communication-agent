-- 002: persist provider correlation on sent drafts (chatot lifecycle: keep the
-- provider's message id so delivery/response feedback can be joined later)
alter table drafts add column if not exists provider_message_id text;
