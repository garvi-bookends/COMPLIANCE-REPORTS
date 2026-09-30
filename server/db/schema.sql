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

-- ---------------------------------------------------------------------------
-- 4d. User Management extras: an email, and the job types a person works on
--     (a JSON list of job type ids; empty = every job type).
-- ---------------------------------------------------------------------------
alter table app_users add column if not exists email text;
alter table app_users add column if not exists job_types jsonb default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 4e. Job Management — the same tables the live site uses.
--
-- bk_job_types        Cleaning, Labelling, and any the Super Admin adds.
-- bk_checklist        one row per service slot ('W12', 'M3', 'W100'): every
--                     change to a built-in cleaning job, and every job added.
--                     Task ids are built from the slot, so it is never reused.
-- bk_checklist_audit  who added, renamed, edited, deleted or put back a job.
-- ---------------------------------------------------------------------------
create table if not exists bk_job_types (
  id          text        primary key,
  name        text        not null,
  description text,
  active      boolean     not null default true,
  builtin     boolean     not null default false,
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
insert into bk_job_types (id, name, description, builtin, sort) values
  ('cleaning',  'Cleaning',  'Kitchen deep-clean checklist — weekly and monthly jobs', true, 10),
  ('labelling', 'Labelling', 'Writing and applying product labels', true, 20),
  ('checklist', 'Checklist', 'Lunch, Dinner and Closing checklists — restaurant-wise', true, 30)
on conflict (id) do nothing;

create table if not exists bk_checklist (
  tkey        text        primary key,
  name        text,
  zone        text,
  freq        text,
  day         integer,
  loc         text,
  custom      boolean     not null default false,
  deleted     boolean     not null default false,
  prev_name   text,
  created_by  text,
  created_at  timestamptz not null default now(),
  edited_by   text,
  edited_at   timestamptz,
  updated_at  timestamptz not null default now(),
  job_type    text        not null default 'cleaning',
  assigned_to text,
  at_time     text,
  end_date    text,
  enabled     boolean     not null default false,
  locs        jsonb,
  assignees   jsonb,
  constraint bk_checklist_tkey_format check (tkey ~ '^[WM][0-9]{1,3}$'),
  constraint bk_checklist_name_len    check (name is null or char_length(name) between 1 and 120),
  constraint bk_checklist_day_valid   check (day is null or (day >= 0 and day <= 6)),
  constraint bk_checklist_freq_valid  check (freq is null or freq in ('D','W','M')),
  constraint bk_checklist_custom_full check (not custom or (name is not null and zone is not null and freq is not null))
);

create table if not exists bk_checklist_audit (
  id        bigserial   primary key,
  at        timestamptz not null default now(),
  action    text        not null,
  tkey      text        not null,
  prev_name text,
  new_name  text,
  user_id   text,
  user_name text,
  user_role text,
  constraint bk_checklist_audit_action check (action in ('add','rename','edit','delete','restore'))
);
create index if not exists bk_checklist_audit_at on bk_checklist_audit (at desc);

-- ---------------------------------------------------------------------------
-- 4f. Admin audit — every data wipe, who did it and what went. The time of
--     the latest wipe is also the sync "epoch": a device that last synced
--     before it drops its copy instead of uploading deleted records back.
-- ---------------------------------------------------------------------------
create table if not exists app_admin_audit (
  id         bigserial   primary key,
  at         timestamptz not null default now(),
  action     text        not null,
  actor_id   text,
  actor_uid  text,
  actor_role text,
  ip         text,
  detail     jsonb,
  constraint app_admin_audit_action check (action = 'wipe')
);

-- ---------------------------------------------------------------------------
-- 4g. Daily checklists — Lunch, Dinner and Closing
--
-- One row each time someone completes the in-app step of a checklist (sent
-- taken, inside the time window) before continuing to the Google Form. The
-- server decides the window from its own clock in IST. shift_date is the IST
-- date the window STARTED, so a Closing checklist done at 00:30 on 1 Oct is
-- recorded against the 30 Sep closing shift.
-- ---------------------------------------------------------------------------
create table if not exists app_checklists (
  id             text        primary key,
  user_id        text        references app_users(id) on delete set null,
  user_name      text        not null,
  loc            text,
  checklist_type text        not null,
  shift_date     date        not null,
  start_time     timestamptz not null,
  end_time       timestamptz not null,
  photo          text,       -- unused: checklists no longer take a photo
  status         text        not null default 'SUBMITTED',
  submitted_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint app_checklists_type_valid   check (checklist_type in ('LUNCH','DINNER','CLOSING')),
  constraint app_checklists_status_valid check (status in ('AVAILABLE','SUBMITTED','MISSED','CLOSED'))
);
-- Databases created while a photo was compulsory: it no longer is.
alter table app_checklists alter column photo drop not null;
-- The ticked checklist: one { section, question, done } per question.
alter table app_checklists add column if not exists answers jsonb;
alter table app_checklists drop constraint if exists app_checklists_photo_present;

create unique index if not exists app_checklists_one_per_shift
  on app_checklists (user_id, checklist_type, shift_date);
create index if not exists app_checklists_shift on app_checklists (shift_date desc, loc);

create index if not exists bk_tasks_upd    on bk_tasks (updated_at);
create index if not exists bk_products_upd on bk_products (updated_at);
create index if not exists bk_tasks_loc    on bk_tasks (loc, updated_at);
create index if not exists bk_products_loc on bk_products (loc, updated_at);

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
alter table bk_job_types         enable row level security;
alter table bk_checklist         enable row level security;
alter table bk_checklist_audit   enable row level security;
alter table app_admin_audit      enable row level security;
alter table app_checklists       enable row level security;

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
                          'bk_job_types', 'bk_checklist', 'bk_checklist_audit',
                          'app_admin_audit', 'app_checklists'])
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
