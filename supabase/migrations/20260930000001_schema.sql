-- Live Poll — database schema, security and server-side logic.
--
-- Design notes
--  * Participants and the presentation screen never touch tables directly for writes.
--    All writes go through SECURITY DEFINER functions that validate input.
--  * Raw responses and participants are NOT readable by the public (anon) role.
--    Only aggregates are exposed (get_results), plus the question content.
--  * Operator actions go through admin(pin, action, args); the PIN is stored as a
--    bcrypt hash and protected by a short lockout after repeated failures.
--  * No personal data or IP addresses are stored anywhere in this schema.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.app_config (
  id               int primary key default 1 check (id = 1),
  active_session_id uuid,
  pin_hash         text not null,
  failed_attempts  int not null default 0,
  locked_until     timestamptz,
  event_title      text not null,
  public_url       text,                       -- optional short URL shown under the QR code
  companies        jsonb not null default '[]', -- labels for the company tags on the screen
  template         jsonb not null              -- question content copied into each new session
);

create table public.sessions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  title      text not null,
  mode       text not null check (mode in ('test', 'live')),
  status     text not null default 'not_started' check (status in ('not_started', 'open', 'closed')),
  created_at timestamptz not null default now()
);

create table public.questions (
  id                    bigint generated always as identity primary key,
  session_id            uuid not null references public.sessions (id) on delete cascade,
  ord                   int not null,
  text                  text not null,
  hint                  text not null default '',
  type                  text not null check (type in ('single', 'multi')),
  min_choices           int not null default 1,
  max_choices           int not null default 1,
  shuffle               boolean not null default false,
  status                text not null default 'open' check (status in ('open', 'closed', 'hidden')),
  counts_for_completion boolean not null default true,
  unique (session_id, ord)
);

create table public.options (
  id          bigint generated always as identity primary key,
  question_id bigint not null references public.questions (id) on delete cascade,
  ord         int not null,
  text        text not null,
  exclusive   boolean not null default false,  -- selecting it clears/blocks all others
  pinned_last boolean not null default false,  -- always last on phone and at the bottom on screen
  unique (question_id, ord)
);

create table public.participants (
  session_id   uuid not null references public.sessions (id) on delete cascade,
  id           uuid not null,                  -- random device UUID generated in the browser
  joined_at    timestamptz not null default now(),
  completed_at timestamptz,
  primary key (session_id, id)
);

create table public.responses (
  id             bigint generated always as identity primary key,
  session_id     uuid not null,
  participant_id uuid not null,
  question_id    bigint not null references public.questions (id) on delete cascade,
  option_ids     bigint[] not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (participant_id, question_id),
  foreign key (session_id, participant_id) references public.participants (session_id, id) on delete cascade
);
create index responses_session_idx on public.responses (session_id);
create index responses_question_idx on public.responses (question_id);

create table public.annotations (
  id         bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  option_id  bigint not null references public.options (id) on delete cascade,
  label      text not null,
  created_at timestamptz not null default now()
);

create table public.presenter_state (
  session_id          uuid primary key references public.sessions (id) on delete cascade,
  current_page        int not null default 0,        -- 0 = QR page, N = question with ord N
  hidden_question_ids bigint[] not null default '{}', -- results hidden until "Show"
  sort_frozen         boolean not null default false,
  small_qr            boolean not null default true,
  theme               text not null default 'light' check (theme in ('light', 'dark')),
  timer_duration      int not null default 90,
  timer_remaining     numeric not null default 90,   -- seconds left at the last start/pause
  timer_started_at    timestamptz,                   -- not null while running
  timer_visible       boolean not null default false,
  updated_at          timestamptz not null default now()
);

