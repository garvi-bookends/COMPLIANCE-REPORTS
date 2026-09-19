'use strict';
/* ---------------------------------------------------------------------------
   Environment loading + validation.

   Every secret and every connection string comes from the environment
   (req 11). Nothing here has a usable default, and the process refuses to
   start if something required is missing or obviously still a placeholder.
   --------------------------------------------------------------------------- */

/* On Vercel every variable comes from the project settings. A .env file is
   never deployed (.vercelignore), and not reading one there means a stray
   copy could never quietly override the real values. */
var onVercel = !!process.env.VERCEL;
if (!onVercel) require('dotenv').config();

function required(name) {
  var v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error('Missing required environment variable ' + name + ' — copy .env.example to .env and fill it in.');
  }
  return String(v).trim();
}

function optional(name, fallback) {
  var v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v).trim();
}

function int(name, fallback) {
  var v = process.env[name];
  if (v === undefined || v === '') return fallback;
  var n = parseInt(v, 10);
  if (isNaN(n)) throw new Error('Environment variable ' + name + ' must be a number, got "' + v + '"');
  return n;
}

function bool(name, fallback) {
  var v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/* A secret that is short or still says "replace-me" is worse than no secret,
   because it looks configured. Refuse both. */
function secret(name) {
  var v = required(name);
  if (v.length < 32) {
    throw new Error(name + ' must be at least 32 characters. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  }
  if (/replace-me|change-me|your-secret|placeholder/i.test(v)) {
    throw new Error(name + ' still contains a placeholder value. Generate a real random secret.');
  }
  return v;
}

/* A secret that may be absent, but if present must meet the same bar. */
function optionalSecret(name) {
  var v = process.env[name];
  if (v === undefined || !String(v).trim()) return '';
  return secret(name);
}

/* Vercel sets NODE_ENV=production on every deployment, previews included. */
var NODE_ENV = optional('NODE_ENV', onVercel ? 'production' : 'development');
var isProd = NODE_ENV === 'production';

var config = {
  env: NODE_ENV,
  isProd: isProd,
  onVercel: onVercel,
  port: int('PORT', 3000),

  db: {
    connectionString: required('DATABASE_URL'),
    /* Neon and most managed Postgres require TLS, and present certificates
       Node already trusts — so the certificate is verified, which is what
       stops someone in the middle pretending to be the database.
       DATABASE_SSL_NO_VERIFY=true turns verification off for a provider
       whose chain Node does not ship (older Supabase poolers); the link is
       still encrypted, but only use it if you have to. */
    ssl: bool('DATABASE_SSL', true)
      ? { rejectUnauthorized: !bool('DATABASE_SSL_NO_VERIFY', false) }
      : false,
    /* One connection per Vercel instance: many instances can run at once,
       and Neon's pooler does the sharing. A long-running server keeps 10. */
    max: int('DATABASE_POOL_MAX', onVercel ? 1 : 10)
  },

  jwt: {
    secret: secret('JWT_SECRET'),
    /* Rotation: put the old JWT_SECRET here while a new one takes over, and
       access tokens signed with it keep working until they expire (15 min).
       Remove it afterwards. Refresh tokens are random database records, not
       JWTs, so rotating never signs anyone out. */
    previousSecret: optionalSecret('JWT_SECRET_PREVIOUS'),
    refreshSecret: secret('REFRESH_TOKEN_SECRET'),
    issuer: optional('JWT_ISSUER', 'bookends-compliance'),
    audience: optional('JWT_AUDIENCE', 'bookends-app'),
    accessTtl: optional('ACCESS_TOKEN_TTL', '15m'),
    refreshTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30)
  },

  password: {
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    defaultPassword: optional('DEFAULT_PASSWORD', '1234'),
    minLength: int('MIN_PASSWORD_LENGTH', 8)
  },

  lockout: {
    maxFailedAttempts: int('MAX_FAILED_ATTEMPTS', 8),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15)
  },

  corsOrigins: optional('CORS_ORIGINS', '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean),

  /* Vercel sends "Authorization: Bearer <CRON_SECRET>" with every scheduled
     call. Without it set, /api/cron/* refuses every caller. */
  cronSecret: optionalSecret('CRON_SECRET'),

  /* Vercel Blob store for cleaning and product photos. Without it,
     /api/photos answers 501 and photos stay on the device that took them. */
  blobToken: optional('BLOB_READ_WRITE_TOKEN', ''),

  seed: {
    adminUid: optional('SEED_ADMIN_UID', 'husen'),
    adminName: optional('SEED_ADMIN_NAME', 'Husen Khan'),
    adminPassword: optional('SEED_ADMIN_PASSWORD', '')
  }
};

/* The two secrets must not be the same value, or a refresh token would verify
   as an access token. */
if (config.jwt.secret === config.jwt.refreshSecret) {
  throw new Error('JWT_SECRET and REFRESH_TOKEN_SECRET must be different values.');
}
if (config.jwt.previousSecret && config.jwt.previousSecret === config.jwt.secret) {
  throw new Error('JWT_SECRET_PREVIOUS is the same as JWT_SECRET — it should hold the OLD value.');
}

/* Missing on Vercel is a misconfiguration worth shouting about, but not worth
   taking sign-in down for: each feature refuses on its own. */
if (onVercel) {
  if (!config.cronSecret) console.warn('[config] CRON_SECRET is not set — the daily cleanup will be refused');
  if (!config.blobToken) console.warn('[config] BLOB_READ_WRITE_TOKEN is not set — photos will stay on devices');
}

if (isProd && config.password.bcryptRounds < 10) {
  throw new Error('BCRYPT_ROUNDS must be at least 10 in production.');
}

module.exports = config;
