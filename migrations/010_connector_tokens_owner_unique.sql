-- 010: connector_tokens uniqueness must be PER TENANT, not global.
-- The old UNIQUE(channel, account_handle) let one tenant's connect clobber another's
-- row (the Asana form hardcodes account_handle='asana', so a second tenant connecting
-- Asana would upsert-overwrite the first tenant's owner_id + token). Multi-tenancy
-- requires the account handle to be unique WITHIN an owner only.
alter table connector_tokens drop constraint if exists connector_tokens_channel_account_handle_key;
alter table connector_tokens
  add constraint connector_tokens_owner_channel_handle_key unique (owner_id, channel, account_handle);