-- A tiny row that changes on every vote/join. Screens subscribe to it via Realtime and
-- re-fetch aggregates (throttled) — this keeps raw responses private.
create table public.session_pulse (
  session_id uuid primary key references public.sessions (id) on delete cascade,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row level security & grants
-- ---------------------------------------------------------------------------

alter table public.app_config      enable row level security;
alter table public.sessions        enable row level security;
alter table public.questions       enable row level security;
alter table public.options         enable row level security;
alter table public.participants    enable row level security;
alter table public.responses       enable row level security;
alter table public.annotations     enable row level security;
alter table public.presenter_state enable row level security;
alter table public.session_pulse   enable row level security;

revoke all on public.app_config, public.participants, public.responses from anon, authenticated;
revoke insert, update, delete on public.sessions, public.questions, public.options,
  public.annotations, public.presenter_state, public.session_pulse from anon, authenticated;
grant select on public.sessions, public.questions, public.options, public.annotations,
  public.presenter_state, public.session_pulse to anon, authenticated;

create policy "public read" on public.sessions        for select using (true);
create policy "public read" on public.questions       for select using (true);
create policy "public read" on public.options         for select using (true);
create policy "public read" on public.annotations     for select using (true);
create policy "public read" on public.presenter_state for select using (true);
create policy "public read" on public.session_pulse   for select using (true);

-- Realtime change feeds (small, non-sensitive tables only)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.sessions, public.questions, public.presenter_state, public.annotations, public.session_pulse;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Pulse triggers
-- ---------------------------------------------------------------------------

create or replace function public.bump_pulse() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update session_pulse set version = version + 1, updated_at = now()
   where session_id = coalesce(new.session_id, old.session_id);
  return null;
end $$;

create trigger responses_pulse after insert or update or delete on public.responses
  for each row execute function public.bump_pulse();
create trigger participants_pulse after insert or update or delete on public.participants
  for each row execute function public.bump_pulse();

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by the public)
-- ---------------------------------------------------------------------------

create or replace function public._create_session(p_mode text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  cfg app_config;
  sid uuid;
  q   jsonb;
  o   jsonb;
  qid bigint;
  qi  int := 0;
  oi  int;
begin
  select * into cfg from app_config where id = 1;
  insert into sessions (name, title, mode)
    values (coalesce(nullif(trim(p_name), ''), initcap(p_mode) || ' session ' || to_char(now(), 'YYYY-MM-DD HH24:MI')),
            cfg.event_title, p_mode)
    returning id into sid;

  for q in select * from jsonb_array_elements(cfg.template) loop
    qi := qi + 1;
    insert into questions (session_id, ord, text, hint, type, min_choices, max_choices, shuffle, status, counts_for_completion)
      values (sid, qi, q->>'text', coalesce(q->>'hint', ''), q->>'type',
              coalesce((q->>'min')::int, 1), coalesce((q->>'max')::int, 1),
              coalesce((q->>'shuffle')::boolean, false), coalesce(q->>'status', 'open'),
              coalesce((q->>'counts_for_completion')::boolean, true))
      returning id into qid;
    oi := 0;
    for o in select * from jsonb_array_elements(q->'options') loop
      oi := oi + 1;
      insert into options (question_id, ord, text, exclusive, pinned_last)
        values (qid, oi, o->>'text', coalesce((o->>'exclusive')::boolean, false),
                coalesce((o->>'pinned_last')::boolean, false));
    end loop;
  end loop;

  insert into presenter_state (session_id) values (sid);
  insert into session_pulse (session_id) values (sid);
  update app_config set active_session_id = sid where id = 1;
  return sid;
end $$;

-- Recompute completion for one participant (answered every visible, counting question).
create or replace function public._refresh_completion(p_session uuid, p_pid uuid) returns void
language sql security definer set search_path = public as $$
  update participants p
     set completed_at = case
           when not exists (
             select 1 from questions q
              where q.session_id = p_session and q.counts_for_completion and q.status <> 'hidden'
                and not exists (select 1 from responses r where r.question_id = q.id and r.participant_id = p_pid))
           then coalesce(p.completed_at, now())
           else null end
   where p.session_id = p_session and p.id = p_pid;
$$;

-- ---------------------------------------------------------------------------
-- Public API: results (screen) and participant functions
-- ---------------------------------------------------------------------------

create or replace function public.get_results(p_session uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s uuid := coalesce(p_session, (select active_session_id from app_config where id = 1));
begin
  if s is null or not exists (select 1 from sessions where id = s) then
    return jsonb_build_object('session', null, 'server_time', now());
  end if;

  return jsonb_build_object(
    'server_time', now(),
    'public_url', (select public_url from app_config where id = 1),
    'session', (select jsonb_build_object('id', id, 'name', name, 'title', title, 'mode', mode, 'status', status)
                  from sessions where id = s),
    'connected', (select count(*) from participants where session_id = s),
    'started',   (select count(distinct participant_id) from responses where session_id = s),
    'completed', (select count(*) from participants where session_id = s and completed_at is not null),
    'pulse',     (select version from session_pulse where session_id = s),
    'presenter', (select to_jsonb(p) - 'session_id' from presenter_state p where p.session_id = s),
    'annotations', coalesce((
        select jsonb_agg(jsonb_build_object('id', a.id, 'option_id', a.option_id, 'label', a.label) order by a.created_at, a.id)
          from annotations a where a.session_id = s), '[]'::jsonb),
    'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', q.id, 'ord', q.ord, 'text', q.text, 'hint', q.hint, 'type', q.type,
                 'min', q.min_choices, 'max', q.max_choices, 'status', q.status,
                 'answered', (select count(*) from responses r where r.question_id = q.id),
                 'options', (select jsonb_agg(jsonb_build_object(
                                'id', o.id, 'ord', o.ord, 'text', o.text,
                                'exclusive', o.exclusive, 'pinned_last', o.pinned_last,
                                'votes', (select count(*) from responses r
                                           where r.question_id = q.id and o.id = any (r.option_ids)))
                              order by o.ord)
                               from options o where o.question_id = q.id))
               order by q.ord)
          from questions q where q.session_id = s), '[]'::jsonb)
  );
end $$;

-- Called when a phone opens the page (and on every state refresh).
-- Registers the device as "connected" and returns everything the phone needs.
create or replace function public.participant_sync(p_pid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sessions;
begin
  select se.* into s from sessions se join app_config c on c.active_session_id = se.id where c.id = 1;
  if not found then
    return jsonb_build_object('session', null, 'server_time', now());
  end if;

  if s.status <> 'closed' and p_pid is not null then
    insert into participants (session_id, id) values (s.id, p_pid) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'server_time', now(),
    'session', jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status),
    'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', q.id, 'ord', q.ord, 'text', q.text, 'hint', q.hint, 'type', q.type,
                 'min', q.min_choices, 'max', q.max_choices, 'status', q.status, 'shuffle', q.shuffle,
                 'options', (select jsonb_agg(jsonb_build_object(
                                'id', o.id, 'ord', o.ord, 'text', o.text,
                                'exclusive', o.exclusive, 'pinned_last', o.pinned_last) order by o.ord)
                               from options o where o.question_id = q.id))
               order by q.ord)
          from questions q where q.session_id = s.id and q.status <> 'hidden'), '[]'::jsonb),
    'answers', coalesce((
        select jsonb_object_agg(r.question_id::text, to_jsonb(r.option_ids))
          from responses r where r.session_id = s.id and r.participant_id = p_pid), '{}'::jsonb)
  );
end $$;

-- Submit (or update) the answer to one question. Idempotent per (participant, question).
create or replace function public.submit_answer(p_pid uuid, p_question bigint, p_options bigint[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q    questions;
  s    sessions;
  opts bigint[];
  n    int;
begin
  if p_pid is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select * into q from questions where id = p_question;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into s from sessions where id = q.session_id;
  if s.id is distinct from (select active_session_id from app_config where id = 1) then
    return jsonb_build_object('ok', false, 'reason', 'stale_session');
  end if;
  if s.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'poll_' || s.status);
  end if;
  if q.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'question_' || q.status);
  end if;

  opts := array(select distinct x from unnest(coalesce(p_options, '{}')) x order by x);
  n := coalesce(cardinality(opts), 0);

  if n < q.min_choices or n > q.max_choices then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if (select count(*) from options o where o.question_id = q.id and o.id = any (opts)) <> n then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if n > 1 and exists (select 1 from options o where o.id = any (opts) and o.exclusive) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  insert into participants (session_id, id) values (s.id, p_pid) on conflict do nothing;

  insert into responses (session_id, participant_id, question_id, option_ids)
    values (s.id, p_pid, q.id, opts)
    on conflict (participant_id, question_id)
    do update set option_ids = excluded.option_ids, updated_at = now()
     where responses.option_ids is distinct from excluded.option_ids;

  perform _refresh_completion(s.id, p_pid);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Operator API
