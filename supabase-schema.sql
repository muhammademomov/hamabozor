-- ============================================================================
-- ХАМАБОЗОР — схема базы данных для Supabase
-- ----------------------------------------------------------------------------
-- Как использовать:
-- 1. Зайдите в свой проект на supabase.com
-- 2. Слева откройте "SQL Editor" → "New query"
-- 3. Вставьте целиком этот файл и нажмите "Run"
-- ============================================================================

create table if not exists public.orders (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  customer_name   text not null,
  customer_phone  text not null,
  customer_address text,
  comment         text,
  items           jsonb not null default '[]'::jsonb,  -- [{name, qty, price}, ...]
  total           numeric not null default 0,
  status          text not null default 'new'
                    check (status in ('new','progress','done','cancel')),
  channel         text  -- 'whatsapp' или 'telegram' — куда изначально ушёл заказ
);

-- включаем защиту на уровне строк (Row Level Security)
alter table public.orders enable row level security;

-- любой посетитель сайта может СОЗДАТЬ заказ (форма оформления заказа)
create policy "Public can insert orders"
on public.orders
for insert
to anon
with check (true);

-- смотреть заказы может только вошедший в систему администратор
create policy "Authenticated can view orders"
on public.orders
for select
to authenticated
using (true);

-- менять статус заказа может только вошедший в систему администратор
create policy "Authenticated can update orders"
on public.orders
for update
to authenticated
using (true)
with check (true);

-- индекс для быстрой сортировки по дате (админка всегда сортирует по created_at)
create index if not exists orders_created_at_idx on public.orders (created_at desc);
