-- customer_contacts 匿名アクセス遮断（第1段）
-- 対象: bp-erp-pro (pkwajxeegidydalcannz)
-- 説明: docs/PROPOSAL_2026-09-28_CUSTOMER_CONTACTS_ANON_FIX.md
-- このファイルをそのまま実行しても、読み取り（1. 現状確認）しか動かない。
-- 適用・復元は石野さんの事前確認後、該当ブロックの封印を外して実行する。

-- ========== 1. 現状確認（読み取りのみ・適用前後に実行） ==========
select grantee, string_agg(privilege_type, ',' order by privilege_type) privs
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'customer_contacts'
group by grantee order by grantee;

select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'customer_contacts'
order by policyname;

-- 適用前の期待値:
--   anon          DELETE,INSERT,SELECT,UPDATE
--   authenticated DELETE,INSERT,SELECT,UPDATE
--   ポリシー4本すべて roles = {anon,authenticated}

-- ========== 2. 適用（封印中） ==========
/*
begin;
alter policy customer_contacts_select_policy on public.customer_contacts to authenticated;
alter policy customer_contacts_insert_policy on public.customer_contacts to authenticated;
alter policy customer_contacts_update_policy on public.customer_contacts to authenticated;
alter policy customer_contacts_delete_policy on public.customer_contacts to authenticated;
revoke select, insert, update, delete on public.customer_contacts from anon;
commit;
*/

-- ========== 3. 検証（適用後に実行・どちらもrollbackで終わる） ==========
/*
begin;
set local role anon;
select count(*) from public.customer_contacts;  -- 期待: ERROR permission denied
rollback;

begin;
set local role authenticated;
select count(*) from public.customer_contacts;  -- 期待: 1307前後
rollback;
*/

-- ========== 4. 復元（封印中・元の状態に戻す） ==========
/*
begin;
grant select, insert, update, delete on public.customer_contacts to anon;
alter policy customer_contacts_select_policy on public.customer_contacts to anon, authenticated;
alter policy customer_contacts_insert_policy on public.customer_contacts to anon, authenticated;
alter policy customer_contacts_update_policy on public.customer_contacts to anon, authenticated;
alter policy customer_contacts_delete_policy on public.customer_contacts to anon, authenticated;
commit;
*/
