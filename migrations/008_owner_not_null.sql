-- 008: harden tenant ownership — owner_id NOT NULL on every tenant-scoped table.
-- Ships WITH the multi-tenant code deploy (every write now stamps owner_id). Before
-- this, a writer that forgot to stamp owner_id silently created orphan null-owner rows
-- (observed 2026-07-09: the pre-deploy old Render code kept ingesting owner-less Gmail).
-- NOT NULL makes that a loud error instead of a silent privacy/data gap.
alter table accounts         alter column owner_id set not null;
alter table threads          alter column owner_id set not null;
alter table messages         alter column owner_id set not null;
alter table recommendations  alter column owner_id set not null;
alter table drafts           alter column owner_id set not null;
alter table approvals        alter column owner_id set not null;
alter table topic_links      alter column owner_id set not null;
alter table asana_links      alter column owner_id set not null;
alter table rag_documents    alter column owner_id set not null;
alter table connector_tokens alter column owner_id set not null;
