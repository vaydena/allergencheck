-- AllergenCheck: Abos (Rechnung/Überweisung) und Rechnungen.
-- Zugriff ausschließlich über die Edge Functions (direkte DB-Verbindung), nicht über die REST-API.
create extension if not exists pgcrypto;
create schema if not exists allergencheck;

create sequence if not exists allergencheck.invoice_seq;

create table if not exists allergencheck.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  token         text unique,                       -- AC-XXXXX-XXXXX-XXXXX, erst ab 1. Zahlung
  plan          text not null check (plan in ('month','year')),
  status        text not null default 'pending' check (status in ('pending','active','cancelled','revoked')),
  valid_until   date,
  company       text not null,
  name          text not null,
  email         text not null,
  billing       jsonb not null default '{}'::jsonb,
  consents      jsonb not null default '{}'::jsonb,
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  activated_at  timestamptz,
  cancelled_at  timestamptz,
  revoked_at    timestamptz,
  last_check_at timestamptz
);
create index if not exists ac_sub_email_idx on allergencheck.subscriptions (lower(email));
create index if not exists ac_sub_valid_idx on allergencheck.subscriptions (status, valid_until);

create table if not exists allergencheck.invoices (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique,            -- AC-YYYY-NNNN
  subscription_id uuid not null references allergencheck.subscriptions(id) on delete cascade,
  access_token    text not null unique default encode(gen_random_bytes(24), 'hex'),
  kind            text not null default 'first' check (kind in ('first','renewal')),
  plan            text not null check (plan in ('month','year')),
  amount_cents    integer not null check (amount_cents > 0),
  period_from     date,
  period_to       date,
  status          text not null default 'open' check (status in ('open','paid','cancelled')),
  created_at      timestamptz not null default now(),
  mailed_at       timestamptz,
  paid_at         timestamptz,
  cancelled_at    timestamptz
);
create index if not exists ac_inv_sub_idx on allergencheck.invoices (subscription_id, created_at desc);
create index if not exists ac_inv_status_idx on allergencheck.invoices (status, created_at);

create table if not exists allergencheck.rate_hits (
  bucket   text not null,
  iphash   text not null,
  reset_at timestamptz not null,
  hits     integer not null default 1,
  primary key (bucket, iphash)
);

create table if not exists allergencheck.order_attempts (
  id         bigserial primary key,
  ip_hash    text        not null,
  created_at timestamptz not null default now()
);
create index if not exists ac_order_attempts_idx on allergencheck.order_attempts (ip_hash, created_at);

-- Optional eigener Betreiber-Schlüssel; fehlt die Zeile, gilt der MediScan-Schlüssel (mediscan.admin_auth).
create table if not exists allergencheck.admin_auth (
  id            integer primary key default 1 check (id = 1),
  secret_sha256 text not null
);

do $$
declare t text;
begin
  foreach t in array array['subscriptions','invoices','rate_hits','order_attempts','admin_auth'] loop
    execute format('alter table allergencheck.%I enable row level security', t);
    execute format('revoke all on allergencheck.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence allergencheck.invoice_seq from anon, authenticated;
revoke usage on schema allergencheck from anon, authenticated;
