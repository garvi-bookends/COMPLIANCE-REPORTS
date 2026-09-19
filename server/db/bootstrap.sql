-- ===========================================================================
-- ONE-TIME BOOTSTRAP — creates the database and the application role.
--
-- This is the only step that needs the PostgreSQL superuser, which is why it
-- is a separate file you run by hand rather than part of `npm run migrate`.
--
-- NOTE: this needs the postgres *database* password. It does NOT need Windows
-- administrator rights.
--
-- HOW TO RUN IT (local PostgreSQL 18 on Windows)
--
--   1. Open pgAdmin 4
--        Start menu -> search "pgAdmin"
--        (or C:\Program Files\PostgreSQL\18\pgAdmin 4\runtime\pgAdmin4.exe)
--   2. In the left tree click "PostgreSQL 18". If it asks for a password,
--      that is the one you set while installing PostgreSQL.
--   3. Click the "postgres" database, then Tools -> Query Tool
--   4. Paste PART 1 below and run it (F5)
--   5. In the left tree right-click "Databases" -> Refresh.
--      Click the new "bookends" database, then Tools -> Query Tool again
--      (it must be a NEW Query Tool, connected to "bookends")
--   6. Paste PART 2 and run it (F5)
--
-- Then tell Claude "done", or run yourself:  npm run migrate && npm run seed
--
-- Why a dedicated role rather than using postgres directly: the app only ever
-- needs its own database, so it gets an account scoped to that. A leaked .env
-- then cannot touch anything else on the server.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- PART 1 — run while connected to the "postgres" database
-- ---------------------------------------------------------------------------

CREATE ROLE bookends_app LOGIN PASSWORD '7990';

CREATE DATABASE bookends OWNER bookends_app;

GRANT ALL PRIVILEGES ON DATABASE bookends TO bookends_app;


-- ---------------------------------------------------------------------------
-- PART 2 — run while connected to the "bookends" database
--
-- PostgreSQL 15 and later no longer let ordinary users create objects in the
-- public schema, so this has to be granted explicitly. Without it the
-- migration fails with "permission denied for schema public".
--
-- Ownership also matters for security: the owner of a table bypasses its
-- row-level security, which is what the backend needs while every other role
-- stays locked out.
-- ---------------------------------------------------------------------------

GRANT ALL ON SCHEMA public TO bookends_app;

ALTER SCHEMA public OWNER TO bookends_app;


-- ---------------------------------------------------------------------------
-- Check PART 2 worked. Expect:  bookends | bookends_app | t
-- ---------------------------------------------------------------------------

SELECT current_database()                                        AS database,
       nspowner::regrole::text                                   AS public_owner,
       has_schema_privilege('bookends_app', 'public', 'CREATE')  AS can_create
  FROM pg_namespace
 WHERE nspname = 'public';
