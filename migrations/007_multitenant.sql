-- 007: real multi-tenancy — per-user data isolation.
--
-- Every tenant-scoped row carries owner_id = auth.users.id. The backend runs as
-- service_role and filters EXPLICITLY by owner (the real enforcement, since
-- service_role bypasses RLS). RLS policies (owner_id = auth.uid()) are
-- defense-in-depth for any auth-context / direct-client access (e.g. a future
-- browser client or a leaked anon path). owner_id stays nullable here; the
-- backfill step sets every row, then a follow-up sets NOT NULL.
--
-- Origin: 2026-07-09 audit found RLS enabled but ZERO policies + NO owner column
-- + every /api read via service_role → any logged-in user saw ALL data. That made
-- the "give a tester a separate account" plan a privacy leak, not isolation.

-- 1. ownership column on every tenant-scoped table
alter table accounts         add column if not exists owner_id uuid;
alter table threads          add column if not exists owner_id uuid;
alter table messages         add column if not exists owner_id uuid;
alter table recommendations  add column if not exists owner_id uuid;
alter table drafts           add column if not exists owner_id uuid;
alter table approvals        add column if not exists owner_id uuid;
alter table topic_links      add column if not exists owner_id uuid;
alter table asana_links      add column if not exists owner_id uuid;
alter table rag_documents    add column if not exists owner_id uuid;
alter table connector_tokens add column if not exists owner_id uuid;

-- 2. uniqueness becomes per-tenant (two users may each own the same handle/source)
alter table accounts      drop constraint if exists accounts_channel_handle_key;
alter table accounts      add  constraint accounts_owner_channel_handle_key unique (owner_id, channel, handle);
alter table rag_documents drop constraint if exists rag_documents_source_type_source_id_key;
alter table rag_documents add  constraint rag_documents_owner_source_key unique (owner_id, source_type, source_id);

-- 3. owner-first indexes for the hot read paths
create index if not exists idx_accounts_owner on accounts(owner_id);
create index if not exists idx_threads_owner  on threads(owner_id);
create index if not exists idx_messages_owner on messages(owner_id, answered_status, sent_at);
create index if not exists idx_drafts_owner   on drafts(owner_id, status);
create index if not exists idx_recs_owner     on recommendations(owner_id);
create index if not exists idx_topic_owner    on topic_links(owner_id);
create index if not exists idx_asana_owner    on asana_links(owner_id);
create index if not exists idx_rag_owner      on rag_documents(owner_id);
create index if not exists idx_tokens_owner   on connector_tokens(owner_id);

-- 4. RLS policies: tenant isolation (service_role bypasses; backend also filters)
do $$
declare t text;
begin
  foreach t in array array[
    'accounts','threads','messages','recommendations','drafts',
    'approvals','topic_links','asana_links','rag_documents','connector_tokens'
  ] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to authenticated '
      'using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- 5. rag_search must be owner-scoped — no cross-tenant vector leakage
create or replace function rag_search(
  query_embedding vector(1536), match_count int default 6, p_owner uuid default null
)
returns table (source_type text, source_id text, content text, metadata jsonb, similarity float)
language sql stable as $$
  select source_type, source_id, content, metadata,
         1 - (embedding <=> query_embedding) as similarity
  from rag_documents
  where embedding is not null
    and (p_owner is null or owner_id = p_owner)
  order by embedding <=> query_embedding
  limit match_count
$$;
