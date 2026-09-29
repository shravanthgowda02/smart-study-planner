# Studyspace — Smart Study Planner

Studyspace is a single-file, responsive study planner. Its interface uses Tailwind CSS via CDN with a small embedded CSS design system; all application JavaScript is embedded at the bottom of [`index.html`](./index.html). Study goals, past-paper entries, modules, study sessions, flashcards, and timer state are saved in browser `localStorage`. There is no backend or account.

## Run locally

Open `index.html` in a modern browser, or run `python3 -m http.server 8000` from this folder and visit <http://localhost:8000>.

## Push to GitHub

1. Create an empty GitHub repository. Leave README, license, and `.gitignore` initialization unchecked.
2. In Terminal, change to this project directory and run the following commands. Replace the example GitHub URL with your repository URL:

   ```sh
   cd /path/to/smaet-study-planner
   git init
   git add index.html README.md
   git commit -m "Build single-file Smart Study Planner"
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

## Features

- Fixed sidebar navigation for Dashboard, Predictor, Study schedule, Modules, Flashcards, and Settings.
- Create, edit, complete, search, filter, and delete study goals with descriptions, deadlines, and color-coded priority.
- Today's completion progress, high-yield tasks remaining, and a study streak. Log a study session from the streak card or track focus time with the Pomodoro timer.
- Past-paper question and tag logging, a recurrence table, and a frequency-ranked exam focus list.
- Exam-weighted module tracker with auto-scored high, medium, and low yield, plus module links on study goals.
- Persistent 25-minute focus / 5-minute break timer; focus time is logged against an optional task or module, including when pausing or resetting early.
- Smart schedule ordered by due date, with goal priority and module yield used to rank same-day work; module exam dates appear alongside study goals.
- Quick-revise flashcards with reveal/hide answers and full create, edit, and delete controls.
- Persistent light/dark appearance and JSON backup export/import for goals, paper entries, modules, sessions, flashcards, and timer settings.
- Existing Studyspace task, paper, module, and study-log data remains in the same browser storage.

Use HTTPS on the deployed site. Data belongs to the current browser and does not sync across devices. Export a JSON backup before clearing browser storage or moving to another device. Importing a backup replaces the study data currently saved in the browser. A timer running in the background continues to count elapsed time after a refresh; importing a backup restores a running timer as paused.

The Tailwind CDN and optional Google Fonts need an internet connection. The app itself is static and free to deploy.
