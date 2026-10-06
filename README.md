# Studyspace — Smart Study Planner

Studyspace is a responsive study planner built from [`index.html`](./index.html) and [`app.js`](./app.js), with Tailwind CSS and the Supabase client loaded from CDNs. Study goals, past-paper entries, modules, study sessions, flashcards, planner preferences, quick notes, and energy check-ins are saved immediately in browser `localStorage`; when a user signs in, changes also sync to Supabase.

## Run locally

Open `index.html` in a modern browser, or run `python3 -m http.server 8000` from this folder and visit <http://localhost:8000>.

## Push to GitHub

1. Create an empty GitHub repository. Leave README, license, and `.gitignore` initialization unchecked.
2. In Terminal, change to this project directory and run the following commands. Replace the example GitHub URL with your repository URL:

   ```sh
   cd /path/to/smaet-study-planner
   git init
   git add index.html app.js README.md
   git commit -m "Build Smart Study Planner"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
   git push -u origin main
   ```

If this folder already has a Git repository and remote, skip `git init` and `git remote add origin`; check the existing remote with `git remote -v`.

## Deploy free on Netlify

1. Sign in to Netlify and select **Add new site → Import an existing project**.
2. Choose GitHub, authorize access if prompted, and select your repository.
3. Leave the build command blank and set the publish directory to `.` (repository root).
4. Select **Deploy site**. New commits to `main` publish automatically.

## Deploy free on Vercel

1. Sign in to Vercel and select **Add New → Project**.
2. Import your GitHub repository.
3. Select **Other** as the framework preset; leave the build command blank and set the output directory to `.`.
4. Select **Deploy**. Vercel serves `index.html` directly; no server functions are needed.

## Enable Supabase accounts and cloud sync

The app uses Supabase Auth and stores one JSON data document per account in `public.user_data.planner_data`. Local storage remains active; while signed in, changes are debounced and upserted to the account. On sign-in, an existing cloud copy is loaded. If both cloud and this browser contain different study data, the app asks which copy to keep. When no cloud row exists, the current local data is uploaded to initialize the account.

1. The Supabase project URL and public publishable key are configured in `app.js`. A publishable key is intended for browser use; never substitute a `service_role` or secret key.
2. Open the Supabase **SQL Editor** and run:

   ```sql
   create table if not exists public.user_data (
     user_id uuid primary key references auth.users (id) on delete cascade,
     planner_data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   alter table public.user_data enable row level security;

   drop policy if exists "Users can read their own study data" on public.user_data;
   create policy "Users can read their own study data"
     on public.user_data for select to authenticated
     using ((select auth.uid()) = user_id);

   drop policy if exists "Users can create their own study data" on public.user_data;
   create policy "Users can create their own study data"
     on public.user_data for insert to authenticated
     with check ((select auth.uid()) = user_id);

   drop policy if exists "Users can update their own study data" on public.user_data;
   create policy "Users can update their own study data"
     on public.user_data for update to authenticated
     using ((select auth.uid()) = user_id)
     with check ((select auth.uid()) = user_id);

   grant select, insert, update on public.user_data to authenticated;
   ```

3. If you previously created `user_data` using the earlier `data` column, rename that column once: `alter table public.user_data rename column data to planner_data;`. In Supabase **Authentication → URL Configuration**, add the deployed site URL (and local development URL, such as `http://localhost:8000`) to the allowed redirect URLs. Enable Email auth. If email confirmation is enabled, new users must confirm their email before signing in.
4. Deploy both `index.html` and `app.js` over HTTPS. Use **Login** or **Sign up** to access an account. **Forgot password?** emails a recovery link to the supplied address; ensure the deployed site URL is allowed in Supabase Auth redirects. Opening the link in the app lets the user set a new password. The same account can load the saved study data on another device.

The browser key is intentionally a public publishable key; row-level security restricts each row to its owner. Never add a service-role key to client-side code. Supabase failures do not discard local changes; the app reports a sync error and keeps local storage available.

### Enable private study-document uploads

The AI Predictor view uploads PDFs and text notes to a **private** Storage bucket named `study-materials`. Run this additional SQL in the Supabase SQL Editor. The first folder in each object path is the authenticated user's UUID; the policies restrict listing, upload, preview, and deletion to that user.

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study-materials',
  'study-materials',
  false,
  20971520,
  array['application/pdf', 'text/plain', 'text/markdown']
)
on conflict (id) do update
set public = false,
    file_size_limit = 20971520,
    allowed_mime_types = array['application/pdf', 'text/plain', 'text/markdown'];

