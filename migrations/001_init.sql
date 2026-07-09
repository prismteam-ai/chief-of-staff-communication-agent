-- 001_init: core message store, brain outputs, approval gate, RAG index
create extension if not exists vector;

-- one authenticated identity on a channel (brand x channel)
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('gmail','email','sms','whatsapp','x','linkedin')),
  handle text not null,               -- address / number / username
  display_name text,
  brand text,
  is_self boolean not null default false,  -- the executive's own identity on this channel
  created_at timestamptz not null default now(),
  unique (channel, handle)
);

create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  account_id uuid not null references accounts(id),
  external_thread_id text not null,   -- provider thread/conversation id
  subject text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, external_thread_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id),
  account_id uuid not null references accounts(id),
  channel text not null,
  external_id text not null,          -- provider message id
  direction text not null check (direction in ('inbound','outbound')),
  sender jsonb not null,              -- {handle, display_name}
  recipients jsonb not null default '[]',
  body_text text not null,
  attachments jsonb not null default '[]',
  sent_at timestamptz not null,       -- provider timestamp: starts the <5-min clock
  -- provenance: never dropped, cited by every downstream answer
  source_id text not null,            -- connector identifier
  fetched_at timestamptz not null,
  raw_ref text not null,              -- pointer to raw record (file/key)
  answered_status text not null default 'pending'
    check (answered_status in ('pending','answered','no_reply_needed')),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, external_id)
);
create index if not exists idx_messages_answered on messages(answered_status, sent_at);
create index if not exists idx_messages_thread on messages(thread_id, sent_at);

-- cross-channel association: same person/customer/project/decision
create table if not exists topic_links (
  id uuid primary key default gen_random_uuid(),
  topic_key text not null,            -- normalized topic slug
  message_id uuid not null references messages(id),
  reason text not null,
  confidence real not null default 0,
  created_at timestamptz not null default now(),
  unique (topic_key, message_id)
);

create table if not exists recommendations (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) unique,
  action text not null check (action in ('reply','create_task','link_task','delegate','archive','needs_context')),
  rationale text not null,
  needs_context boolean not null default false,
  context_question text,
  model text not null,
  created_at timestamptz not null default now()
);

create table if not exists drafts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id),
  body text not null,
  style_notes text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','sent')),
  model text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_drafts_status on drafts(status, created_at);

-- the human gate: a draft may only become 'sent' with an approval row
create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references drafts(id) unique,
  decision text not null check (decision in ('approved','rejected')),
  decided_by text not null,
  note text,
  decided_at timestamptz not null default now()
);

create table if not exists asana_links (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id),
  task_gid text not null,
  action text not null check (action in ('created','updated','linked')),
  task_url text not null,
  created_at timestamptz not null default now()
);

-- RAG index over comms + asana + preferences + org knowledge
create table if not exists rag_documents (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('message','asana','preference','org')),
  source_id text not null,
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (source_type, source_id)
);
create index if not exists idx_rag_embedding on rag_documents
  using hnsw (embedding vector_cosine_ops);

-- vector search rpc (supabase client calls this)
create or replace function rag_search(query_embedding vector(1536), match_count int default 6)
returns table (source_type text, source_id text, content text, metadata jsonb, similarity float)
language sql stable as $$
  select source_type, source_id, content, metadata,
         1 - (embedding <=> query_embedding) as similarity
  from rag_documents
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count
$$;

-- guard: sending requires an approval row with decision='approved'
create or replace function enforce_approval_gate()
returns trigger language plpgsql as $$
begin
  if new.status = 'sent' and not exists (
    select 1 from approvals where draft_id = new.id and decision = 'approved'
  ) then
    raise exception 'approval gate: draft % has no approval row', new.id;
  end if;
  return new;
end $$;

drop trigger if exists trg_approval_gate on drafts;
create trigger trg_approval_gate before update on drafts
  for each row when (new.status = 'sent') execute function enforce_approval_gate();
