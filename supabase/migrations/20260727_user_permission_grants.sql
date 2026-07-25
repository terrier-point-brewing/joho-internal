-- Per-user scope+level permission grants, consulted only for role = 'custom'.
create type permission_level as enum ('read', 'operate', 'manage', 'admin');

create table user_permission_grants (
  user_id    uuid not null references profiles(id) on delete cascade,
  scope      text not null,
  level      permission_level not null,
  granted_by uuid references profiles(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, scope)
);

alter table user_permission_grants enable row level security;

-- getSessionUser reads through the SERVER client. Without this policy every
-- custom user silently resolves to zero permissions.
create policy "users read own grants" on user_permission_grants
  for select to authenticated using (user_id = auth.uid());
-- writes are service_role only (admin client), no authenticated write policy
