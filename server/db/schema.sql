-- ===========================================================================
-- Bookends Kitchen Compliance — authentication schema
--
-- Run once with:  npm run migrate
-- Safe to re-run: every statement is idempotent.
--
-- Design note: profiles (app_users) and secrets (app_user_credentials) are
-- deliberately in SEPARATE tables. Nothing that reads a profile can ever
-- accidentally select a password hash, and the roster endpoint physically
-- cannot leak one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. User profiles — the non-secret half of an account
-- ---------------------------------------------------------------------------
create table if not exists app_users (
  id                   text        primary key,
  uid                  text        not null unique,          -- login username, always lower case
  name                 text        not null,
  role                 text        not null default 'staff',
  loc                  text,                                  -- null = all locations
  first_login          boolean     not null default true,      -- req 6: first-login status
  must_change_password boolean     not null default true,
  last_login_at        timestamptz,                            -- req 6: last login date/time
  login_count          integer     not null default 0,
  disabled             boolean     not null default false,
  created_at           timestamptz not null default now(),     -- req 6: account creation date
  created_by           text,
  updated_at           timestamptz not null default now(),
  constraint app_users_uid_format check (uid ~ '^[a-z0-9]{2,32}$'),
  constraint app_users_role_valid check (
    role in ('superadmin','exec','aexec','admin','hok','manager','staff','auditor')
  )
);

-- Self sign-up. A person who creates their own account starts out pending:
-- they cannot sign in until the Super Admin approves them and sets their role.
-- Added with ALTER so an existing database picks it up on the next migrate.
alter table app_users add column if not exists pending boolean not null default false;

-- "Forgot password?" from the login screen sets this. The Super Admin sees it
-- on their dashboard and sets a new temporary password, which clears it.
alter table app_users add column if not exists reset_requested_at timestamptz;

-- Contact address. Optional, and NOT what anyone signs in with — the login id
-- stays the username, so adding this cannot lock anybody out.
alter table app_users add column if not exists email text;

-- Super Admin: the one account that approves self sign-ups.
-- The role list is widened by dropping and re-adding the check, so an existing
-- database picks it up on the next migrate.
alter table app_users drop constraint if exists app_users_role_valid;
alter table app_users add constraint app_users_role_valid check (
  role in ('superadmin','exec','aexec','admin','hok','manager','staff','auditor')
);

-- At most ONE Super Admin, enforced by the database itself rather than by
-- trusting every code path to check. A partial unique index over a constant
-- expression allows any number of other rows, but only one 'superadmin'.
create unique index if not exists app_users_one_superadmin
  on app_users ((true)) where role = 'superadmin';

-- ---------------------------------------------------------------------------
-- 2. Credentials — the secret half. Only the backend ever touches this.
-- ---------------------------------------------------------------------------
create table if not exists app_user_credentials (
  user_id             text        primary key references app_users(id) on delete cascade,
  password_hash       text        not null,                   -- bcrypt, cost 12. Never a plaintext password.
  password_updated_at timestamptz not null default now(),
  failed_attempts     integer     not null default 0,
  locked_until        timestamptz
);

-- ---------------------------------------------------------------------------
-- 3. Refresh tokens — makes a session revocable instead of only expiring
--    Only the SHA-256 of the token is stored, so a database dump cannot be
--    replayed as a live session.
-- ---------------------------------------------------------------------------
create table if not exists app_refresh_tokens (
  id         text        primary key,
  user_id    text        not null references app_users(id) on delete cascade,
  token_hash text        not null unique,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  ip         text
);

create index if not exists app_refresh_tokens_user on app_refresh_tokens (user_id);
create index if not exists app_refresh_tokens_exp  on app_refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- 4. Login audit trail
-- ---------------------------------------------------------------------------
create table if not exists app_login_audit (
  id         bigserial   primary key,
  at         timestamptz not null default now(),
  uid        text,
  user_id    text,
  success    boolean     not null,
  reason     text,
  ip         text,
  user_agent text
);

create index if not exists app_login_audit_at  on app_login_audit (at desc);
create index if not exists app_login_audit_uid on app_login_audit (uid);

-- ---------------------------------------------------------------------------
-- 4b. Rate-limit counters, shared by every server instance
--     (see server/middleware/rateLimit.js). Rows are short-lived; the cleanup
--     job deletes them once reset_at has passed.
-- ---------------------------------------------------------------------------
create table if not exists app_rate_limits (
  key      text        primary key,
  count    integer     not null default 0,
  reset_at timestamptz not null
);

create index if not exists app_rate_limits_reset on app_rate_limits (reset_at);