drop policy if exists "Users can read their own study materials" on storage.objects;
create policy "Users can read their own study materials"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload their own study materials" on storage.objects;
create policy "Users can upload their own study materials"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own study materials" on storage.objects;
create policy "Users can delete their own study materials"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
```

Create the metadata and full-text table as well:

```sql
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  extracted_text text not null default '',
  file_type text not null check (file_type in ('module', 'pyq')),
  category text not null check (category in ('lecture_notes', 'question_paper')),
  storage_path text not null unique,
  subject text not null default '',
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  created_at timestamptz not null default now()
);

alter table public.study_materials enable row level security;

drop policy if exists "Users can read their own study material rows" on public.study_materials;
create policy "Users can read their own study material rows"
  on public.study_materials for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own study material rows" on public.study_materials;
create policy "Users can insert their own study material rows"
  on public.study_materials for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own study material rows" on public.study_materials;
create policy "Users can delete their own study material rows"
  on public.study_materials for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, delete on public.study_materials to authenticated;
```

The app extracts text from every page of selectable PDFs with PDF.js. It inserts the **full extracted text** and file metadata into `public.study_materials`, while retaining an 18,000-character excerpt in planner state for on-device analysis and JSON backup. The actual uploaded binary is stored under the user's folder in the private bucket. If either Storage upload or database insert fails, the app reports the error and rolls back the other upload step when possible; the document appears in the library after both remote saves and local state persistence succeed. Scanned/image-only PDFs need OCR before analysis. JSON backups preserve document metadata and extracted excerpts, but not uploaded binary files or the full database text; those remain in the account's private Storage bucket and `public.study_materials`. Document previews use short-lived signed links. The predictor is a transparent, client-side frequency heuristic based on uploaded text, module weights, and logged paper history—not a hosted generative AI service or a guarantee of exam content. Clicking a predicted question surfaces the best-matching sentences from the user's uploaded module text as a **source-based answer**; the app does not fabricate an answer when no passage matches. Export a ranked Markdown study sheet with probability estimates, evidence, and source-based answers. The split-screen focus workspace shows extracted source text alongside predictions or actionable open tasks. In-app reminders and browser notifications require the app tab to remain open; browser notification permission is requested only when setting a reminder.

## Features

- Fixed sidebar navigation for Dashboard, Predictor, Study schedule, Modules, Flashcards, and Settings.
- Create, edit, complete, search, filter, and delete study goals with descriptions, deadlines, and color-coded priority.
- Switch between a searchable list and a drag-and-drop Kanban board; set To do, In progress, or Done status, track subtasks, and color-code subjects.
- Today's completion progress, high-yield tasks remaining, and a study streak. Log a study session from the streak card or track focus time with the Pomodoro timer.
- Set an exam target and follow its live days/hours/minutes countdown; visualize the last 35 days of focused study in the activity heatmap.
- Save a daily energy check-in and use the auto-saving quick-notes drawer to capture thoughts without losing your place.
- Generate local rain, coffee-shop, or soft lo-fi ambience with the browser's Web Audio API; no audio files are downloaded or streamed.
- Past-paper question and tag logging, a recurrence table, and a frequency-ranked exam focus list.
- Private module/PYQ document uploads from the predictor and past-paper sections, with per-user Supabase Storage policies, full-page PDF text extraction, temporary previews, and document removal.
- Client-side, subject-filterable exam-topic hotspot estimates with an interactive concept map grounded in uploaded text and past-paper history.
- Click-to-reveal, source-based answer excerpts; Markdown study-sheet export; and a split-screen workspace for source text with predicted questions or completable tasks.
- Custom topic reminders with in-app alerts and optional browser notifications while the app tab is open.
- Exam-weighted module tracker with auto-scored high, medium, and low yield, plus module links on study goals.
- Persistent 25-minute focus / 5-minute break timer; focus time is logged against an optional task or module, including when pausing or resetting early.
- Smart schedule ordered by due date, with goal priority and module yield used to rank same-day work; module exam dates appear alongside study goals.
- Quick-revise flashcards with reveal/hide answers and full create, edit, and delete controls.
- Persistent light/dark appearance and JSON backup export/import for goals, paper entries, modules, sessions, flashcards, task states, notes, preferences, and timer settings.
- Power-user shortcuts: `Ctrl/Cmd + N` opens a new goal, and `Ctrl/Cmd + Shift + P` toggles the Pomodoro timer.
- Optional Supabase email/password accounts with owner-isolated row-level security and cloud data sync.
- Existing Studyspace task, paper, module, and study-log data remains in the same browser storage.

Use HTTPS on the deployed site. Without signing in, data belongs only to the current browser and does not sync across devices; with Supabase enabled and an account connected, study data also syncs to that account. Export a JSON backup before clearing browser storage or moving to another device. Importing a backup replaces the study data currently saved in the browser. A timer running in the background continues to count elapsed time after a refresh; importing a backup restores a running timer as paused.

The Tailwind, Supabase, and optional Google Fonts CDNs need an internet connection. Local study planning and storage still work when Supabase is unreachable. The app is static and free to deploy.
