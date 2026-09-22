# Supabase setup for My Expenses

This app stays offline-first. localStorage (`my-expenses-data-v1`) is still the working copy. Supabase is a per-user cloud backup after login.

Do **not** put the `service_role` key, database password, or any secret in `config.js` or GitHub.

---

## 1. Create or open a Supabase project

1. Open [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. Open your existing project (or create one)

---

## 2. Enable email login

1. Go to **Authentication → Providers**
2. Enable **Email**
3. Turn **off** “Confirm email” if family members should log in without opening a confirmation email (recommended for Dad)

---

## 3. Create family users

1. Go to **Authentication → Users → Add user**
2. Create one user per person. Example:

   - Sai: `sai@example.com`
   - Dad: `dad@example.com`
   - Sister: `sister@example.com`

3. Set a password for each person
4. Do **not** share passwords between people

Each login can only see its own expense rows (Row Level Security).

---

## 4. Run this SQL

Go to **SQL Editor → New query**, paste **all** of the following, then **Run**.

If an `expenses` table **already exists**, do **not** run this as-is. See [Existing table](#if-an-expenses-table-already-exists) below.

```sql
create table if not exists public.expenses (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  expense_date date not null,
  category text not null,
  description text not null,
  amount numeric(12,2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create index if not exists expenses_user_date_idx
  on public.expenses (user_id, expense_date desc);

alter table public.expenses enable row level security;

drop policy if exists "Users can read own expenses" on public.expenses;
drop policy if exists "Users can insert own expenses" on public.expenses;
drop policy if exists "Users can update own expenses" on public.expenses;
drop policy if exists "Users can delete own expenses" on public.expenses;

create policy "Users can read own expenses"
  on public.expenses for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own expenses"
  on public.expenses for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own expenses"
  on public.expenses for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own expenses"
  on public.expenses for delete
  to authenticated
  using (auth.uid() = user_id);
```

The `id` column is **text**, not UUID, because this app already uses IDs like `e-mxyz123-abc123`.

---

## If an `expenses` table already exists

Do **not** `drop table public.expenses` if it has data you care about.

In **Table Editor**, check columns. Then run only the pieces you are missing, for example:

```sql
-- Only if the table exists but uses uuid ids (this will fail if rows are already uuids
-- that you must keep — inspect first):
-- alter table public.expenses alter column id type text;

alter table public.expenses add column if not exists expense_date date;
alter table public.expenses add column if not exists category text;
alter table public.expenses add column if not exists description text;
alter table public.expenses add column if not exists amount numeric(12,2);
alter table public.expenses add column if not exists created_at timestamptz default now();
alter table public.expenses add column if not exists updated_at timestamptz default now();
alter table public.expenses add column if not exists deleted boolean default false;
alter table public.expenses add column if not exists user_id uuid references auth.users(id);

alter table public.expenses enable row level security;
```

Then create the four policies from section 4 if they are not already there. Do not delete existing rows.

---

## 5. Site URL and redirect URL (GitHub Pages)

Go to **Authentication → URL Configuration**.

Replace `USERNAME` with your GitHub username and `Expense-Tracker` with the **exact repository name**.

**Site URL:**

```text
https://USERNAME.github.io/Expense-Tracker/
```

**Redirect URLs** (add both if you are unsure about the trailing slash):

```text
https://USERNAME.github.io/Expense-Tracker/
https://USERNAME.github.io/Expense-Tracker/index.html
```

If the site is a user/organization page at the domain root, use `https://USERNAME.github.io/` instead.

---

## 6. Copy Project URL and anon key

1. Go to **Project Settings → API**
2. Copy **Project URL**
3. Copy the **anon public** key  
4. Paste them into `config.js`:

```javascript
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY"
};
```

Never copy the **service_role** key into this project.

---

## 7. Deploy to GitHub Pages

1. Put these files in the repository root (or the folder Pages is served from):

   - `index.html`
   - `style.css`
   - `script.js`
   - `config.js` (with real URL + anon key)
   - `SUPABASE_SETUP.md` (optional on the site)

2. GitHub repo → **Settings → Pages**
3. Source: Deploy from a branch (`main` / `/ (root)`)
4. Open `https://USERNAME.github.io/Expense-Tracker/`
5. Log in with a family user

Opening `file:///D:/Expense Tracker/index.html` can still add expenses locally, but **login needs https (GitHub Pages) or localhost**.

---

## 8. Tests after deploy

1. Open the site while logged out → login screen
2. Log in → existing Expense Tracker UI
3. Add an expense → it appears immediately; in Supabase **Table Editor → expenses** a row appears
4. Turn on airplane mode, add another expense, reload → it is still there
5. Go online → Settings shows **Synced just now**
6. Chrome → Clear site data for this site → open the site → log in → expenses come back from the cloud
7. Log in as a different family member → you should not see the other person’s cloud expenses

---

## 9. First login with expenses already on the phone

If this device already has expenses in `my-expenses-data-v1`, the app asks:

**Existing expenses were found on this device. Do you want to upload them to your cloud account?**

- **Upload & Continue** — attaches those rows to the account you just logged into
- **Don’t Upload** — leaves those local rows off this account and loads this account’s cloud copy instead

Always log in as the **owner of those expenses** before choosing Upload (Dad’s phone → Dad’s account).
