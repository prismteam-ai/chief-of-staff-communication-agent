-- 003: per-account provider tokens for connected channels (Connections flow)
create table if not exists connector_tokens (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  account_handle text not null,      -- e.g. the gmail address
  refresh_token text not null,
  scopes text,
  connected_at timestamptz not null default now(),
  unique (channel, account_handle)
);
