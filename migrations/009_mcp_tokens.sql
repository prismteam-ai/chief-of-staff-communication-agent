-- 009_mcp_tokens.sql — per-user Cursor/MCP personal access tokens.
-- The MCP surface resolves its tenant from WHO authenticates, not a hardcoded
-- MCP_OWNER_ID pin. A user signs into the web UI (Supabase auth), mints a token
-- here bound to their owner_id, and pastes it into Cursor's mcp.json. The MCP maps
-- token -> owner_id -> tenant. Long-lived + revocable (no ~1h JWT expiry).
create table if not exists mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  token        text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists mcp_tokens_active_idx on mcp_tokens(token) where revoked_at is null;
create index if not exists mcp_tokens_owner_idx on mcp_tokens(owner_id);

-- RLS defense-in-depth (the backend runs as service_role and enforces owner scoping
-- in the app layer; this policy is the belt-and-suspenders per the tenant-isolation rule).
alter table mcp_tokens enable row level security;
drop policy if exists mcp_tokens_owner on mcp_tokens;
create policy mcp_tokens_owner on mcp_tokens
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
