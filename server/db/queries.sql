-- Bookends Kitchen Compliance — reading the data in Supabase.
-- Paste any block into Supabase → SQL Editor. Every one of these is a read.

-- 1 ── What is in there, in one line per table
select 'accounts'            as holds, count(*) from app_users
union all select 'cleaning jobs',      count(*) from bk_tasks
union all select 'labels / expiry',    count(*) from bk_products
union all select 'services',           count(*) from bk_checklist
union all select 'job types',          count(*) from bk_job_types
union all select 'service history',    count(*) from bk_checklist_audit
union all select 'sign-in history',    count(*) from app_login_audit
union all select 'data wipes',         count(*) from app_admin_audit
order by 1;

-- 2 ── The people
select uid as login_id, name, role, coalesce(loc, 'all locations') as restaurant,
       case when disabled then 'disabled' when pending then 'waiting for approval' else 'active' end as state,
       last_login_at, created_at
from app_users
order by role, uid;

-- 3 ── Cleaning jobs, readable
select data->>'id'          as job_id,
       bk_tasks.loc         as restaurant,
       data->>'zone'        as area,
       data->>'area'        as job,
       data->>'status'      as status,
       case when data->>'approved' = 'true' then 'approved'
            when data->>'status' = 'rejected' then 'rejected'
            when data->>'status' = 'completed' then 'waiting for approval'
            else 'not done yet' end                    as stage,
       data->>'due'         as due_date,
       done.name            as done_by,
       to_timestamp((data->>'completedAt')::bigint / 1000) at time zone 'Asia/Kolkata' as done_at,
       appr.name            as decided_by,
       data->>'reject'      as rejection_reason
from bk_tasks
left join app_users done on done.id = data->>'completedBy'
left join app_users appr on appr.id = data->>'approvedBy'
order by (data->>'completedAt')::bigint desc nulls last
limit 200;

-- 4 ── Only the work waiting for the Super Admin
select data->>'id' as job_id, bk_tasks.loc as restaurant, data->>'area' as job,
       u.name as sent_by,
       to_timestamp((data->>'completedAt')::bigint / 1000) at time zone 'Asia/Kolkata' as sent_at,
       coalesce(data->>'before', data->>'after') as photo_url
from bk_tasks
left join app_users u on u.id = data->>'completedBy'
where data->>'status' = 'completed' and data->>'approved' is null
order by (data->>'completedAt')::bigint;

-- 5 ── EVERY PHOTO, from both kinds of record
-- The picture files live in the Vercel Blob store, not in this database.
-- What is kept here is the address of each one — open it in a browser.
select 'cleaning job' as came_from,
       data->>'id'    as record_id,
       loc            as restaurant,
       data->>'area'  as about,
       which          as slot,
       url            as photo_url,
       case when url like 'data:%' then 'still on the phone — not uploaded'
            else 'in the photo store' end as where_it_is
from bk_tasks,
     lateral (values ('before', data->>'before'), ('after', data->>'after')) as p(which, url)
where url is not null and url <> ''
union all
select 'label', data->>'id', loc, data->>'name', 'photo', data->>'photo',
       case when data->>'photo' like 'data:%' then 'still on the phone — not uploaded'
            else 'in the photo store' end
from bk_products
where data->>'photo' is not null and data->>'photo' <> ''
order by came_from, record_id;

-- 6 ── Labels and expiry dates
select data->>'id'      as label_id,
       bk_products.loc  as restaurant,
       data->>'name'    as product,
       data->>'cat'     as category,
       data->>'batch'   as batch,
       data->>'opened'  as made_on,
       data->>'expiry'  as expires_on,
       (data->>'expiry')::date - current_date as days_left,
       u.name           as entered_by,
       data->>'photo'   as photo_url
from bk_products
left join app_users u on u.id = data->>'by'
where coalesce(data->>'deleted', 'false') <> 'true'
order by (data->>'expiry')::date;

-- 7 ── The services, and who they are given to
select tkey as slot, coalesce(name, '(built-in)') as service, zone as area,
       case freq when 'D' then 'daily' when 'W' then 'weekly' when 'M' then 'monthly' end as how_often,
       case when custom then 'added' else 'built-in' end as origin,
       deleted as stopped, job_type, assignees, locs, edited_by, edited_at
from bk_checklist
order by custom desc, tkey;

-- 8 ── Every change ever made to a service
select at at time zone 'Asia/Kolkata' as when_it_happened,
       action, tkey as slot, prev_name as was, new_name as became,
       user_name as by_whom, user_role as their_role
from bk_checklist_audit
order by at desc
limit 100;

-- 9 ── Sign-ins, successful and not
select at at time zone 'Asia/Kolkata' as when_it_happened,
       uid as login_id, success, reason, ip
from app_login_audit
order by at desc
limit 100;

-- 10 ── Has anyone wiped the data? (this table is never wiped)
select at at time zone 'Asia/Kolkata' as when_it_happened,
       actor_uid as who, actor_role, ip, detail
from app_admin_audit
order by at desc;

-- 11 ── How each restaurant is doing
select loc as restaurant,
       count(*)                                                                as jobs,
       count(*) filter (where data->>'approved' = 'true')                      as approved,
       count(*) filter (where data->>'status' = 'completed' and data->>'approved' is null) as waiting,
       count(*) filter (where data->>'status' = 'rejected')                    as rejected,
       count(*) filter (where data->>'status' = 'pending')                     as still_to_do,
       count(*) filter (where data->>'status' = 'pending' and (data->>'due')::date < current_date) as overdue
from bk_tasks
group by loc
order by loc;

-- 12 ── One whole record, exactly as the app stores it
select jsonb_pretty(data) from bk_tasks    where data->>'before' is not null limit 1;
select jsonb_pretty(data) from bk_products limit 1;
