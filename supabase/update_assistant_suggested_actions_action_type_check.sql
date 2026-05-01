-- Run this in the Supabase SQL editor if the live database should persist
-- field_observation as a first-class assistant_suggested_actions.action_type.
--
-- The app no longer depends on this migration: it can persist observation
-- intents through DB-safe action types plus metadata. This SQL simply keeps
-- the live check constraint aligned with supabase/schema.sql.

alter table public.assistant_suggested_actions
  drop constraint if exists assistant_suggested_actions_action_type_check;

alter table public.assistant_suggested_actions
  add constraint assistant_suggested_actions_action_type_check
  check (action_type in (
    'calendar_reminder',
    'finance_transaction',
    'inventory_item',
    'inventory_adjustment',
    'field_observation',
    'spray_record',
    'contact',
    'compliance_checklist',
    'market_watchlist',
    'livestock_medicine',
    'livestock_movement'
  ));

-- Inspect the check expression after replacement. The definition should include
-- 'field_observation'.
select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.assistant_suggested_actions'::regclass
  and conname = 'assistant_suggested_actions_action_type_check';
