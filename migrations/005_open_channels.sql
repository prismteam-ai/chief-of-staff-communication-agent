-- 005: modular connector architecture — channels are open-ended, not a fixed
-- whitelist. Dropping the check means a new connector (telegram, discord, slack,
-- …) works with zero schema change. (Applied via MCP as 006_open_channels.)
alter table public.accounts drop constraint if exists accounts_channel_check;