-- ---------------------------------------------------------------------------

create or replace function public.admin(p_pin text, p_action text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg  app_config;
  sid  uuid;
  ps   presenter_state;
  v    text;
  d    int;
  res  jsonb;
begin
  select * into cfg from app_config where id = 1 for update;

  if cfg.locked_until is not null and cfg.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'retry_after', ceil(extract(epoch from cfg.locked_until - now())));
  end if;

  if p_pin is null or cfg.pin_hash <> crypt(p_pin, cfg.pin_hash) then
    update app_config
       set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
           locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '30 seconds' else locked_until end
     where id = 1;
    return jsonb_build_object('ok', false, 'error', 'bad_pin');
  end if;

  if cfg.failed_attempts <> 0 then
    update app_config set failed_attempts = 0 where id = 1;
  end if;

  sid := cfg.active_session_id;
  p_args := coalesce(p_args, '{}'::jsonb);

  case p_action

  when 'login', 'state' then
    null;

  when 'poll_status' then
    v := p_args->>'status';
    if v not in ('not_started', 'open', 'closed') then
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    update sessions set status = v where id = sid;

  when 'question_status' then
    v := p_args->>'status';
    if v not in ('open', 'closed', 'hidden') then
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    update questions set status = v where id = (p_args->>'question_id')::bigint and session_id = sid;
    -- visibility changes can change who counts as "completed"
    perform _refresh_completion(sid, p.id) from participants p where p.session_id = sid;

  when 'presenter' then
    update presenter_state set
      current_page = coalesce((p_args->>'current_page')::int, current_page),
      sort_frozen  = coalesce((p_args->>'sort_frozen')::boolean, sort_frozen),
      small_qr     = coalesce((p_args->>'small_qr')::boolean, small_qr),
      theme        = coalesce(p_args->>'theme', theme),
      updated_at   = now()
    where session_id = sid;

  when 'results_visibility' then
    update presenter_state set
      hidden_question_ids = case when (p_args->>'hidden')::boolean
            then array(select distinct unnest(hidden_question_ids || (p_args->>'question_id')::bigint))
            else array_remove(hidden_question_ids, (p_args->>'question_id')::bigint) end,
      updated_at = now()
    where session_id = sid;

  when 'timer' then
    select * into ps from presenter_state where session_id = sid for update;
    v := p_args->>'op';
    if v = 'start' then
      update presenter_state set
        timer_remaining  = case when timer_remaining <= 0 then timer_duration else timer_remaining end,
        timer_started_at = coalesce(timer_started_at, now()),
        timer_visible    = true, updated_at = now()
      where session_id = sid;
    elsif v = 'pause' then
      if ps.timer_started_at is not null then
        update presenter_state set
          timer_remaining  = greatest(0, timer_remaining - extract(epoch from now() - timer_started_at)),
          timer_started_at = null, updated_at = now()
        where session_id = sid;
      end if;
    elsif v = 'reset' then
      update presenter_state set timer_remaining = timer_duration, timer_started_at = null, updated_at = now()
       where session_id = sid;
    elsif v = 'duration' then
      d := greatest(5, least(3600, (p_args->>'seconds')::int));
      update presenter_state set timer_duration = d, timer_remaining = d, timer_started_at = null, updated_at = now()
       where session_id = sid;
    elsif v = 'show' then
      update presenter_state set timer_visible = true, updated_at = now() where session_id = sid;
    elsif v = 'hide' then
      update presenter_state set timer_visible = false, timer_remaining = timer_duration,
             timer_started_at = null, updated_at = now()
       where session_id = sid;
    else
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;

  when 'annotation_add' then
    if not exists (select 1 from options o join questions q on q.id = o.question_id
                    where o.id = (p_args->>'option_id')::bigint and q.session_id = sid)
       or coalesce(trim(p_args->>'label'), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    insert into annotations (session_id, option_id, label)
      values (sid, (p_args->>'option_id')::bigint, left(trim(p_args->>'label'), 40));

  when 'annotation_remove' then
    delete from annotations where id = (p_args->>'id')::bigint and session_id = sid;

  when 'annotation_clear' then
    delete from annotations where session_id = sid;

  when 'new_session' then
    v := coalesce(p_args->>'mode', 'test');
    if v not in ('test', 'live') then
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    sid := _create_session(v, p_args->>'name');

  when 'activate_session' then
    if not exists (select 1 from sessions where id = (p_args->>'session_id')::uuid) then
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    sid := (p_args->>'session_id')::uuid;
    update app_config set active_session_id = sid where id = 1;

  when 'reset' then
    if p_args->>'confirm' is distinct from 'RESET' then
      return jsonb_build_object('ok', false, 'error', 'confirm_required');
    end if;
    delete from responses where session_id = sid;
    delete from participants where session_id = sid;
    delete from annotations where session_id = sid;
    update presenter_state set timer_remaining = timer_duration, timer_started_at = null,
           timer_visible = false, updated_at = now()
     where session_id = sid;

  when 'export_responses' then
    return jsonb_build_object('ok', true, 'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', r.participant_id,
               'question_ord', q.ord,
               'question', q.text,
               'options', (select jsonb_agg(o.text order by o.ord) from options o where o.id = any (r.option_ids)),
               'created_at', r.created_at,
               'updated_at', r.updated_at)
             order by r.created_at, r.id)
        from responses r join questions q on q.id = r.question_id
       where r.session_id = sid), '[]'::jsonb));

  when 'change_pin' then
    if length(coalesce(p_args->>'new_pin', '')) < 4 then
      return jsonb_build_object('ok', false, 'error', 'pin_too_short');
    end if;
    update app_config set pin_hash = crypt(p_args->>'new_pin', gen_salt('bf')) where id = 1;

  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end case;

  return jsonb_build_object(
    'ok', true,
    'companies', (select companies from app_config where id = 1),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', id, 'name', name, 'mode', mode, 'status', status, 'created_at', created_at,
                    'active', id = sid) order by created_at desc) from sessions), '[]'::jsonb),
    'results', get_results(sid));
end $$;

-- Used from the SQL editor only (never exposed to the API).
create or replace function public.set_admin_pin(p_pin text) returns void
language sql security definer set search_path = public, extensions as $$
  update app_config set pin_hash = crypt(p_pin, gen_salt('bf')), failed_attempts = 0, locked_until = null where id = 1;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke all on function public.bump_pulse()                               from public, anon, authenticated;
revoke all on function public._create_session(text, text)                from public, anon, authenticated;
revoke all on function public._refresh_completion(uuid, uuid)            from public, anon, authenticated;
revoke all on function public.set_admin_pin(text)                        from public, anon, authenticated;
revoke all on function public.get_results(uuid)                          from public;
revoke all on function public.participant_sync(uuid)                     from public;
revoke all on function public.submit_answer(uuid, bigint, bigint[])      from public;
revoke all on function public.admin(text, text, jsonb)                   from public;
grant execute on function public.get_results(uuid)                       to anon, authenticated;
grant execute on function public.participant_sync(uuid)                  to anon, authenticated;
grant execute on function public.submit_answer(uuid, bigint, bigint[])   to anon, authenticated;
grant execute on function public.admin(text, text, jsonb)                to anon, authenticated;