-- ---------------------------------------------------------------------------
-- 4c. Cleaning tasks and expiry products.
--
-- Same shape the app has always synced: the whole record as jsonb, plus the
-- location and a last-changed time lifted out so the server can filter on
-- them. Previously these tables sat in Supabase and the browser wrote to them
-- directly with a public key. Now only this backend touches them, through
-- /api/sync, which checks who is asking and which kitchen they belong to.
-- ---------------------------------------------------------------------------
create table if not exists bk_tasks (
  id         text        primary key,
  loc        text,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

create table if not exists bk_products (
  id         text        primary key,
  loc        text,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

create index if not exists bk_tasks_upd    on bk_tasks (updated_at);
create index if not exists bk_products_upd on bk_products (updated_at);
create index if not exists bk_tasks_loc    on bk_tasks (loc, updated_at);
create index if not exists bk_products_loc on bk_products (loc, updated_at);

-- ---------------------------------------------------------------------------
-- 4d. The cleaning checklist.
--
-- The built-in checklist lives in the app as a fixed list. A job is identified
-- by its slot in that list — 'W12' is the 13th weekly job — and that slot is
-- also the tail of every task id ('T-AKA-2026-W38-W12'), so a job keeps its
-- identity however it is renamed.
--
-- This table holds only the CHANGES to that list:
--   a built-in job that was renamed        name set, custom = false
--   a built-in job that was deleted        deleted = true
--   a job the Super Admin added            custom = true, with its own fields
--
-- Slots W0..W499 / M0..M499 belong to the built-in list; added jobs are given
-- W500 upwards, so a job added today can never collide with a job added to the
-- built-in list in a later release.
--
-- Deleting is a flag, never a DELETE. A job's slot must stay reserved: task
-- ids are built from it, so reusing a slot would silently re-label months of
-- recorded work. Setting the flag stops the job being generated from now on
-- and hides it from the live screens, while the cleaning already recorded
-- against it — photos, approvals, who did it — stays exactly as it was.
-- ---------------------------------------------------------------------------

-- Superseded by bk_checklist below, and never deployed with data in it.
drop table if exists bk_clean_name_audit;
drop table if exists bk_clean_names;

create table if not exists bk_checklist (
  tkey       text        primary key,
  name       text,                                    -- null on a built-in job that was only deleted
  zone       text,                                    -- added jobs only: which area of the kitchen
  freq       text,                                    -- added jobs only: 'W' weekly or 'M' monthly
  day        integer,                                 -- fixed weekday, 0 = Monday. null = spread across the week
  loc        text,                                    -- added jobs only. null = every kitchen
  custom     boolean     not null default false,
  deleted    boolean     not null default false,
  prev_name  text,
  created_by text,
  created_at timestamptz not null default now(),
  edited_by  text,
  edited_at  timestamptz,
  updated_at timestamptz not null default now(),
  constraint bk_checklist_tkey_format check (tkey ~ '^[WM][0-9]{1,3}$'),
  constraint bk_checklist_name_len    check (name is null or char_length(name) between 1 and 120),
  constraint bk_checklist_freq_valid  check (freq is null or freq in ('W', 'M')),
  constraint bk_checklist_day_valid   check (day is null or day between 0 and 6),
  -- an added job has to be complete enough to generate work from
  constraint bk_checklist_custom_full check (
    not custom or (name is not null and zone is not null and freq is not null)
  )
);

create index if not exists bk_checklist_upd on bk_checklist (updated_at);

-- Every change ever made to the checklist, append-only and separate from the
-- current state: what was done, to which job, by whom, and what it said before.
create table if not exists bk_checklist_audit (
  id        bigserial   primary key,
  at        timestamptz not null default now(),
  action    text        not null,                     -- add | rename | delete | restore
  tkey      text        not null,
  prev_name text,
  new_name  text,
  user_id   text,
  user_name text,
  user_role text,
  constraint bk_checklist_audit_action check (action in ('add', 'rename', 'edit', 'delete', 'restore'))
);

alter table bk_checklist_audit drop constraint if exists bk_checklist_audit_action;
alter table bk_checklist_audit add  constraint bk_checklist_audit_action
  check (action in ('add', 'rename', 'edit', 'delete', 'restore'));

create index if not exists bk_checklist_audit_at   on bk_checklist_audit (at desc);
create index if not exists bk_checklist_audit_tkey on bk_checklist_audit (tkey, at desc);

-- ---------------------------------------------------------------------------
-- 4e. Job types.
--
-- The group's work was only ever cleaning. A job type is the heading that work
-- sits under — Cleaning, Food Safety, Temperature Checking, anything the Super
-- Admin needs — so new kinds of scheduled work can be added without a release.
--
-- Cleaning is seeded here with the fixed key 'cleaning', because the built-in
-- checklist in the app belongs to it. It can be renamed or switched off like
-- any other, but its key never changes: every cleaning service ever recorded
-- points at it.
-- ---------------------------------------------------------------------------
create table if not exists bk_job_types (
  id          text        primary key,                -- slug: 'cleaning', 'food-safety', …
  name        text        not null,
  description text,
  active      boolean     not null default true,
  builtin     boolean     not null default false,     -- true = shipped with the app, cannot be removed
  sort        integer     not null default 100,
  created_by  text,
  created_at  timestamptz not null default now(),
  edited_by   text,
  edited_at   timestamptz,
  updated_at  timestamptz not null default now(),
  constraint bk_job_types_id_format check (id ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  constraint bk_job_types_name_len  check (char_length(name) between 1 and 60),
  constraint bk_job_types_desc_len  check (description is null or char_length(description) <= 300)
);

create index if not exists bk_job_types_upd on bk_job_types (updated_at);

-- Cleaning always exists: the built-in checklist belongs to it.
insert into bk_job_types (id, name, description, builtin, sort)
values ('cleaning', 'Cleaning', 'Kitchen deep-clean checklist — weekly and monthly jobs', true, 10)
on conflict (id) do nothing;

-- Which job type a service belongs to. Everything already recorded is
-- cleaning, which is why the default and the backfill are both 'cleaning'.
alter table bk_checklist add column if not exists job_type text not null default 'cleaning';
create index if not exists bk_checklist_type on bk_checklist (job_type);

-- A service may name the person responsible for it, the time of day it is due
-- and the date it stops. All optional: the cleaning checklist uses none of
-- them, and every job recorded before they existed is unaffected.
alter table bk_checklist add column if not exists assigned_to text;
alter table bk_checklist add column if not exists at_time    text;
alter table bk_checklist add column if not exists end_date   text;

-- Daily became possible when jobs stopped being only weekly or monthly.
alter table bk_checklist drop constraint if exists bk_checklist_freq_valid;
alter table bk_checklist add  constraint bk_checklist_freq_valid
  check (freq is null or freq in ('D', 'W', 'M'));


-- ---------------------------------------------------------------------------
-- 5. Lock these tables away from the browser.
--
-- The frontend holds a Supabase anon key. Enabling RLS with NO policies means
-- the anon and authenticated roles get ZERO access to these tables through
-- PostgREST. This backend connects as the table owner over a direct Postgres
-- connection, which bypasses RLS, so it keeps full access.
-- ---------------------------------------------------------------------------
alter table app_users            enable row level security;
alter table app_user_credentials enable row level security;
alter table app_refresh_tokens   enable row level security;
alter table app_login_audit      enable row level security;
alter table app_rate_limits      enable row level security;
alter table bk_tasks             enable row level security;
alter table bk_products          enable row level security;
alter table bk_checklist         enable row level security;
alter table bk_checklist_audit   enable row level security;
alter table bk_job_types         enable row level security;

-- A database that used to be the Supabase cloud-sync target still has the old
-- "anyone may do anything" policies on bk_tasks / bk_products. Drop them, so
-- RLS with no policy means no access for anon at all.
drop policy if exists bk_tasks_all    on bk_tasks;
drop policy if exists bk_products_all on bk_products;

-- Explicitly revoke from the roles PostgREST uses.
--
-- `anon` and `authenticated` exist only on Supabase. On a plain PostgreSQL
-- server they do not, and a bare REVOKE would abort the whole migration with
-- "role does not exist" — so each one is revoked only if it is actually
-- present. That keeps this file runnable on both a local server and Supabase.
do $$
declare
  r   text;
  tbl text;
begin
  for r in
    select rolname::text from pg_roles
     where rolname in ('anon', 'authenticated', 'service_role')
  loop
    for tbl in
      select unnest(array['app_users', 'app_user_credentials',
                          'app_refresh_tokens', 'app_login_audit',
                          'app_rate_limits', 'bk_tasks', 'bk_products',
                          'bk_checklist', 'bk_checklist_audit', 'bk_job_types'])
    loop
      execute format('revoke all on table %I from %I', tbl, r);
    end loop;
    raise notice 'revoked all access on the app_* tables from role %', r;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Retire the old plaintext-password table.
--
-- bk_users held { uid, pw, ... } as jsonb and was readable by any device
-- holding the anon key. The app no longer reads or writes it. Verify the
-- migration first, then run the DROP below by hand.
-- ---------------------------------------------------------------------------
-- drop table if exists bk_users;
