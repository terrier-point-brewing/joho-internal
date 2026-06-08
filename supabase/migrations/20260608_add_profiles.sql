-- User profiles with role-based access control.
-- Roles: viewer < brewer < manager < admin

create type user_role as enum ('viewer', 'brewer', 'manager', 'admin');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role user_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user is created.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Row-level security: users can read their own profile; admins can read all.
alter table profiles enable row level security;

create policy "Users can read own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Admins can read all profiles"
  on profiles for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

create policy "Admins can update roles"
  on profiles for update
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );
