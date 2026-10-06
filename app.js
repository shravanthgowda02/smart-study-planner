    (() => {
      "use strict";
      const STORAGE_KEY = "studyspace-data-v1";
      const THEME_KEY = "studyspace-theme";
      const SUPABASE_URL = "https://ifaotcnqgdyshnjdeptz.supabase.co";
      const SUPABASE_ANON_KEY = "sb_publishable_8Gp0UZ9VIWhDVKbge4lyFA__QZIEpaW";
      const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
      const $ = (selector, root = document) => root.querySelector(selector);
      const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
      const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const todayISO = () => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      };
      const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[character]);
      const emptyData = () => ({
        version: 3, tasks: [], sessions: [], questions: [], modules: [], logs: [], flashcards: [], timer: null,
        viewMode: "list", subjectColors: {}, targetExam: null, notes: "", energyLogs: [], preferences: {}, ambientTrack: "rain",
        documents: [], topicReminder: null
      });
      function normalizePlannerData(value, pauseTimer = true) {
        const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
        return {
          ...emptyData(), ...record,
          version: 3,
          tasks: rawTasks.filter((task) => task && typeof task === "object" && !Array.isArray(task)).map((task) => {
            const status = ["todo", "in_progress", "done"].includes(task.status) ? task.status : task.done ? "done" : "todo";
            return {
              ...task, status, done: status === "done",
              subtasks: Array.isArray(task.subtasks) ? task.subtasks.filter((item) => item && typeof item === "object").slice(0, 30).map((item) => ({
                id: typeof item.id === "string" ? item.id : makeId(),
                text: typeof item.text === "string" ? item.text.slice(0, 180) : "",
                done: Boolean(item.done)
              })).filter((item) => item.text) : []
            };
          }),
          sessions: Array.isArray(record.sessions) ? record.sessions : (Array.isArray(record.logs) ? record.logs : []),
          logs: Array.isArray(record.logs) ? record.logs : (Array.isArray(record.sessions) ? record.sessions : []),
          questions: Array.isArray(record.questions) ? record.questions : [],
          modules: Array.isArray(record.modules) ? record.modules : [],
          flashcards: Array.isArray(record.flashcards) ? record.flashcards : [],
          timer: record.timer && typeof record.timer === "object"
            ? { ...record.timer, ...(pauseTimer && record.timer.running ? { running: false, paused: true, startedAt: undefined } : {}) } : null,
          viewMode: record.viewMode === "kanban" ? "kanban" : "list",
          subjectColors: record.subjectColors && typeof record.subjectColors === "object" && !Array.isArray(record.subjectColors) ? record.subjectColors : {},
          targetExam: record.targetExam && typeof record.targetExam === "object" && dateFromISO(record.targetExam.date)
            ? { date: record.targetExam.date, label: typeof record.targetExam.label === "string" ? record.targetExam.label.slice(0, 60) : "" } : null,
          notes: typeof record.notes === "string" ? record.notes.slice(0, 12000) : "",
          energyLogs: Array.isArray(record.energyLogs) ? record.energyLogs.filter((entry) => entry && typeof entry.date === "string" && ["high", "medium", "low"].includes(entry.level)) : [],
          preferences: record.preferences && typeof record.preferences === "object" && !Array.isArray(record.preferences) ? record.preferences : {},
          ambientTrack: ["rain", "cafe", "lofi"].includes(record.ambientTrack) ? record.ambientTrack : "rain",
          documents: Array.isArray(record.documents) ? record.documents.filter((document) => document
            && typeof document.id === "string" && typeof document.path === "string"
            && typeof document.name === "string" && ["module", "pyq"].includes(document.docType))
            .slice(0, 100).map((document) => ({
              id: document.id, path: document.path.slice(0, 512), name: document.name.slice(0, 180),
              studyMaterialId: typeof document.studyMaterialId === "string" ? document.studyMaterialId : "",
              subject: typeof document.subject === "string" ? document.subject.slice(0, 60) : "",
              docType: document.docType, mimeType: typeof document.mimeType === "string" ? document.mimeType.slice(0, 120) : "",
              size: Number.isFinite(Number(document.size)) ? Math.max(0, Number(document.size)) : 0,
              createdAt: typeof document.createdAt === "string" ? document.createdAt : new Date().toISOString(),
              ownerId: typeof document.ownerId === "string" ? document.ownerId : "",
              extractedText: typeof document.extractedText === "string" ? document.extractedText.slice(0, 18000) : "",
              extractionWarning: typeof document.extractionWarning === "string" ? document.extractionWarning.slice(0, 200) : ""
            })) : [],
          topicReminder: record.topicReminder && typeof record.topicReminder === "object"
            && typeof record.topicReminder.topic === "string" && Number.isFinite(Date.parse(record.topicReminder.dueAt))
            ? { topic: record.topicReminder.topic.slice(0, 180), dueAt: new Date(record.topicReminder.dueAt).toISOString() } : null
        };
      }
      let toastTimeout;
      let currentFilter = "active";

      function loadData() {
        try {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (!stored) return emptyData();
          const parsed = JSON.parse(stored);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Saved study data must be a JSON object.");
          return normalizePlannerData(parsed, false);
        } catch (error) {
          console.error("Unable to load local study data:", error);
          showToast("Saved data could not be read. Check this browser's storage.");
          return emptyData();
        }
      }

      function visibleStudyDocuments() {
        return authUser ? data.documents.filter((document) => document.ownerId === authUser.id) : data.documents;
      }

      let data = loadData();
      let supabaseClient = null;
      let authUser = null;
      let activeAuthUserId = null;
      let authLoadGeneration = 0;
      let cloudSyncAllowed = false;
      let cloudSyncTimer = null;
      let cloudSyncQueue = Promise.resolve();
      let authMode = "signin";
      let authSessionInitialized = false;
      let scratchSaveTimer = null;
      let ambientState = null;
      let renderedExamTarget = null;
      let predictionResults = [];
      let predictionHasRun = false;
      let topicReminderTimeout = null;
      let focusPaneMode = "questions";
      let examDateSettingsOpen = !data.targetExam;

      function setCloudStatus(message, tone = "") {
        const status = $("#cloud-status");
        status.textContent = message;
        status.classList.toggle("auth-message", Boolean(tone));
        status.classList.toggle("error", tone === "error");
        status.classList.toggle("success", tone === "success");
        $("#auth-status").textContent = tone === "error" ? "Sync error"
          : /load|sync|saving/i.test(message) && authUser ? "Syncing…"
          : authUser ? "Signed in" : "Local only";
      }

      function updateAuthUI() {
        const signedIn = Boolean(authUser);
        $("#auth-open-button").hidden = signedIn;
        $("#auth-signup-open-button").hidden = signedIn;
        $("#auth-user-email").hidden = !signedIn;
        $("#auth-logout-button").hidden = !signedIn;
        $("#auth-user-email").textContent = authUser?.email || "Signed in";
        $("#auth-status").textContent = signedIn ? "Signed in" : "Local only";
        $("#cloud-settings-title").textContent = signedIn ? "Cloud account connected" : "Local-first storage";
        $("#cloud-badge").textContent = signedIn ? "ACCOUNT" : "PRIVATE";
      }

      function saveData({ sync = true } = {}) {
        try {
          const serialized = JSON.stringify(data);
          localStorage.setItem(STORAGE_KEY, serialized);
          $("#storage-summary").textContent = `${data.tasks.length} goals · ${data.modules.length} modules · ${data.flashcards.length} flashcards saved in this browser.`;
          if (sync && authUser && cloudSyncAllowed) scheduleCloudSync();
          return true;
        } catch (error) {
          console.error("Unable to save local study data:", error);
          showToast("Couldn't save your changes. Check available browser storage.");
          return false;
        }
      }

      async function saveToCloud(dataToSave, expectedUserId = authUser?.id) {
        if (!supabaseClient || !expectedUserId || !cloudSyncAllowed) return false;
        try {
          const { data: sessionResult, error: sessionError } = await supabaseClient.auth.getSession();
          if (sessionError) throw sessionError;
          const session = sessionResult.session;
          if (!session || session.user.id !== expectedUserId || authUser?.id !== expectedUserId) return false;

          const snapshot = JSON.parse(JSON.stringify(dataToSave));
          if (snapshot.timer?.running) {
            snapshot.timer.remaining = timerRemaining();
            snapshot.timer.running = false;
            snapshot.timer.paused = true;
            delete snapshot.timer.startedAt;
          }
          snapshot.documents = (Array.isArray(snapshot.documents) ? snapshot.documents : [])
            .filter((document) => document.ownerId === expectedUserId);
          const { error } = await supabaseClient.from("user_data").upsert({
            user_id: session.user.id,
            planner_data: snapshot,
            updated_at: new Date().toISOString()
          }, { onConflict: "user_id" });
          if (error) throw error;
          if (authUser?.id === expectedUserId) setCloudStatus("All changes synced to your account.", "success");
          return true;
        } catch (error) {
          console.error("Unable to sync study data to Supabase:", error);
          if (authUser?.id === expectedUserId) setCloudStatus(`Cloud sync failed: ${error.message || "Please try again."}`, "error");
          showToast("Your changes are saved on this device, but cloud sync failed.");
          return false;
        }
      }

      function scheduleCloudSync() {
        if (!supabaseClient || !authUser || !cloudSyncAllowed) return;
        clearTimeout(cloudSyncTimer);
        setCloudStatus("Changes saved locally · syncing…");
        const userId = authUser.id;
        cloudSyncTimer = setTimeout(() => {
          const snapshot = JSON.parse(JSON.stringify(data));
          cloudSyncQueue = cloudSyncQueue.then(() => saveToCloud(snapshot, userId));
        }, 650);
      }

      function hasStudyData(value, userId = "") {
        const hasCoreData = ["tasks", "sessions", "questions", "modules", "logs", "flashcards", "energyLogs"]
          .some((key) => Array.isArray(value[key]) && value[key].length > 0);
        const hasOwnedDocuments = Array.isArray(value.documents) && value.documents.some((document) => document.ownerId === userId);
        return hasCoreData || hasOwnedDocuments
          || Boolean(value.timer || value.notes || value.targetExam || value.topicReminder || Object.keys(value.subjectColors || {}).length || value.viewMode === "kanban" || Object.keys(value.preferences || {}).length || value.ambientTrack !== "rain");
      }

      function normalizeCloudData(value) {
        if (!validImport(value)) throw new Error("The saved cloud record has an unsupported data format.");
        return normalizePlannerData(value);
      }

      async function loadDataFromCloud(userId) {
        const generation = authLoadGeneration;
        cloudSyncAllowed = false;
        setCloudStatus("Loading your cloud study data…");
        try {
          const { data: row, error } = await supabaseClient.from("user_data")
            .select("planner_data").eq("user_id", userId).maybeSingle();
          if (error && error.code !== "PGRST116") throw error;
          if (generation !== authLoadGeneration || authUser?.id !== userId) return;

          if (row?.planner_data) {
            const cloudData = normalizeCloudData(row.planner_data);
            const sameData = JSON.stringify(data) === JSON.stringify(cloudData);
            const localHasData = hasStudyData(data, userId);
            const cloudHasData = hasStudyData(cloudData);
            if (!sameData && localHasData && !cloudHasData) {
              cloudSyncAllowed = true;
              setCloudStatus("Using this browser's study data · syncing to your account.");
              scheduleCloudSync();
              return;
            }
            if (!sameData && localHasData && cloudHasData) {
              const loadCloud = window.confirm("This browser and your account both have study data that differ. Choose OK to load the cloud copy over this browser, or Cancel to keep this browser's data and sync it to your account.");
              if (!loadCloud) {
                cloudSyncAllowed = true;
                setCloudStatus("Using this browser's data · syncing to your account.");
                scheduleCloudSync();
                render();
                return;
              }
            }
            const previousData = data;
            data = cloudData;
            if (!saveData({ sync: false })) {
              data = previousData;
              throw new Error("Cloud data could not be saved to this browser's storage.");
            }
            setTheme(data.preferences.theme || localStorage.getItem(THEME_KEY) || "light");
            cloudSyncAllowed = true;
            render();
            setCloudStatus("Your study data is synced with the cloud.", "success");
            return;
          }

          cloudSyncAllowed = true;
          setCloudStatus("Account ready · saving this browser's study data to the cloud.");
          scheduleCloudSync();
        } catch (error) {
          console.error("Unable to load study data from Supabase:", error);
          if (generation === authLoadGeneration && authUser?.id === userId) {
            setCloudStatus(`Could not load cloud data: ${error.message || "Please check your connection and table setup."}`, "error");
            showToast("Couldn't load cloud data. Local study data is unchanged.");
          }
        }
      }

      async function applyAuthSession(session) {
        const user = session?.user || null;
        if (authSessionInitialized && user?.id === activeAuthUserId) return;
        authSessionInitialized = true;
        activeAuthUserId = user?.id || null;
        const generation = ++authLoadGeneration;
        authUser = user;
        cloudSyncAllowed = false;
        clearTimeout(cloudSyncTimer);
        updateAuthUI();
        predictionResults = [];
        predictionHasRun = false;
        render();
        renderPredictionResults();
        if (!user) {
          setCloudStatus(SUPABASE_CONFIGURED ? "Signed out · data remains on this device." : "Cloud sync is not configured.");
          return;
        }
        await loadDataFromCloud(user.id);
      }

      async function initializeSupabase() {
        if (!SUPABASE_CONFIGURED) {
          setCloudStatus("Cloud sync is not configured. Add your Supabase anon key.");
          $("#auth-config-note").hidden = false;
          return;
        }
        if (!window.supabase?.createClient) {
          setCloudStatus("Supabase client could not be loaded.", "error");
          showToast("Cloud features are unavailable because the Supabase CDN did not load.");
          return;
        }
        try {
          $("#auth-status").textContent = "Checking session…";
          supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
          supabaseClient.auth.onAuthStateChange((event, session) => {
            queueMicrotask(() => {
              if (event === "PASSWORD_RECOVERY") openAuthDialog("recovery", session?.user?.email || "");
              void applyAuthSession(session);
            });
          });
          const { data: sessionData, error } = await supabaseClient.auth.getSession();
          if (error) throw error;
          await applyAuthSession(sessionData.session);
        } catch (error) {
          console.error("Unable to initialize Supabase authentication:", error);
          setCloudStatus(`Could not check your account: ${error.message || "Supabase setup failed."}`, "error");
        }
      }

      function setAuthMessage(message, tone = "") {
        const element = $("#auth-message");
        element.textContent = message;
        element.classList.toggle("error", tone === "error");
        element.classList.toggle("success", tone === "success");
      }

      async function signUpUser(email, password) {
        if (!supabaseClient) throw new Error("Supabase is not initialized.");
        const { data: result, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        if (!result.session) {
          setAuthMessage("Check your inbox to confirm your email, then come back to sign in.", "success");
          return false;
        }
        closeDialog($("#auth-dialog"));
        await applyAuthSession(result.session);
        showToast("Account created.");
        return true;
      }

      async function resetPassword(email) {
        if (!supabaseClient) throw new Error("Supabase is not initialized.");
        const normalizedEmail = String(email || "").trim();
        if (!normalizedEmail) throw new Error("Enter your email address first.");
        const { error } = await supabaseClient.auth.resetPasswordForEmail(normalizedEmail, {
          redirectTo: `${window.location.origin}${window.location.pathname}`
        });
        if (error) throw error;
        setAuthMessage("If an account exists for that email, a password reset link has been sent.", "success");
      }

      async function updateRecoveredPassword(password) {
        if (!supabaseClient) throw new Error("Supabase is not initialized.");
        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) throw error;
        closeDialog($("#auth-dialog"));
        setAuthMessage("Your password has been updated.", "success");
        showToast("Password updated successfully.");
      }

      async function loginUser(email, password) {
        if (!supabaseClient) throw new Error("Supabase is not initialized.");
        const { data: result, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        closeDialog($("#auth-dialog"));
        window.location.reload();
        return result.session;
      }

      async function logoutUser() {
        if (!supabaseClient) throw new Error("Supabase is not initialized.");
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
        await applyAuthSession(null);
        window.location.reload();
      }

      function showToast(message) {
        const toast = $("#toast");
        toast.textContent = message;
        toast.classList.add("show");
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => toast.classList.remove("show"), 2600);
      }

      function dateFromISO(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
        const [year, month, day] = value.split("-").map(Number);
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
      }

      function dayDifference(value) {
        const target = dateFromISO(value);
        const today = dateFromISO(todayISO());
        return target && today ? Math.round((target - today) / 86400000) : Infinity;
      }

      function friendlyDue(value) {
        const difference = dayDifference(value);
        if (difference === 0) return "Due today";
        if (difference === 1) return "Due tomorrow";
        if (difference === -1) return "Overdue by 1 day";
        if (difference < -1 && Number.isFinite(difference)) return `Overdue by ${Math.abs(difference)} days`;
        const date = dateFromISO(value);
        return date ? `Due ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "No valid due date";
      }

      function priorityRank(priority) { return ({ high: 0, medium: 1, low: 2 })[priority] ?? 1; }

      function moduleLevel(module) {
        if (!module) return "low";
        const weight = Number(module.weight);
        if (module.weight !== "" && module.weight != null && Number.isFinite(weight)) return weight >= 20 ? "high" : weight >= 10 ? "medium" : "low";
        const terms = String(module.name || "").toLocaleLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
        const matches = data.questions.filter((question) => {
          const subject = String(question.subject || module.subject || "").toLocaleLowerCase();
          const topic = String(question.topic || "").toLocaleLowerCase();
          return subject === String(module.subject || "").toLocaleLowerCase() && terms.some((term) => topic.includes(term));
        });
        const years = new Set(matches.map((question) => question.year)).size;
        const score = Math.min(100, years * 35 + matches.length * 10);
        return score >= 60 ? "high" : score >= 25 ? "medium" : "low";
      }

      function taskIsHighYield(task) {
        return taskStatus(task) !== "done" && (task.priority === "high" || (task.moduleId && moduleLevel(data.modules.find((module) => module.id === task.moduleId)) === "high"));
      }

      const TIMER_LENGTHS = { focus: 25 * 60, break: 5 * 60 };
      let timerInterval = null;

      function timerRemaining() {
        const timer = data.timer;
        if (!timer) return TIMER_LENGTHS.focus;
        if (timer.running && timer.startedAt) {
          const elapsed = Math.max(0, Math.floor((Date.now() - timer.startedAt) / 1000));
          return Math.max(0, timer.remaining - elapsed);
        }
        return Math.max(0, timer.remaining ?? TIMER_LENGTHS[timer.mode] ?? TIMER_LENGTHS.focus);
      }

      function timerTargetLabel(value) {
        if (!value) return "No goal or module";
        const [type, id] = value.split(":", 2);
        return type === "task" ? data.tasks.find((task) => task.id === id)?.title || "Study goal"
          : data.modules.find((module) => module.id === id)?.name || "Module";
      }

      function updateTimerLinkOptions() {
        const select = $("#timer-link");
        const selected = data.timer?.link || select.value;
        const options = ['<option value="">No goal or module</option>'];
        const tasks = data.tasks.filter((task) => taskStatus(task) !== "done");
        if (tasks.length) options.push(`<optgroup label="Active goals">${tasks.map((task) => `<option value="task:${escapeHTML(task.id)}">${escapeHTML(task.title)}</option>`).join("")}</optgroup>`);
        if (data.modules.length) options.push(`<optgroup label="Modules">${data.modules.map((module) => `<option value="module:${escapeHTML(module.id)}">${escapeHTML(module.subject)} · ${escapeHTML(module.name)}</option>`).join("")}</optgroup>`);
        select.innerHTML = options.join("");
        if ([...select.options].some((option) => option.value === selected)) select.value = selected;
        select.disabled = Boolean(data.timer?.running);
      }

      function renderTimer() {
        const timer = data.timer || { mode: "focus", remaining: TIMER_LENGTHS.focus, running: false, link: "" };
        const mode = timer.mode === "break" ? "break" : "focus";
        const remaining = timerRemaining();
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        const total = TIMER_LENGTHS[mode];
        const elapsed = total - remaining;
        $("#timer-display").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
        $("#timer-mode-badge").textContent = mode === "focus" ? "25 MIN FOCUS" : "5 MIN BREAK";
        $("#timer-status").textContent = timer.running ? "Stay with this moment" : remaining === 0 ? "Session complete" : timer.paused ? "Paused · ready to resume" : "Ready when you are";
        $("#timer-play").textContent = timer.running ? "Pause session" : remaining === 0 ? "Start again" : "Start focus";
        $("#timer-ring").style.setProperty("--timer-progress", `${Math.round(elapsed / total * 360)}deg`);
        $$(".timer-mode-button").forEach((button) => {
          const active = button.dataset.timerMode === mode;
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", String(active));
        });
        updateTimerLinkOptions();
        $("#timer-session-note").textContent = mode === "focus" && elapsed > 0
          ? `${Math.floor(elapsed / 60)}m focused · linked to ${timerTargetLabel(timer.link)}`
          : mode === "focus" ? "Focus time is logged automatically as you study." : "Breaks are for resting, and aren't added to study time.";
      }

      function logFocusSeconds(seconds, timer) {
        if (seconds < 1 || timer.mode !== "focus") return;
        const link = timer.link || "";
        const [targetType, targetId] = link.split(":", 2);
        const session = {
          id: makeId(), date: todayISO(), minutes: seconds / 60, seconds, createdAt: Date.now(),
          source: "pomodoro", targetType: targetType || "", targetId: targetId || "",
          moduleId: targetType === "module" ? targetId : "",
          taskId: targetType === "task" ? targetId : ""
        };
        data.sessions.push(session);
        data.logs = data.sessions;
      }

      function finalizeRunningTimer(timer) {
        if (!timer?.running) return;
        const remaining = timerRemaining();
        const elapsed = Math.max(0, Math.min(TIMER_LENGTHS[timer.mode] || TIMER_LENGTHS.focus, timer.remaining - remaining));
        if (timer.mode === "focus" && elapsed) logFocusSeconds(elapsed, timer);
        if (remaining <= 0) {
          timer.mode = timer.mode === "focus" ? "break" : "focus";
          timer.remaining = TIMER_LENGTHS[timer.mode];
          timer.paused = false;
        } else {
          timer.remaining = remaining;
          timer.paused = true;
        }
        timer.running = false;
        delete timer.startedAt;
      }

      function persistTimerState() {
        return saveData();
      }

      function startTimer() {
        const timer = data.timer || { mode: "focus", remaining: TIMER_LENGTHS.focus, running: false, link: "" };
        const remaining = timerRemaining();
        if (remaining <= 0) {
          if (timer.mode === "focus" && timer.remaining > 0) logFocusSeconds(timer.remaining, timer);
          timer.mode = timer.mode === "focus" ? "break" : "focus";
          timer.remaining = TIMER_LENGTHS[timer.mode];
        } else timer.remaining = remaining;
        timer.running = true;
        timer.paused = false;
        timer.startedAt = Date.now();
        timer.link = $("#timer-link").value || "";
        data.timer = timer;
        if (!persistTimerState()) { timer.running = false; delete timer.startedAt; return; }
        clearInterval(timerInterval);
        timerInterval = setInterval(tickTimer, 1000);
        renderTimer();
      }

      function pauseTimer() {
        if (!data.timer?.running) return;
        const timer = data.timer;
        const remaining = timerRemaining();
        const elapsed = Math.max(0, Math.min(TIMER_LENGTHS[timer.mode], timer.remaining - remaining));
        if (elapsed) logFocusSeconds(elapsed, timer);
        timer.remaining = remaining;
        timer.running = false;
        timer.paused = true;
        delete timer.startedAt;
        clearInterval(timerInterval);
        timerInterval = null;
        persistTimerState();
        render();
      }

      function tickTimer() {
        if (!data.timer?.running) return;
        const remaining = timerRemaining();
        if (remaining > 0) {
          if (data.timer.mode === "focus") $("#timer-session-note").textContent = `${Math.floor((data.timer.remaining - remaining) / 60)}m focused · linked to ${timerTargetLabel(data.timer.link)}`;
          return renderTimer();
        }
        const timer = data.timer;
        const elapsed = Math.max(0, timer.remaining);
        if (elapsed) logFocusSeconds(elapsed, timer);
        timer.mode = timer.mode === "focus" ? "break" : "focus";
        timer.remaining = TIMER_LENGTHS[timer.mode];
        timer.running = false;
        timer.paused = false;
        delete timer.startedAt;
        clearInterval(timerInterval);
        timerInterval = null;
        persistTimerState();
        render();
        showToast(timer.mode === "break" ? "Focus session complete. Take a short break." : "Break complete. Ready for another focus session?");
        try {
          if ("Notification" in window && Notification.permission === "granted") new Notification("Studyspace", { body: timer.mode === "break" ? "Focus session complete. Take a short break." : "Break complete. Ready for another focus session?" });
        } catch (error) { console.error("Could not show timer notification:", error); }
        try {
          const audioContext = new AudioContext();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.connect(gain); gain.connect(audioContext.destination);
          gain.gain.setValueAtTime(0.08, audioContext.currentTime);
          oscillator.frequency.value = 660;
          oscillator.start(); oscillator.stop(audioContext.currentTime + 0.18);
          oscillator.onended = () => audioContext.close();
        } catch (error) { console.info("Audio alert unavailable:", error); }
      }

      function resetTimer() {
        const timer = data.timer || { mode: "focus", link: "" };
        if (timer.running) {
          const elapsed = Math.max(0, Math.min(TIMER_LENGTHS[timer.mode], timer.remaining - timerRemaining()));
          if (elapsed) logFocusSeconds(elapsed, timer);
        }
        clearInterval(timerInterval);
        timerInterval = null;
        timer.mode = timer.mode === "break" ? "break" : "focus";
        timer.remaining = TIMER_LENGTHS[timer.mode];
        timer.running = false;
        timer.paused = false;
        delete timer.startedAt;
        data.timer = timer;
        persistTimerState();
        render();
      }

      function setTimerMode(mode) {
        if (!TIMER_LENGTHS[mode]) return;
        if (data.timer?.running) pauseTimer();
        const timer = data.timer || { link: "" };
        timer.mode = mode;
        timer.remaining = TIMER_LENGTHS[mode];
        timer.running = false;
        timer.paused = false;
        delete timer.startedAt;
        data.timer = timer;
        persistTimerState();
        renderTimer();
      }

      function renderHeader() {
        const now = new Date();
        $("#today-label").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
        $("#page-date").textContent = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        renderExamCountdown(now);
      }

      function renderExamCountdown(now = new Date()) {
        const target = data.targetExam;
        const title = target?.label || "Your next exam";
        $("#exam-countdown-title").textContent = title;
        $("#exam-date-card").hidden = !examDateSettingsOpen;
        const signature = JSON.stringify(target);
        if (signature !== renderedExamTarget) {
          if (document.activeElement !== $("#exam-title-input")) $("#exam-title-input").value = target?.label || "";
          if (document.activeElement !== $("#exam-date-input")) $("#exam-date-input").value = target?.date || "";
          renderedExamTarget = signature;
        }
        if (!target?.date || !dateFromISO(target.date)) {
          $("#exam-countdown-description").textContent = "Set a target date to keep the finish line in view.";
          $("#exam-countdown-top").textContent = "Set a date";
          return;
        }
        const examDay = dateFromISO(target.date);
        const examDateOnly = new Date(examDay);
        examDateOnly.setHours(0, 0, 0, 0);
        const todayDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (examDateOnly < todayDateOnly) {
          $("#exam-countdown-description").textContent = `That target date has passed · ${friendlyDue(target.date)}.`;
          $("#exam-countdown-top").textContent = "Date passed";
          return;
        }
        examDay.setHours(9, 0, 0, 0);
        const minutesLeft = Math.max(0, Math.ceil((examDay.getTime() - now.getTime()) / 60000));
        const days = Math.floor(minutesLeft / 1440);
        const hours = Math.floor(minutesLeft % 1440 / 60);
        const minutes = minutesLeft % 60;
        const compact = minutesLeft === 0 ? "Exam day" : `${days}d ${hours}h ${minutes}m`;
        $("#exam-countdown-top").textContent = compact;
        $("#exam-countdown-description").textContent = minutesLeft === 0
          ? `Today · ${new Date(`${target.date}T09:00:00`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} target`
          : `${days} days, ${hours} hours and ${minutes} minutes remaining.`;
      }

      function saveExamDate() {
        const date = $("#exam-date-input").value;
        const label = $("#exam-title-input").value.trim().slice(0, 60);
        if (date && !dateFromISO(date)) {
          showToast("Choose a valid exam date.");
          $("#exam-date-input").focus();
          return;
        }
        if (!date && label) {
          showToast("Choose an exam date, or clear the exam name too to remove the countdown.");
          $("#exam-date-input").focus();
          return;
        }
        const previous = data.targetExam;
        data.targetExam = date ? { date, label } : null;
        if (!saveData()) {
          data.targetExam = previous;
          return;
        }
        examDateSettingsOpen = false;
        renderHeader();
        showToast(date ? "Exam countdown saved." : "Exam countdown cleared.");
      }

      function getUniqueSessions() {
        const seen = new Set();
        return data.sessions.concat(data.logs).filter((session) => {
          const key = session.id || JSON.stringify(session);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      function renderSummary() {
        const todayTasks = data.tasks.filter((task) => task.due === todayISO());
        const completed = todayTasks.filter((task) => taskStatus(task) === "done").length;
        const percent = todayTasks.length ? Math.round(completed / todayTasks.length * 100) : 0;
        $("#today-percent").textContent = String(percent);
        $("#today-progress-bar").style.width = `${percent}%`;
        $("#today-progress-track").setAttribute("aria-valuenow", String(percent));
        $("#today-progress-caption").textContent = `${completed} of ${todayTasks.length} ${todayTasks.length === 1 ? "goal" : "goals"} complete`;
        $("#high-yield-remaining").textContent = String(data.tasks.filter(taskIsHighYield).length);
        const activeDates = new Set(data.logs.concat(data.sessions).map((session) => session.date).filter((date) => dateFromISO(date)));
        const cursor = dateFromISO(todayISO());
        if (!activeDates.has(todayISO())) cursor.setDate(cursor.getDate() - 1);
        let streak = 0;
        while (activeDates.has(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`)) {
          streak += 1;
          cursor.setDate(cursor.getDate() - 1);
        }
        $("#study-streak").textContent = String(streak);
        $("#streak-caption").textContent = streak ? "Keep your focused days going" : "Start a focus session to begin your streak";
      }

      function renderStudyAnalytics() {
        const sessionsById = new Map();
        data.sessions.concat(data.logs).forEach((session, index) => {
          const key = session.id || `${session.date}-${session.minutes}-${session.createdAt}-${index}`;
          if (!sessionsById.has(key)) sessionsById.set(key, session);
        });
        const totals = { high: 0, medium: 0, low: 0, unlinked: 0 };
        let allSeconds = 0;
        sessionsById.forEach((session) => {
          const seconds = Number.isFinite(Number(session.seconds)) && Number(session.seconds) >= 0
            ? Number(session.seconds) : Math.max(0, Number(session.minutes) || 0) * 60;
          allSeconds += seconds;
          let moduleId = session.moduleId || "";
          if (!moduleId && session.targetType === "module") moduleId = session.targetId || "";
          if (!moduleId && session.taskId) moduleId = data.tasks.find((task) => task.id === session.taskId)?.moduleId || "";
          if (!moduleId && session.targetType === "task") moduleId = data.tasks.find((task) => task.id === session.targetId)?.moduleId || "";
          const module = data.modules.find((item) => item.id === moduleId);
          const level = module ? moduleLevel(module) : "unlinked";
          totals[level] += seconds;
        });
        const formatHours = (seconds) => `${(seconds / 3600).toFixed(2)}h`;
        $("#total-study-hours").textContent = formatHours(allSeconds);
        ["high", "medium", "low", "unlinked"].forEach((level) => {
          const label = level === "unlinked" ? "unlinked" : `${level}-yield`;
          $(`#${label}-hours`).textContent = formatHours(totals[level]);
          $(`#${label}-hours-bar`).style.width = allSeconds ? `${Math.min(100, totals[level] / allSeconds * 100)}%` : "0%";
        });
      }

      function renderTasks() {
        const query = $("#task-search").value.trim().toLocaleLowerCase();
        const filtered = data.tasks.filter((task) => {
          const status = taskStatus(task);
          if (currentFilter === "active" && status === "done") return false;
          if (currentFilter === "done" && status !== "done") return false;
          const text = `${task.title || ""} ${task.description || ""} ${task.subject || ""}`.toLocaleLowerCase();
          return !query || text.includes(query);
        }).sort((a, b) => Number(taskStatus(a) === "done") - Number(taskStatus(b) === "done") || (a.due || "9999").localeCompare(b.due || "9999") || priorityRank(a.priority) - priorityRank(b.priority));
        $("#task-count").textContent = `${data.tasks.length} ${data.tasks.length === 1 ? "goal" : "goals"}`;
        $("#task-list").innerHTML = filtered.map((task) => renderTaskMarkup(task, false)).join("");
        $("#task-kanban").innerHTML = ["todo", "in_progress", "done"].map((status) => {
          const cards = filtered.filter((task) => taskStatus(task) === status);
          const label = status === "todo" ? "To do" : status === "in_progress" ? "In progress" : "Done";
          return `<section class="kanban-column" data-kanban-column="${status}" aria-label="${label} tasks">
            <div class="kanban-column-head"><strong>${label}</strong><span>${cards.length}</span></div>
            <div class="kanban-cards">${cards.map((task) => renderTaskMarkup(task, true)).join("") || `<span class="subtask-progress">Drop a goal here</span>`}</div>
          </section>`;
        }).join("");
        const boardMode = data.viewMode === "kanban";
        $("#task-list-view").hidden = boardMode;
        $("#task-kanban-view").hidden = !boardMode;
        $$("[data-task-view]").forEach((button) => button.classList.toggle("active", button.dataset.taskView === data.viewMode));
        const empty = filtered.length === 0;
        $("#task-empty").hidden = !empty;
        $("#task-empty-title").textContent = query ? "No matching goals." : currentFilter === "done" ? "Nothing completed yet." : currentFilter === "active" && data.tasks.length ? "You're all caught up." : "A fresh page.";
        $("#task-empty-copy").textContent = query ? "Try another search, or clear your search to see all goals." : currentFilter === "active" && data.tasks.length ? "Add another goal whenever you're ready." : "Add a goal to begin shaping your study day.";
        $("#clear-completed").hidden = !data.tasks.some((task) => taskStatus(task) === "done");
        $("#task-footer-copy").textContent = `${data.tasks.filter((task) => taskStatus(task) === "done").length} complete · ${data.tasks.filter((task) => taskStatus(task) !== "done").length} remaining`;
      }

      function taskStatus(task) {
        if (task?.done || task?.status === "done") return "done";
        return task?.status === "in_progress" ? "in_progress" : "todo";
      }

      function renderTaskMarkup(task, board) {
        const status = taskStatus(task);
        const priority = ["high", "medium", "low"].includes(task.priority) ? task.priority : "medium";
        const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
        const completedSubtasks = subtasks.filter((item) => item.done).length;
        const savedColor = data.subjectColors[String(task.subject || "").toLocaleLowerCase()];
        const color = /^#[0-9a-f]{6}$/i.test(task.subjectColor || "") ? task.subjectColor
          : (/^#[0-9a-f]{6}$/i.test(savedColor || "") ? savedColor : "#718096");
        return `<article class="${board ? "kanban-card" : "task-row"} ${status === "done" ? "task-done" : ""}" ${board ? `draggable="true" data-task-card="${escapeHTML(task.id)}"` : ""}>
          <input class="task-checkbox" type="checkbox" data-task-toggle="${escapeHTML(task.id)}" aria-label="Mark ${escapeHTML(task.title)} complete" ${status === "done" ? "checked" : ""}>
          <div class="task-copy"><p class="task-title">${escapeHTML(task.title || "Untitled goal")}</p>${task.description ? `<p class="task-description">${escapeHTML(task.description)}</p>` : ""}
            <div class="task-meta"><span>${escapeHTML(friendlyDue(task.due))}</span><span>·</span><span class="priority-badge priority-${priority}">${priority}</span>${task.subject ? `<span class="subject-tag" style="--subject-color:${escapeHTML(color)}"><i class="subject-dot"></i>${escapeHTML(task.subject)}</span>` : ""}${task.moduleId ? `<span>${escapeHTML(data.modules.find((module) => module.id === task.moduleId)?.name || "Linked module")}</span>` : ""}</div>
            ${subtasks.length ? `<div class="subtask-list">${subtasks.map((item) => `<label class="subtask-item ${item.done ? "done" : ""}"><input type="checkbox" data-subtask-task="${escapeHTML(task.id)}" data-subtask-id="${escapeHTML(item.id)}" ${item.done ? "checked" : ""}><span>${escapeHTML(item.text)}</span></label>`).join("")}<span class="subtask-progress">${completedSubtasks} / ${subtasks.length} subtasks</span></div>` : ""}
          </div>
          <div class="task-actions">${board ? `<select class="field-input" data-task-status="${escapeHTML(task.id)}" aria-label="Move ${escapeHTML(task.title)}" style="height:27px;max-width:100px;padding:3px;font-size:8px"><option value="todo" ${status === "todo" ? "selected" : ""}>To do</option><option value="in_progress" ${status === "in_progress" ? "selected" : ""}>In progress</option><option value="done" ${status === "done" ? "selected" : ""}>Done</option></select>` : ""}<button class="task-action" type="button" data-edit-task="${escapeHTML(task.id)}" aria-label="Edit ${escapeHTML(task.title)}" title="Edit goal">✎</button><button class="task-action" type="button" data-delete-task="${escapeHTML(task.id)}" aria-label="Delete ${escapeHTML(task.title)}" title="Delete goal">×</button></div>
        </article>`;
      }

      function renderModules() {
        const yieldRank = { high: 0, medium: 1, low: 2 };
        const sorted = [...data.modules].sort((a, b) => yieldRank[moduleLevel(a)] - yieldRank[moduleLevel(b)] || String(a.subject).localeCompare(String(b.subject)) || String(a.name).localeCompare(String(b.name)));
        const cardHTML = (module) => {
          const level = moduleLevel(module);
          const weight = module.weight !== "" && module.weight != null && Number.isFinite(Number(module.weight)) ? `${Number(module.weight)}% exam weight` : "Scored from past-paper patterns";
          const linkedTasks = data.tasks.filter((task) => task.moduleId === module.id && taskStatus(task) !== "done").length;
          return `<article class="module-card"><div class="module-card-head"><span class="yield-badge yield-${level}">${level} yield</span><span class="module-weight">${escapeHTML(weight)}</span></div><h3>${escapeHTML(module.name)}</h3><p>${escapeHTML(module.subject || "General")}</p><div class="module-card-meta"><span>${linkedTasks} open ${linkedTasks === 1 ? "goal" : "goals"}</span>${module.examDate ? `<span>Exam ${escapeHTML(friendlyDue(module.examDate))}</span>` : ""}${module.due ? `<span>Study by ${escapeHTML(friendlyDue(module.due))}</span>` : ""}</div><div class="module-card-actions"><button class="task-action" type="button" data-edit-module="${escapeHTML(module.id)}" aria-label="Edit ${escapeHTML(module.name)}" title="Edit module">✎</button><button class="task-action" type="button" data-delete-module="${escapeHTML(module.id)}" aria-label="Delete ${escapeHTML(module.name)}" title="Delete module">×</button></div></article>`;
        };
        $("#module-list").innerHTML = sorted.map(cardHTML).join("");
        $("#modules-empty").hidden = sorted.length > 0;
        const highlights = sorted.slice(0, 4);
        $("#dashboard-module-list").innerHTML = highlights.map((module) => `<div class="dashboard-module-row"><div><div class="module-row-name">${escapeHTML(module.name)}</div><div class="module-row-subject">${escapeHTML(module.subject || "General")}</div></div><span class="yield-badge yield-${moduleLevel(module)}">${moduleLevel(module)}</span></div>`).join("");
        $("#dashboard-modules-empty").hidden = highlights.length > 0;
      }

      function renderSchedule() {
        const entries = [
          ...data.tasks.filter((task) => taskStatus(task) !== "done" && dateFromISO(task.due)).map((task) => ({
            id: task.id, type: "task", title: task.title, date: task.due,
            priority: priorityRank(task.priority), yield: task.moduleId ? ({ high: 0, medium: 1, low: 2 })[moduleLevel(data.modules.find((module) => module.id === task.moduleId))] : 2,
            badge: task.moduleId ? `${data.modules.find((module) => module.id === task.moduleId)?.name || "Module"} · ${moduleLevel(data.modules.find((module) => module.id === task.moduleId))} yield` : `${task.priority || "medium"} priority`,
            moduleId: task.moduleId
          })),
          ...data.modules.filter((module) => dateFromISO(module.examDate)).map((module) => ({
            id: module.id, type: "exam", title: `${module.subject || "Subject"} · ${module.name} exam`,
            date: module.examDate, priority: 1, yield: ({ high: 0, medium: 1, low: 2 })[moduleLevel(module)],
            badge: `${moduleLevel(module)} yield · exam`, moduleId: module.id
          }))
        ].sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority || a.yield - b.yield || a.title.localeCompare(b.title));
        $("#schedule-count").textContent = `${entries.length} ${entries.length === 1 ? "item" : "items"}`;
        $("#schedule-list").innerHTML = entries.map((entry) => `<article class="schedule-row"><div class="schedule-date">${escapeHTML(dateFromISO(entry.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</div><div><div class="schedule-title">${escapeHTML(entry.title)}</div><div class="schedule-meta">${escapeHTML(friendlyDue(entry.date))} · ${escapeHTML(entry.badge)}</div></div>${entry.type === "task" ? `<button class="task-action" type="button" data-schedule-edit-task="${escapeHTML(entry.id)}" aria-label="Edit ${escapeHTML(entry.title)}" title="Edit goal">✎</button>` : `<span class="yield-badge yield-${moduleLevel(data.modules.find((module) => module.id === entry.moduleId))}">Exam</span>`}</article>`).join("");
        $("#schedule-empty").hidden = entries.length > 0;
      }

      function renderFlashcards() {
        $("#flashcard-count").textContent = `${data.flashcards.length} ${data.flashcards.length === 1 ? "card" : "cards"}`;
        $("#flashcard-list").innerHTML = data.flashcards.map((card) => `<article class="flashcard"><span class="flashcard-subject">${escapeHTML(card.subject || "Quick revise")}</span><p class="flashcard-prompt">${escapeHTML(card.front)}</p><div class="flashcard-answer" data-answer-for="${escapeHTML(card.id)}" hidden>${escapeHTML(card.back)}</div><div class="flashcard-actions"><button class="quiet-btn" type="button" data-reveal-card="${escapeHTML(card.id)}" aria-expanded="false">Reveal answer</button><button class="task-action" type="button" data-edit-card="${escapeHTML(card.id)}" aria-label="Edit flashcard">✎</button><button class="task-action" type="button" data-delete-card="${escapeHTML(card.id)}" aria-label="Delete flashcard">×</button></div></article>`).join("");
        $("#flashcards-empty").hidden = data.flashcards.length > 0;
      }

      function openModuleDialog(module = null) {
        $("#module-form").reset();
        $("#module-id").value = module?.id || "";
        $("#module-dialog-title").textContent = module ? "Edit module" : "Add a module";
        $("#module-name").value = module?.name || "";
        $("#module-subject").value = module?.subject || "";
        $("#module-weight").value = module?.weight ?? "";
        $("#module-due").value = module?.due || "";
        $("#module-exam-date").value = module?.examDate || "";
        $("#module-dialog").showModal();
      }

      function openFlashcardDialog(card = null) {
        $("#flashcard-form").reset();
        $("#flashcard-id").value = card?.id || "";
        $("#flashcard-dialog-title").textContent = card ? "Edit flashcard" : "Add a flashcard";
        $("#flashcard-front").value = card?.front || "";
        $("#flashcard-back").value = card?.back || "";
        $("#flashcard-subject").value = card?.subject || "";
        $("#flashcard-dialog").showModal();
      }

      function paperGroups() {
        const groups = new Map();
        data.questions.forEach((question) => {
          const topic = String(question.topic || "").trim();
          const subject = String(question.subject || "").trim();
          const key = `${subject.toLocaleLowerCase()}::${topic.toLocaleLowerCase()}`;
          if (!topic) return;
          if (!groups.has(key)) groups.set(key, { topic, subject, years: new Set(), tags: new Set(), count: 0 });
          const group = groups.get(key);
          group.years.add(String(question.year));
          (Array.isArray(question.tags) ? question.tags : []).forEach((tag) => group.tags.add(tag));
        });
        const groupsList = [...groups.values()].map((group) => ({ ...group, count: group.years.size }))
          .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
        return { groups: groupsList, byKey: groups };
      }

      function renderPredictor() {
        const { groups, byKey } = paperGroups();
        const paperCount = new Set(data.questions.map((question) => `${String(question.subject || "").toLocaleLowerCase()}-${question.year}`)).size;
        $("#paper-total").textContent = `${paperCount} ${paperCount === 1 ? "paper" : "papers"} logged`;
        $("#focus-list").innerHTML = groups.slice(0, 7).map((group, index) => `<div class="focus-item"><span class="focus-rank">${String(index + 1).padStart(2, "0")}</span><div><div class="focus-topic">${escapeHTML(group.topic)}</div><div class="focus-meta">${escapeHTML(group.subject || "General")} · ${[...group.years].sort().map(escapeHTML).join(", ")}</div></div><span class="focus-frequency">${group.count} ${group.count === 1 ? "year" : "years"}</span></div>`).join("");
        $("#focus-empty").hidden = groups.length > 0;
        $("#entry-count").textContent = `${data.questions.length} ${data.questions.length === 1 ? "entry" : "entries"}`;
        $("#question-table-body").innerHTML = [...data.questions].sort((a, b) => Number(b.year) - Number(a.year) || String(a.topic).localeCompare(String(b.topic))).map((question) => {
          const subject = String(question.subject || "").trim();
          const topic = String(question.topic || "").trim();
          const group = byKey.get(`${subject.toLocaleLowerCase()}::${topic.toLocaleLowerCase()}`);
          const tags = Array.isArray(question.tags) ? question.tags : [];
          return `<tr><td>${escapeHTML(topic)}</td><td>${escapeHTML(subject || "General")}<div class="tag-list" style="margin-top:4px">${tags.length ? tags.map((tag) => `<span class="tag">${escapeHTML(tag)}</span>`).join("") : '<span style="color:var(--text-3)">—</span>'}</div></td><td class="mono">${escapeHTML(question.year)}</td><td><span class="focus-frequency">${group?.count || 1}×</span></td><td><button class="task-action" type="button" data-delete-question="${escapeHTML(question.id)}" aria-label="Delete paper entry">×</button></td></tr>`;
        }).join("");
        $("#question-table-empty").hidden = data.questions.length > 0;
      }

      function renderSettings() {
        $("#storage-summary").textContent = `${data.tasks.length} goals · ${data.modules.length} modules · ${data.flashcards.length} flashcards saved in this browser.`;
      }

      function renderProductivityWidgets() {
        if (document.activeElement !== $("#scratch-notes")) $("#scratch-notes").value = data.notes;
        $("#scratch-character-count").textContent = `${data.notes.length} / 12000`;
        if (document.activeElement !== $("#ambient-track")) $("#ambient-track").value = data.ambientTrack;
        const todayEnergy = data.energyLogs.find((entry) => entry.date === todayISO());
        $("#energy-today-label").textContent = todayEnergy ? `${todayEnergy.level.toUpperCase()} ENERGY` : "NOT LOGGED";
        $$("[data-energy]").forEach((button) => button.classList.toggle("active", button.dataset.energy === todayEnergy?.level));
        const secondsByDate = new Map();
        getUniqueSessions().forEach((session) => {
          if (!dateFromISO(session.date)) return;
          const seconds = session.seconds != null && Number.isFinite(Number(session.seconds)) ? Number(session.seconds) : Math.max(0, Number(session.minutes) || 0) * 60;
          secondsByDate.set(session.date, (secondsByDate.get(session.date) || 0) + seconds);
        });
        const today = dateFromISO(todayISO());
        const cells = [];
        for (let offset = 34; offset >= 0; offset -= 1) {
          const day = new Date(today);
          day.setDate(day.getDate() - offset);
          const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          const seconds = secondsByDate.get(date) || 0;
          const level = seconds === 0 ? 0 : seconds < 1800 ? 1 : seconds < 7200 ? 2 : seconds < 14400 ? 3 : 4;
          cells.push(`<i class="heatmap-cell" data-level="${level}" title="${escapeHTML(day.toLocaleDateString(undefined, { month: "short", day: "numeric" }))} · ${(seconds / 3600).toFixed(1)}h focused"></i>`);
        }
        $("#activity-heatmap").innerHTML = cells.join("");
        const streak = Number($("#study-streak").textContent) || 0;
        $("#heatmap-streak").textContent = `${streak} DAY STREAK`;
      }

      function stopAmbientSound() {
        if (!ambientState) return;
        clearInterval(ambientState.interval);
        ambientState.nodes.forEach((node) => { try { node.stop(); } catch (_) {} });
        const context = ambientState.context;
        ambientState = null;
        $("#ambient-status").textContent = "OFF";
        $("#ambient-toggle").textContent = "Play";
        $("#ambient-toggle").setAttribute("aria-pressed", "false");
        void context.close().catch((error) => console.info("Could not close ambient audio:", error));
      }

      async function toggleAmbientSound() {
        if (ambientState) return stopAmbientSound();
        const track = $("#ambient-track").value;
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) return showToast("Ambient audio is not supported by this browser.");
        let context = null;
        try {
          context = new AudioContextConstructor();
          await context.resume();
          const master = context.createGain();
          master.gain.value = track === "lofi" ? 0.035 : 0.075;
          master.connect(context.destination);
          const nodes = [];
          let interval = null;
          if (track === "lofi") {
            const notes = [130.81, 164.81, 196, 220, 164.81, 146.83, 174.61, 220];
            let index = 0;
            const playNote = () => {
              const oscillator = context.createOscillator();
              const envelope = context.createGain();
              oscillator.type = "triangle";
              oscillator.frequency.value = notes[index++ % notes.length];
              envelope.gain.setValueAtTime(0, context.currentTime);
              envelope.gain.linearRampToValueAtTime(0.32, context.currentTime + 0.08);
              envelope.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 1.35);
              oscillator.connect(envelope);
              envelope.connect(master);
              nodes.push(oscillator);
              oscillator.onended = () => {
                const nodeIndex = nodes.indexOf(oscillator);
                if (nodeIndex >= 0) nodes.splice(nodeIndex, 1);
              };
              oscillator.start();
              oscillator.stop(context.currentTime + 1.4);
            };
            playNote();
            interval = setInterval(playNote, 1050);
          } else {
            const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
            const channel = buffer.getChannelData(0);
            for (let index = 0; index < channel.length; index += 1) channel[index] = (Math.random() * 2 - 1) * 0.32;
            const source = context.createBufferSource();
            const filter = context.createBiquadFilter();
            const texture = context.createGain();
            source.buffer = buffer;
            source.loop = true;
            filter.type = track === "rain" ? "lowpass" : "bandpass";
            filter.frequency.value = track === "rain" ? 1150 : 780;
            filter.Q.value = track === "rain" ? 0.4 : 0.7;
            texture.gain.value = track === "rain" ? 0.52 : 0.34;
            source.connect(filter);
            filter.connect(texture);
            texture.connect(master);
            source.start();
            nodes.push(source);
          }
          ambientState = { context, nodes, interval };
          $("#ambient-status").textContent = track === "rain" ? "RAIN ON" : track === "cafe" ? "CAFÉ ON" : "LO-FI ON";
          $("#ambient-toggle").textContent = "Stop";
          $("#ambient-toggle").setAttribute("aria-pressed", "true");
        } catch (error) {
          console.error("Unable to start ambient sound:", error);
          if (context && context.state !== "closed") void context.close().catch((closeError) => console.info("Could not close ambient audio:", closeError));
          showToast("Couldn't start ambient audio. Check your browser's audio settings.");
        }
      }

      function openNotesDrawer() {
        $("#scratch-drawer").classList.add("open");
        $("#scratch-overlay").classList.add("open");
        $("#scratch-drawer").setAttribute("aria-hidden", "false");
        $("#scratch-overlay").setAttribute("aria-hidden", "false");
        $("#scratch-notes").focus();
      }

      function closeNotesDrawer() {
        $("#scratch-drawer").classList.remove("open");
        $("#scratch-overlay").classList.remove("open");
        $("#scratch-drawer").setAttribute("aria-hidden", "true");
        $("#scratch-overlay").setAttribute("aria-hidden", "true");
        $("#notes-open").focus();
      }

      const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
      const MAX_EXTRACTED_CHARS = 18000;
      const STORAGE_BUCKET = "study-materials";

      function setDocumentUploadStatus(docType, message, isError = false, statusId = `${docType}-upload-status`) {
        const status = $(`#${statusId}`);
        status.textContent = message;
        status.style.color = isError ? "var(--red)" : "";
      }

      function safeDocumentName(name) {
        const leaf = String(name || "study-document").split(/[\\/]/).pop();
        return leaf.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, "_").slice(0, 140) || "study-document";
      }

      function getDocumentExtension(name) {
        return String(name || "").split(".").pop().toLocaleLowerCase();
      }

      async function extractFullDocumentText(file) {
        const extension = getDocumentExtension(file.name);
        if (extension === "txt" || extension === "md") {
          const fullText = await file.text();
          return {
            fullText,
            text: fullText.slice(0, MAX_EXTRACTED_CHARS),
            pagesRead: null,
            totalPages: null,
            truncated: fullText.length > MAX_EXTRACTED_CHARS
          };
        }
        if (extension !== "pdf") throw new Error("Only PDF, TXT, and Markdown files are supported.");
        if (!window.pdfjsLib?.getDocument) throw new Error("PDF text extraction is unavailable; the file can still be stored and previewed.");
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        let fullText = "";
        let truncated = false;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ");
          fullText += `${fullText ? "\n" : ""}${pageText}`;
          if (fullText.length > MAX_EXTRACTED_CHARS) truncated = true;
        }
        return {
          fullText,
          text: fullText.slice(0, MAX_EXTRACTED_CHARS),
          pagesRead: pdf.numPages,
          totalPages: pdf.numPages,
          truncated
        };
      }

      async function uploadStudyDocument(file, docType, subjectInputSelector = "") {
        if (!["module", "pyq"].includes(docType)) throw new Error("Choose a supported document category.");
        if (!file || !file.name) throw new Error("Choose a document to upload.");
        if (!authUser || !supabaseClient) throw new Error("Sign in to upload documents to your private library.");
        if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) throw new Error("Choose a non-empty file smaller than 20 MB.");
        const extension = getDocumentExtension(file.name);
        if (!["pdf", "txt", "md"].includes(extension)) throw new Error("Choose a PDF, TXT, or Markdown file.");
        if (data.documents.length >= 100) throw new Error("Your library has reached the 100-document limit.");

        const userId = authUser.id;
        const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError) throw sessionError;
        if (!sessionData.session || sessionData.session.user.id !== userId) throw new Error("Your session changed. Sign in again before uploading.");

        const inputId = subjectInputSelector || (docType === "module" ? "#module-document-subject" : "#pyq-document-subject");
        const subjectInput = $(inputId);
        const subject = subjectInput?.value.trim().slice(0, 60) || "";
        let extractedText = "";
        let extractedFullText = "";
        let extractionWarning = "";
        try {
          const extraction = await extractFullDocumentText(file);
          extractedText = extraction.text;
          extractedFullText = extraction.fullText;
          if (!extractedText.trim()) extractionWarning = "No selectable text found; scanned PDFs need OCR.";
          else if (extraction.truncated) extractionWarning = `All ${extraction.pagesRead ?? "file"} ${extraction.pagesRead ? "PDF pages were read" : "text was read"}; the saved searchable excerpt is limited to ${MAX_EXTRACTED_CHARS.toLocaleString()} characters to protect browser storage.`;
        } catch (error) {
          throw new Error(`Could not extract the full document text, so it was not uploaded: ${error.message || "Text extraction failed."}`);
        }

        const id = makeId();
        const objectPath = `${userId}/${docType}/${id}_${safeDocumentName(file.name)}`;
        const contentType = extension === "pdf" ? "application/pdf" : extension === "md" ? "text/markdown" : "text/plain";
        const { error: uploadError } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(objectPath, file, {
          cacheControl: "3600", contentType, upsert: false
        });
        if (uploadError) throw uploadError;

        let databaseRecord;
        try {
          const { data: savedRecord, error: insertError } = await supabaseClient.from("study_materials").insert({
            user_id: userId,
            title: file.name.slice(0, 240),
            extracted_text: extractedFullText,
            file_type: docType,
            category: docType === "pyq" ? "question_paper" : "lecture_notes",
            storage_path: objectPath,
            subject,
            mime_type: contentType,
            file_size: file.size
          }).select("id").single();
          if (insertError) throw insertError;
          if (!savedRecord?.id) throw new Error("Supabase did not return the saved study-material record.");
          databaseRecord = savedRecord;
        } catch (error) {
          const { error: rollbackError } = await supabaseClient.storage.from(STORAGE_BUCKET).remove([objectPath]);
          if (rollbackError) console.error("Could not roll back the uploaded file after its database insert failed:", rollbackError);
          throw new Error(`The file could not be recorded in public.study_materials: ${error.message || "Check the table and its RLS policies."}`);
        }

        const documentRecord = {
          id, studyMaterialId: String(databaseRecord.id), path: objectPath, name: safeDocumentName(file.name), docType, subject,
          mimeType: contentType, size: file.size, createdAt: new Date().toISOString(), ownerId: userId,
          extractedText, extractionWarning
        };
        data.documents = [...data.documents, documentRecord];
        if (!saveData()) {
          data.documents = data.documents.filter((document) => document.id !== id);
          const { error: databaseRollbackError } = await supabaseClient.from("study_materials").delete()
            .eq("id", databaseRecord.id).eq("user_id", userId);
          if (databaseRollbackError) console.error("Could not roll back the study-material row after local storage failed:", databaseRollbackError);
          const { error: rollbackError } = await supabaseClient.storage.from(STORAGE_BUCKET).remove([objectPath]);
          if (rollbackError) console.error("Could not roll back an uploaded document after local storage failed:", rollbackError);
          throw new Error("The document could not be saved to local planner data.");
        }
        render();
        showToast(extractionWarning
          ? `Uploaded ${file.name}; note: ${extractionWarning}`
          : `${docType === "pyq" ? "PYQ" : "Module"} document uploaded and analyzed.`);
        return documentRecord;
      }

      async function previewStudyDocument(documentId) {
        const document = data.documents.find((item) => item.id === documentId);
        if (!document) return showToast("That document is no longer in your library.");
        if (!supabaseClient || !authUser || document.ownerId !== authUser.id) return showToast("Sign in to the account that owns this document to preview it.");
        const preview = window.open("about:blank", "_blank");
        if (preview) {
          preview.opener = null;
          preview.document.title = "Loading private study document…";
          preview.document.body.textContent = "Creating a temporary private preview link…";
        }
        try {
          const { data: result, error } = await supabaseClient.storage.from(STORAGE_BUCKET).createSignedUrl(document.path, 60);
          if (error) throw error;
          if (!result?.signedUrl) throw new Error("Supabase did not return a preview link.");
          if (preview) preview.location.replace(result.signedUrl);
          else window.location.assign(result.signedUrl);
        } catch (error) {
          preview?.close();
          console.error("Could not create a private document preview:", error);
          showToast(`Couldn't preview this document: ${error.message || "Check Storage setup and access policies."}`);
        }
      }

      async function deleteStudyDocument(documentId) {
        const document = data.documents.find((item) => item.id === documentId);
        if (!document) return;
        if (!authUser || !supabaseClient || document.ownerId !== authUser.id) {
          return showToast("Sign in to the account that owns this document to delete it.");
        }
        if (!window.confirm(`Delete "${document.name}" from your private study library?`)) return;
        const previous = data.documents;
        data.documents = data.documents.filter((item) => item.id !== documentId);
        if (!saveData()) {
          data.documents = previous;
          return;
        }
        const { error } = await supabaseClient.storage.from(STORAGE_BUCKET).remove([document.path]);
        if (error) {
          data.documents = previous;
          saveData();
          console.error("Could not delete study document from Supabase Storage:", error);
          showToast(`The file wasn't deleted: ${error.message || "Check your Storage permissions."}`);
          return;
        }
        render();
        const { error: rowDeleteError } = await supabaseClient.from("study_materials").delete()
          .eq("storage_path", document.path).eq("user_id", authUser.id);
        if (rowDeleteError) {
          console.error("The document file was deleted, but its study-material database row could not be removed:", rowDeleteError);
          showToast(`File deleted, but its database record could not be removed: ${rowDeleteError.message || "Check the study_materials delete policy."}`);
          return;
        }
        showToast("Document and study-material record deleted.");
      }

      function renderDocuments() {
        const documents = visibleStudyDocuments();
        $("#document-count").textContent = `${documents.length} ${documents.length === 1 ? "document" : "documents"}`;
        $("#documents-empty").hidden = documents.length > 0;
        $("#document-list").innerHTML = documents.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((document) => {
          const isOwner = Boolean(authUser && document.ownerId === authUser.id);
          const badge = document.docType === "pyq" ? "PYQ" : "Module";
          const date = new Date(document.createdAt);
          const dateLabel = Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
          const warning = document.extractionWarning ? ` · ${document.extractionWarning}` : "";
          return `<article class="document-row">
            <div><div class="document-name"><span class="document-type ${document.docType === "pyq" ? "pyq" : ""}">${badge}</span>${escapeHTML(document.name)}</div>
              <div class="document-detail">${escapeHTML(document.subject || "General")} · ${escapeHTML(dateLabel)} · ${(document.size / 1024 / 1024).toFixed(1)} MB${escapeHTML(warning)}</div></div>
            <div class="document-actions"><button class="quiet-btn" type="button" data-preview-document="${escapeHTML(document.id)}" ${isOwner ? "" : "disabled"}>Preview</button><button class="quiet-btn" type="button" data-delete-document="${escapeHTML(document.id)}" aria-label="Delete ${escapeHTML(document.name)}" ${isOwner ? "" : "disabled"}>Delete</button></div>
          </article>`;
        }).join("");
        const sourceSelect = $("#focus-document-select");
        const selectedSource = documents.some((document) => document.id === sourceSelect.value) ? sourceSelect.value : "";
        sourceSelect.innerHTML = `<option value="">Choose an uploaded document</option>${documents.map((document) =>
          `<option value="${escapeHTML(document.id)}">${escapeHTML(document.docType === "pyq" ? "PYQ" : "Module")} · ${escapeHTML(document.name)}</option>`
        ).join("")}`;
        sourceSelect.value = selectedSource;
        renderFocusWorkspace();
      }

      function documentTopicPhrases(text) {
        const phrases = new Set();
        const lines = String(text || "").replace(/\r/g, "\n").split(/\n+/);
        lines.forEach((line) => {
          const trimmed = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
          if (trimmed.length >= 5 && trimmed.length <= 100 && /[a-z]/i.test(trimmed)) phrases.add(trimmed);
        });
        const unitPattern = /\b(?:unit|chapter|module|topic|section)\s+\d{1,2}(?:\s*[:—-]\s*[^.;\n]{2,75})?/gi;
        for (const match of String(text || "").matchAll(unitPattern)) phrases.add(match[0].trim());
        return [...phrases].slice(0, 100);
      }

      function topicKey(topic) {
        return String(topic || "").toLocaleLowerCase().normalize("NFKD")
          .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
      }

      function buildExamAnalysisPayload(subjectFilter = "") {
        const matchesSubject = (subject) => !subjectFilter
          || String(subject || "").toLocaleLowerCase() === subjectFilter.toLocaleLowerCase();
        const documents = visibleStudyDocuments().filter((document) => document.extractedText && matchesSubject(document.subject))
          .map((document) => ({
            id: document.id,
            name: document.name,
            docType: document.docType,
            subject: document.subject,
            extractedText: document.extractedText
          }));
        return {
          subjectFilter,
          questions: data.questions.filter((question) => matchesSubject(question.subject)),
          modules: data.modules.filter((module) => matchesSubject(module.subject)),
          moduleDocuments: documents.filter((document) => document.docType === "module"),
          pyqDocuments: documents.filter((document) => document.docType === "pyq")
        };
      }

      const TOPIC_EVIDENCE_STOP_WORDS = new Set([
        "about", "after", "also", "been", "being", "between", "could", "does", "from", "have", "into",
        "more", "most", "other", "over", "such", "than", "that", "their", "them", "there", "these",
        "they", "this", "those", "through", "under", "using", "what", "when", "where", "which", "while",
        "with", "would", "your", "explain", "describe", "discuss", "question", "paper", "year", "briefly"
      ]);

      function topicEvidenceTerms(text) {
        return [...new Set(topicKey(text).split(" ")
          .filter((term) => term.length > 2 && !TOPIC_EVIDENCE_STOP_WORDS.has(term)))];
      }

      function analyzeExamTopics(subjectFilter = "", analysisPayload = buildExamAnalysisPayload(subjectFilter)) {
        const candidates = new Map();
        const addCandidate = (label, subject = "", year = null, sourceType = "question", docId = "", moduleWeight = 0) => {
          const cleanLabel = String(label || "").replace(/\s+/g, " ").trim().slice(0, 180);
          const key = topicKey(cleanLabel);
          if (key.length < 3) return;
          const normalizedSubject = String(subject || "").trim();
          if (subjectFilter && normalizedSubject.toLocaleLowerCase() !== subjectFilter.toLocaleLowerCase()) return;
          if (!candidates.has(key)) candidates.set(key, {
            key, topic: cleanLabel, subject: normalizedSubject || "General",
            years: new Set(), pyqDocuments: new Set(), moduleDocuments: new Set(), questionEntries: 0, moduleWeights: []
          });
          const candidate = candidates.get(key);
          if (!candidate.subject || candidate.subject === "General") candidate.subject = normalizedSubject || "General";
          if (year) candidate.years.add(String(year));
          if (sourceType === "question") candidate.questionEntries += 1;
          if (sourceType === "pyq-document" && docId) candidate.pyqDocuments.add(docId);
          if (sourceType === "module-document" && docId) candidate.moduleDocuments.add(docId);
          if (moduleWeight > 0) candidate.moduleWeights.push(moduleWeight);
        };

        analysisPayload.questions.forEach((question) => addCandidate(question.topic, question.subject, question.year));
        analysisPayload.modules.forEach((module) => addCandidate(module.name, module.subject, null, "module", "", Number(module.weight) || 0));
        [...analysisPayload.moduleDocuments, ...analysisPayload.pyqDocuments].forEach((document) => {
          const sourceType = document.docType === "pyq" ? "pyq-document" : "module-document";
          documentTopicPhrases(document.extractedText).forEach((phrase) => addCandidate(phrase, document.subject, null, sourceType, document.id));
        });

        [...candidates.values()].forEach((candidate) => {
          const terms = topicEvidenceTerms(candidate.topic);
          if (terms.length < 2) return;
          const minimumMatches = Math.max(2, Math.ceil(terms.length / 2));
          const matchesTopic = (document) => {
            const documentTerms = new Set(topicEvidenceTerms(document.extractedText));
            return terms.filter((term) => documentTerms.has(term)).length >= minimumMatches;
          };
          analysisPayload.moduleDocuments.filter(matchesTopic)
            .forEach((document) => candidate.moduleDocuments.add(document.id));
          analysisPayload.pyqDocuments.filter(matchesTopic)
            .forEach((document) => candidate.pyqDocuments.add(document.id));
        });

        const totalYears = new Set(analysisPayload.questions.map((question) => String(question.year))).size;
        return [...candidates.values()].map((candidate) => {
          const years = candidate.years.size;
          const pyqSources = candidate.pyqDocuments.size;
          const moduleSources = candidate.moduleDocuments.size;
          const avgModuleWeight = candidate.moduleWeights.length
            ? candidate.moduleWeights.reduce((sum, weight) => sum + weight, 0) / candidate.moduleWeights.length : 0;
          const questionEvidence = candidate.questionEntries > 1 ? 10 : candidate.questionEntries ? 4 : 0;
          const yearScore = totalYears ? Math.min(68, years / Math.min(totalYears, 4) * 68) : 0;
          const documentScore = Math.min(22, pyqSources * 11) + Math.min(10, moduleSources * 5);
          const weightScore = Math.min(15, avgModuleWeight * 0.3);
          const probability = Math.min(96, Math.max(18, Math.round(yearScore + documentScore + questionEvidence + weightScore || (moduleSources ? 38 : 0))));
          return {
            ...candidate, probability,
            reasons: [
              years ? `${years} exam year${years === 1 ? "" : "s"}` : "",
              pyqSources ? `${pyqSources} PYQ file${pyqSources === 1 ? "" : "s"}` : "",
              moduleSources ? `${moduleSources} module source${moduleSources === 1 ? "" : "s"}` : "",
              avgModuleWeight ? `${avgModuleWeight.toFixed(1)}% module weight` : "",
              candidate.questionEntries ? `${candidate.questionEntries} logged entr${candidate.questionEntries === 1 ? "y" : "ies"}` : ""
            ].filter(Boolean)
          };
        }).sort((a, b) => b.probability - a.probability || b.years.size - a.years.size || a.topic.localeCompare(b.topic))
          .slice(0, 12);
      }

      function renderDocumentSubjectOptions() {
        const select = $("#predictor-subject");
        const current = select.value;
        const subjects = [...new Set([
          ...data.modules.map((module) => module.subject),
          ...data.questions.map((question) => question.subject),
          ...visibleStudyDocuments().map((document) => document.subject)
        ].map((subject) => String(subject || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        select.innerHTML = `<option value="">All subjects</option>${subjects.map((subject) => `<option value="${escapeHTML(subject)}">${escapeHTML(subject)}</option>`).join("")}`;
        if (subjects.includes(current)) select.value = current;
      }

      const ANSWER_STOP_WORDS = new Set([
        "about", "after", "also", "among", "because", "been", "being", "between", "could", "does", "from",
        "have", "into", "more", "most", "other", "over", "such", "than", "that", "their", "them", "there",
        "these", "they", "this", "those", "through", "under", "using", "what", "when", "where", "which",
        "while", "with", "would", "your", "explain", "describe", "discuss", "principles", "process", "key"
      ]);

      function topicTerms(topic) {
        return topicKey(topic).split(" ").filter((word) => word.length > 2 && !ANSWER_STOP_WORDS.has(word));
      }

      function generateModelAnswer(item) {
        const terms = topicTerms(item.topic);
        const sources = visibleStudyDocuments().filter((document) => document.docType === "module"
          && document.extractedText
          && (!item.subject || item.subject === "General" || !document.subject
            || document.subject.toLocaleLowerCase() === item.subject.toLocaleLowerCase()));
        const scoredSentences = [];
        sources.forEach((document) => {
          const sentences = document.extractedText
            .replace(/\r/g, "\n")
            .split(/(?<=[.!?])\s+|\n+/)
            .map((sentence) => sentence.replace(/\s+/g, " ").trim())
            .filter((sentence) => sentence.length >= 24 && sentence.length <= 500);
          sentences.forEach((sentence) => {
            const normalized = topicKey(sentence);
            const hits = terms.filter((term) => normalized.split(" ").includes(term)).length;
            const score = terms.length ? hits / terms.length : 0;
            if (hits > 0) scoredSentences.push({ sentence, score, hits, source: document.name });
          });
        });
        const chosen = [];
        const sentenceKeys = new Set();
        scoredSentences.sort((a, b) => b.score - a.score || b.hits - a.hits || a.sentence.length - b.sentence.length)
          .forEach((candidate) => {
            const key = topicKey(candidate.sentence);
            if (!sentenceKeys.has(key) && chosen.length < 3) {
              sentenceKeys.add(key);
              chosen.push(candidate);
            }
          });
        if (!chosen.length) {
          return {
            text: "No matching explanation was found in the extracted module text. Add searchable lecture notes or a text-readable module PDF; this tool does not invent an answer.",
            sources: []
          };
        }
        return {
          text: chosen.map((item) => item.sentence).join(" "),
          sources: [...new Set(chosen.map((item) => item.source))]
        };
      }

      function renderPredictionAnswer(item, index) {
        const answer = generateModelAnswer(item);
        const sourceLabel = answer.sources.length ? `\n\nSource: ${answer.sources.join(", ")}` : "";
        return `<div class="prediction-answer" data-answer-body="${index}" hidden><strong>Source-based answer</strong><br>${escapeHTML(answer.text)}${escapeHTML(sourceLabel)}</div>`;
      }

      function renderFocusWorkspace() {
        const selectedId = $("#focus-document-select").value;
        const selectedDocument = visibleStudyDocuments().find((document) => document.id === selectedId);
        $("#focus-source-title").textContent = selectedDocument?.name || "Source material";
        $("#focus-source-empty").hidden = Boolean(selectedDocument?.extractedText);
        $("#focus-source-empty").textContent = selectedDocument
          ? selectedDocument.extractedText ? "" : selectedDocument.extractionWarning || "No text was extracted from this document. Preview the original PDF instead."
          : "Choose an uploaded document to view its extracted text here.";
        $("#focus-source-text").hidden = !selectedDocument?.extractedText;
        $("#focus-source-text").textContent = selectedDocument?.extractedText || "";
        const preview = $("#focus-preview-document");
        preview.hidden = !selectedDocument;
        preview.disabled = !authUser || selectedDocument?.ownerId !== authUser?.id;

        const questionList = $("#focus-question-list");
        questionList.innerHTML = predictionResults.map((item, index) => `<article class="focus-question"><strong>${escapeHTML(item.question || `Explain the key ideas and significance of ${item.topic}.`)}</strong><div class="prediction-reason">${item.probability}% estimated signal · ${escapeHTML(item.topic)}</div><button class="prediction-answer-toggle" type="button" data-answer-index="${index}" aria-expanded="false">Show source-based answer</button>${renderPredictionAnswer(item, index)}</article>`).join("");
        const taskList = $("#focus-task-list");
        const openTasks = data.tasks.filter((task) => taskStatus(task) !== "done")
          .slice().sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999"))).slice(0, 12);
        taskList.innerHTML = openTasks.map((task) => `<label class="focus-task"><input type="checkbox" data-focus-task="${escapeHTML(task.id)}"><span>${escapeHTML(task.title)} · ${escapeHTML(friendlyDue(task.due))}</span></label>`).join("");
        const showingTasks = focusPaneMode === "tasks";
        $("#focus-task-list").hidden = !showingTasks;
        $("#focus-question-list").hidden = showingTasks;
        $("#focus-pane-mode").textContent = showingTasks ? "Show questions" : "Show tasks";
        $("#focus-pane-mode").setAttribute("aria-pressed", String(showingTasks));
        $("#focus-pane-empty").hidden = showingTasks ? openTasks.length > 0 : predictionResults.length > 0;
        $("#focus-pane-empty").textContent = showingTasks
          ? "No open tasks. Add a study goal from the dashboard."
          : "Analyze your materials to populate this pane with revision questions.";
      }

      function renderPredictionResults() {
        const list = $("#prediction-list");
        const empty = $("#prediction-empty");
        list.innerHTML = predictionResults.map((item) => {
          const tone = item.probability >= 70 ? "" : item.probability >= 45 ? "medium" : "low";
          const uniqueYears = [...item.years].sort((a, b) => Number(a) - Number(b));
          const prompt = item.question || `Explain the key ideas, evidence, and significance of ${item.topic}.`;
          const details = [
            item.reasons.join(" · ") || "Inferred from the uploaded study material",
            uniqueYears.length ? `Years: ${uniqueYears.join(", ")}` : "",
          ].filter(Boolean).join(" · ");
          return `<article class="prediction-item"><span class="prediction-score ${tone}">${item.probability}%</span><div><div class="prediction-title">${escapeHTML(prompt)}</div><div class="prediction-reason">${escapeHTML(`${item.topic} · ${details}`)}</div><button class="prediction-answer-toggle" type="button" data-answer-index="${predictionResults.indexOf(item)}" aria-expanded="false">Show source-based answer</button>${renderPredictionAnswer(item, predictionResults.indexOf(item))}</div><span class="prediction-confidence">${item.probability >= 70 ? "Higher" : item.probability >= 45 ? "Moderate" : "Emerging"} signal</span></article>`;
        }).join("");
        empty.hidden = predictionResults.length > 0;
        renderConceptMap();
        renderReminderOptions();
        renderFocusWorkspace();
      }

      function handlePredictionAnswerClick(event) {
        const button = event.target.closest("[data-answer-index]");
        if (!button) return;
        const index = Number(button.dataset.answerIndex);
        if (!Number.isInteger(index) || !predictionResults[index]) return;
        const answer = button.closest("article")?.querySelector(`[data-answer-body="${index}"]`);
        if (!answer) return;
        answer.hidden = !answer.hidden;
        button.setAttribute("aria-expanded", String(!answer.hidden));
        button.textContent = answer.hidden ? "Show source-based answer" : "Hide source-based answer";
      }

      function exportStudySheet() {
        if (!predictionResults.length) {
          showToast("Analyze your study materials before exporting a study sheet.");
          return;
        }
        const lines = [
          "# Studyspace · Predicted study sheet",
          "",
          `Generated: ${new Date().toLocaleString()}`,
          "",
          "> Topic percentages are heuristic estimates from your uploaded materials and paper history, not exam guarantees. Answers below are excerpts from your module text, not AI-generated responses.",
          ""
        ];
        predictionResults.forEach((item, index) => {
          const answer = generateModelAnswer(item);
          lines.push(
            `## ${index + 1}. ${item.question || `Explain the key ideas and significance of ${item.topic}.`}`,
            "",
            `**Topic:** ${item.topic}  `,
            `**Estimated signal:** ${item.probability}%  `,
            `**Evidence:** ${item.reasons.join("; ") || "Inferred from uploaded study material"}${item.years.size ? `; years: ${[...item.years].sort().join(", ")}` : ""}`,
            "",
            "**Source-based answer**",
            "",
            answer.text,
            answer.sources.length ? `\n\n*Source: ${answer.sources.join(", ")}*` : "",
            ""
          );
        });
        const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `studyspace-study-sheet-${todayISO()}.md`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast("Study sheet exported.");
      }

      function renderConceptMap() {
        const container = $("#concept-map");
        if (!predictionResults.length) {
          container.innerHTML = '<div class="empty-state"><strong>No concept map yet.</strong><span>Run the topic analyzer to build a visual revision tree.</span></div>';
          return;
        }
        const nodes = predictionResults.slice(0, 8).map((item) => {
          const relatedCards = data.flashcards.filter((card) => !item.subject || card.subject?.toLocaleLowerCase() === item.subject.toLocaleLowerCase());
          const excerpt = data.documents.find((document) => document.extractedText && topicKey(document.extractedText).includes(item.key));
          const cardText = relatedCards.slice(0, 2).map((card) => `${card.front} → ${card.back}`).join(" | ");
          const sourceText = excerpt ? excerpt.extractedText.slice(0, 320) : "";
          const explanation = [item.reasons.join(" · "), sourceText, cardText].filter(Boolean).join(" — ")
            || "Add a flashcard for this topic to attach a recall prompt.";
          return `<details class="concept-node"><summary>${escapeHTML(item.topic)} · ${item.probability}%</summary><p>${escapeHTML(explanation)}</p></details>`;
        }).join("");
        container.innerHTML = `<div class="concept-root">Exam focus · ${predictionResults.length} topics</div><div class="concept-branches">${nodes}</div>`;
      }

      function renderReminderOptions() {
        const select = $("#reminder-topic");
        const current = select.value;
        select.innerHTML = predictionResults.length
          ? predictionResults.map((item) => `<option value="${escapeHTML(item.topic)}">${escapeHTML(item.topic)}</option>`).join("")
          : '<option value="">Analyze topics first</option>';
        if (predictionResults.some((item) => item.topic === current)) select.value = current;
        const notificationState = !("Notification" in window) ? "UNAVAILABLE"
          : Notification.permission === "granted" ? "ENABLED"
          : Notification.permission === "denied" ? "BLOCKED" : "ASK ON REMINDER";
        $("#reminder-permission-status").textContent = notificationState;
        $("#cancel-topic-reminder").hidden = !data.topicReminder;
        if (!data.topicReminder) {
          $("#reminder-current").textContent = "No topic reminder scheduled.";
        } else {
          const remaining = Date.parse(data.topicReminder.dueAt) - Date.now();
          $("#reminder-current").textContent = remaining > 0
            ? `Reminder set for “${data.topicReminder.topic}” · ${new Date(data.topicReminder.dueAt).toLocaleString()}`
            : `Reminder for “${data.topicReminder.topic}” is due; waiting for the page to deliver it.`;
        }
      }

      async function runExamPrediction() {
        predictionHasRun = true;
        const subjectFilter = $("#predictor-subject").value;
        const analysisPayload = buildExamAnalysisPayload(subjectFilter);
        predictionResults = analyzeExamTopics(subjectFilter, analysisPayload);
        renderPredictionResults();
        if (!predictionResults.length) return showToast("No readable topics found. Add past-paper entries or upload text-readable PDFs/notes.");
        showToast(`Analyzed study data and ranked ${predictionResults.length} topic hotspots.`);
      }

      async function deliverTopicReminder() {
        const reminder = data.topicReminder;
        if (!reminder) return;
        data.topicReminder = null;
        clearTimeout(topicReminderTimeout);
        topicReminderTimeout = null;
        saveData();
        renderReminderOptions();
        const message = `Time to revise: ${reminder.topic}`;
        showToast(message);
        if ("Notification" in window && Notification.permission === "granted") {
          try { new Notification("Studyspace topic reminder", { body: message, tag: "studyspace-topic-reminder" }); }
          catch (error) { console.error("Could not show topic reminder notification:", error); }
        }
      }

      function scheduleSavedTopicReminder() {
        clearTimeout(topicReminderTimeout);
        if (!data.topicReminder) return;
        const remaining = Date.parse(data.topicReminder.dueAt) - Date.now();
        if (remaining <= 0) {
          void deliverTopicReminder();
          return;
        }
        topicReminderTimeout = setTimeout(() => { void deliverTopicReminder(); }, Math.min(remaining, 2_147_000_000));
      }

      async function scheduleTopicReminder() {
        const topic = $("#reminder-topic").value;
        const delayMinutes = Number($("#reminder-delay").value);
        if (!topic || !predictionResults.some((item) => item.topic === topic)) return showToast("Analyze your topics and choose one for the reminder.");
        if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 10080) return showToast("Choose a valid reminder time.");
        if (!("Notification" in window)) showToast("Browser notifications aren't supported; an in-app reminder will still be set.");
        else if (Notification.permission === "default") {
          try { await Notification.requestPermission(); }
          catch (error) { console.error("Could not request notification permission:", error); }
        }
        const previous = data.topicReminder;
        data.topicReminder = { topic, dueAt: new Date(Date.now() + delayMinutes * 60000).toISOString() };
        if (!saveData()) { data.topicReminder = previous; return; }
        scheduleSavedTopicReminder();
        renderReminderOptions();
        showToast(`Reminder set for ${topic}. Keep this page open to receive it on time.`);
      }

      function render() {
        renderHeader();
        renderSummary();
        renderStudyAnalytics();
        renderTasks();
        renderProductivityWidgets();
        renderPredictor();
        renderModules();
        renderSchedule();
        renderFlashcards();
        renderTimer();
        renderDocuments();
        renderDocumentSubjectOptions();
        if (predictionHasRun) predictionResults = analyzeExamTopics($("#predictor-subject").value);
        renderPredictionResults();
        renderSettings();
        scheduleSavedTopicReminder();
      }

      function setTheme(theme, persist = false) {
        const dark = theme === "dark";
        document.documentElement.dataset.theme = dark ? "dark" : "light";
        document.documentElement.classList.toggle("dark", dark);
        const toggle = $("#theme-toggle");
        const label = `Switch to ${dark ? "light" : "dark"} mode`;
        toggle.setAttribute("aria-label", label);
        toggle.setAttribute("title", label);
        toggle.setAttribute("aria-pressed", String(dark));
        $("#settings-theme-toggle").setAttribute("aria-checked", String(dark));
        $("#settings-theme-toggle").setAttribute("aria-label", dark ? "Use light appearance" : "Use dark appearance");
        $("#theme-setting-label").textContent = dark ? "Dark appearance" : "Light appearance";
        $("meta[name='theme-color']").content = dark ? "#11131a" : "#f6f8fc";
        if (persist) {
          try {
            localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
            data.preferences = { ...data.preferences, theme: dark ? "dark" : "light" };
            saveData();
          }
          catch (error) { console.error("Could not save appearance preference:", error); showToast("Couldn't save the theme preference."); }
        }
      }

      function navigate(view) {
        const validViews = ["dashboard", "predictor", "intelligence", "schedule", "modules", "flashcards", "settings"];
        const valid = validViews.includes(view) ? view : "dashboard";
        $$(".page-view").forEach((section) => { section.hidden = section.id !== `${valid}-view`; });
        $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === valid));
        $("#crumb-section").textContent = ({ dashboard: "Workspace", predictor: "Exam insights", intelligence: "AI exam predictor", schedule: "Study schedule", modules: "Module tracker", flashcards: "Quick revise", settings: "Settings" })[valid];
        if (location.hash !== `#${valid}`) history.replaceState(null, "", `#${valid}`);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }

      function openTaskDialog(task = null) {
        $("#task-form").reset();
        $("#task-id").value = task?.id || "";
        $("#task-dialog-title").textContent = task ? "Edit study goal" : "Add a study goal";
        $("#task-title-input").value = task?.title || "";
        $("#task-description").value = task?.description || "";
        $("#task-priority").value = ["high", "medium", "low"].includes(task?.priority) ? task.priority : "medium";
        $("#task-due").value = task?.due || todayISO();
        updateTimerLinkOptions();
        $("#task-module").innerHTML = `<option value="">No module</option>${data.modules.map((module) => `<option value="${escapeHTML(module.id)}">${escapeHTML(module.subject)} · ${escapeHTML(module.name)}</option>`).join("")}`;
        $("#task-module").value = task?.moduleId || "";
        $("#task-subject").value = task?.subject || "";
        const subjectKey = String(task?.subject || "").toLocaleLowerCase();
        $("#task-subject-color").value = /^#[0-9a-f]{6}$/i.test(task?.subjectColor || "")
          ? task.subjectColor : (/^#[0-9a-f]{6}$/i.test(data.subjectColors[subjectKey] || "") ? data.subjectColors[subjectKey] : "#718096");
        $("#task-status").value = taskStatus(task || {});
        $("#task-subtasks").value = (Array.isArray(task?.subtasks) ? task.subtasks : []).map((item) => item.text).join("\n");
        if (typeof $("#task-dialog").showModal === "function") $("#task-dialog").showModal();
        else $("#task-dialog").setAttribute("open", "");
        $("#task-title-input").focus();
      }

      function closeDialog(dialog) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }

      function exportBackup() {
        const contents = {
          ...data,
          documents: authUser ? data.documents.filter((document) => document.ownerId === authUser.id) : data.documents,
          timer: data.timer ? { ...data.timer } : null,
          exportedAt: new Date().toISOString()
        };
        if (contents.timer?.running) {
          contents.timer.remaining = timerRemaining();
          contents.timer.running = false;
          contents.timer.paused = true;
          delete contents.timer.startedAt;
        }
        const blob = new Blob([JSON.stringify(contents, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `studyspace-backup-${todayISO()}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast("Backup downloaded.");
      }

      function validImport(value) {
        const record = (item) => item !== null && typeof item === "object" && !Array.isArray(item);
        if (!record(value) || !Array.isArray(value.tasks)) return false;
        return value.tasks.every((task) => record(task) && typeof task.title === "string" && typeof task.id === "string"
            && (task.status == null || ["todo", "in_progress", "done"].includes(task.status))
            && (task.subtasks == null || (Array.isArray(task.subtasks) && task.subtasks.every((item) => record(item) && typeof item.text === "string"))))
          && (value.questions == null || (Array.isArray(value.questions) && value.questions.every((question) =>
            record(question) && typeof question.topic === "string" && Number.isInteger(Number(question.year)))))
          && (value.modules == null || (Array.isArray(value.modules) && value.modules.every((module) => record(module) && typeof module.id === "string" && typeof module.name === "string")))
          && (value.logs == null || (Array.isArray(value.logs) && value.logs.every((session) => record(session) && typeof session.date === "string")))
          && (value.sessions == null || (Array.isArray(value.sessions) && value.sessions.every((session) => record(session) && typeof session.date === "string")))
          && (value.flashcards == null || (Array.isArray(value.flashcards) && value.flashcards.every((card) => record(card) && typeof card.id === "string" && typeof card.front === "string" && typeof card.back === "string")))
          && (value.timer == null || (record(value.timer) && ["focus", "break"].includes(value.timer.mode) && Number.isFinite(Number(value.timer.remaining)) && Number(value.timer.remaining) >= 0 && Number(value.timer.remaining) <= TIMER_LENGTHS[value.timer.mode]))
          && (value.viewMode == null || ["list", "kanban"].includes(value.viewMode))
          && (value.targetExam == null || (record(value.targetExam) && dateFromISO(value.targetExam.date) && (value.targetExam.label == null || typeof value.targetExam.label === "string")))
          && (value.notes == null || typeof value.notes === "string")
          && (value.subjectColors == null || record(value.subjectColors))
          && (value.energyLogs == null || (Array.isArray(value.energyLogs) && value.energyLogs.every((entry) => record(entry) && typeof entry.date === "string" && ["high", "medium", "low"].includes(entry.level))))
          && (value.documents == null || (Array.isArray(value.documents) && value.documents.length <= 100 && value.documents.every((item) =>
            record(item) && typeof item.id === "string" && typeof item.path === "string" && typeof item.name === "string"
            && ["module", "pyq"].includes(item.docType) && (item.extractedText == null || typeof item.extractedText === "string"))))
          && (value.topicReminder == null || (record(value.topicReminder) && typeof value.topicReminder.topic === "string" && Number.isFinite(Date.parse(value.topicReminder.dueAt))));
      }

      $("#theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true));
      $("#settings-theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true));
      $$("[data-view-link]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); navigate(link.dataset.viewLink); }));
      $("#mobile-menu").addEventListener("click", () => navigate("dashboard"));
      window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
      window.addEventListener("online", () => {
        if (authUser && cloudSyncAllowed) scheduleCloudSync();
      });
      window.addEventListener("offline", () => {
        if (authUser) setCloudStatus("Offline · changes remain saved on this device.");
      });
      $("#open-task-modal").addEventListener("click", () => openTaskDialog());
      $("#panel-add-task").addEventListener("click", () => openTaskDialog());
      $("#quick-add-module").addEventListener("click", () => openModuleDialog());
      $("#add-module-button").addEventListener("click", () => openModuleDialog());
      $("#add-flashcard-button").addEventListener("click", () => openFlashcardDialog());
      $("#timer-play").addEventListener("click", () => data.timer?.running ? pauseTimer() : startTimer());
      $("#timer-reset").addEventListener("click", resetTimer);
      $$(".timer-mode-button").forEach((button) => button.addEventListener("click", () => setTimerMode(button.dataset.timerMode)));
      $("#timer-link").addEventListener("change", () => {
        const timer = data.timer || { mode: "focus", remaining: TIMER_LENGTHS.focus, running: false };
        timer.link = $("#timer-link").value;
        data.timer = timer;
        persistTimerState();
        renderTimer();
      });
      $$("[data-task-view]").forEach((button) => button.addEventListener("click", () => {
        if (data.viewMode === button.dataset.taskView) return;
        data.viewMode = button.dataset.taskView;
        if (saveData()) renderTasks();
      }));
      $("#save-exam-target").addEventListener("click", saveExamDate);
      $("#exam-countdown-trigger").addEventListener("click", () => {
        examDateSettingsOpen = true;
        renderExamCountdown();
        $("#exam-title-input").focus();
      });
      $$("[data-energy]").forEach((button) => button.addEventListener("click", () => {
        const previous = data.energyLogs;
        data.energyLogs = [...data.energyLogs.filter((entry) => entry.date !== todayISO()), { date: todayISO(), level: button.dataset.energy, updatedAt: new Date().toISOString() }];
        if (!saveData()) { data.energyLogs = previous; return; }
        renderProductivityWidgets();
        showToast("Energy check-in saved.");
      }));
      $("#ambient-track").addEventListener("change", () => {
        if (ambientState) stopAmbientSound();
        data.ambientTrack = $("#ambient-track").value;
        saveData();
      });
      $("#ambient-toggle").addEventListener("click", () => { void toggleAmbientSound(); });
      $("#notes-open").addEventListener("click", openNotesDrawer);
      $("#notes-close").addEventListener("click", closeNotesDrawer);
      $("#scratch-overlay").addEventListener("click", closeNotesDrawer);
      $("#scratch-notes").addEventListener("input", () => {
        data.notes = $("#scratch-notes").value;
        $("#scratch-character-count").textContent = `${data.notes.length} / 12000`;
        $("#scratch-save-status").textContent = "Saving…";
        clearTimeout(scratchSaveTimer);
        scratchSaveTimer = setTimeout(() => {
          if (saveData()) $("#scratch-save-status").textContent = "Saved on this device";
        }, 180);
      });
      document.addEventListener("keydown", (event) => {
        const target = event.target;
        const editing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
        if (event.key === "Escape" && $("#scratch-drawer").classList.contains("open")) {
          closeNotesDrawer();
          return;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (event.key.toLowerCase() === "n" && !editing) {
          event.preventDefault();
          openTaskDialog();
        } else if (event.shiftKey && event.key.toLowerCase() === "p") {
          event.preventDefault();
          data.timer?.running ? pauseTimer() : startTimer();
        }
      });
      window.addEventListener("pagehide", stopAmbientSound);
      if (data.timer?.running) {
        if (timerRemaining() <= 0) tickTimer();
        else timerInterval = setInterval(tickTimer, 1000);
      }
      $("#open-session-modal").addEventListener("click", () => {
        $("#session-form").reset();
        $("#session-date").value = todayISO();
        if (typeof $("#session-dialog").showModal === "function") $("#session-dialog").showModal();
        else $("#session-dialog").setAttribute("open", "");
      });
      $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
      $$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
        currentFilter = button.dataset.filter;
        $$("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
        renderTasks();
      }));
      $("#task-search").addEventListener("input", renderTasks);
      $("#task-subject").addEventListener("change", () => {
        const color = data.subjectColors[$("#task-subject").value.trim().toLocaleLowerCase()];
        if (/^#[0-9a-f]{6}$/i.test(color || "")) $("#task-subject-color").value = color;
      });

      function openAuthDialog(mode, email = "") {
        authMode = mode;
        $("#auth-form").reset();
        $("#auth-email").value = email;
        $("#auth-email").readOnly = mode === "recovery";
        $("#auth-password").autocomplete = mode === "recovery" || mode === "signup" ? "new-password" : "current-password";
        $("#auth-password").placeholder = mode === "recovery" ? "Choose a new password" : "At least 8 characters";
        $("#auth-dialog-title").textContent = mode === "signup" ? "Create your account" : mode === "recovery" ? "Set a new password" : "Sign in to sync";
        $("#auth-submit-button").textContent = mode === "signup" ? "Sign up" : mode === "recovery" ? "Update password" : "Login";
        $("#auth-mode-toggle").textContent = "Need an account? Sign up";
        $("#auth-mode-toggle").hidden = mode !== "signin";
        $("#auth-forgot-password").hidden = mode !== "signin";
        $("#auth-config-note").hidden = true;
        setAuthMessage("");
        $("#auth-dialog").showModal();
      }

      $("#auth-open-button").addEventListener("click", () => openAuthDialog("signin"));
      $("#auth-signup-open-button").addEventListener("click", () => openAuthDialog("signup"));
      $("#auth-forgot-password").addEventListener("click", async () => {
        const button = $("#auth-forgot-password");
        button.disabled = true;
        setAuthMessage("Sending password reset link…");
        try {
          await resetPassword($("#auth-email").value);
        } catch (error) {
          console.error("Supabase password reset failed:", error);
          setAuthMessage(error.message || "Could not send a password reset link.", "error");
        } finally {
          button.disabled = false;
        }
      });
      $("#auth-mode-toggle").addEventListener("click", () => {
        authMode = authMode === "signin" ? "signup" : "signin";
        $("#auth-dialog-title").textContent = authMode === "signup" ? "Create your account" : "Sign in to sync";
        $("#auth-submit-button").textContent = authMode === "signup" ? "Sign up" : "Login";
        $("#auth-mode-toggle").textContent = authMode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up";
        $("#auth-password").autocomplete = authMode === "signup" ? "new-password" : "current-password";
        $("#auth-password").placeholder = "At least 8 characters";
        $("#auth-email").readOnly = false;
        $("#auth-forgot-password").hidden = authMode !== "signin";
        $("#auth-mode-toggle").hidden = false;
        setAuthMessage("");
      });
      $("#auth-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!supabaseClient) {
          setAuthMessage("Supabase client is unavailable. Check your connection and reload.", "error");
          return;
        }
        const email = $("#auth-email").value.trim();
        const password = $("#auth-password").value;
        const mode = authMode;
        const submit = $("#auth-submit-button");
        submit.disabled = true;
        setAuthMessage(mode === "signup" ? "Creating your account…" : "Signing you in…");
        try {
          if (mode === "signup") await signUpUser(email, password);
          else if (mode === "recovery") await updateRecoveredPassword(password);
          else await loginUser(email, password);
        } catch (error) {
          console.error(mode === "signup" ? "Supabase signup failed:" : "Supabase login failed:", error);
          setAuthMessage(error.message || "Authentication failed. Please try again.", "error");
        } finally {
          submit.disabled = false;
        }
      });
      $("#auth-logout-button").addEventListener("click", async () => {
        if (!supabaseClient) return;
        $("#auth-logout-button").disabled = true;
        try {
          await logoutUser();
        } catch (error) {
          console.error("Supabase sign-out failed:", error);
          showToast(`Couldn't sign out: ${error.message || "Please try again."}`);
        } finally {
          $("#auth-logout-button").disabled = false;
        }
      });

      $("#task-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const id = $("#task-id").value;
        const existing = data.tasks.find((task) => task.id === id);
        const title = $("#task-title-input").value.trim();
        const due = $("#task-due").value;
        if (!title || !dateFromISO(due)) return showToast("Enter a goal title and valid due date.");
        const status = $("#task-status").value;
        if (!["todo", "in_progress", "done"].includes(status)) return showToast("Choose a valid board status.");
        const moduleId = $("#task-module").value;
        const linkedModule = data.modules.find((module) => module.id === moduleId);
        const subject = $("#task-subject").value.trim() || linkedModule?.subject || "";
        const subjectColor = $("#task-subject-color").value;
        const existingSubtasks = Array.isArray(existing?.subtasks) ? [...existing.subtasks] : [];
        const subtasks = $("#task-subtasks").value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 30).map((text) => {
          const matchIndex = existingSubtasks.findIndex((item) => item.text === text);
          const match = matchIndex < 0 ? null : existingSubtasks.splice(matchIndex, 1)[0];
          return { id: match?.id || makeId(), text: text.slice(0, 180), done: Boolean(match?.done) };
        });
        const task = {
          id: id || makeId(), title, description: $("#task-description").value.trim(),
          priority: $("#task-priority").value, due, status, done: status === "done",
          moduleId, subject, subjectColor, subtasks,
          createdAt: existing?.createdAt || Date.now()
        };
        const next = existing ? data.tasks.map((item) => item.id === id ? task : item) : [...data.tasks, task];
        const prior = data.tasks;
        const previousColors = data.subjectColors;
        if (subject && /^#[0-9a-f]{6}$/i.test(subjectColor)) data.subjectColors = { ...data.subjectColors, [subject.toLocaleLowerCase()]: subjectColor };
        data.tasks = next;
        if (!saveData()) { data.tasks = prior; data.subjectColors = previousColors; return; }
        closeDialog($("#task-dialog"));
        render();
        showToast(existing ? "Study goal updated." : "Study goal added.");
      });

      $("#task-panel").addEventListener("change", (event) => {
        const statusSelect = event.target.closest("[data-task-status]");
        if (statusSelect) {
          const previous = data.tasks;
          data.tasks = data.tasks.map((task) => task.id === statusSelect.dataset.taskStatus ? {
            ...task, status: statusSelect.value, done: statusSelect.value === "done"
          } : task);
          if (!saveData()) { data.tasks = previous; return renderTasks(); }
          return render();
        }
        const subtask = event.target.closest("[data-subtask-task]");
        if (subtask) {
          const previous = data.tasks;
          data.tasks = data.tasks.map((task) => task.id === subtask.dataset.subtaskTask ? {
            ...task, subtasks: task.subtasks.map((item) => item.id === subtask.dataset.subtaskId ? { ...item, done: subtask.checked } : item)
          } : task);
          if (!saveData()) { data.tasks = previous; return renderTasks(); }
          return render();
        }
        const checkbox = event.target.closest("[data-task-toggle]");
        if (!checkbox) return;
        const prior = data.tasks;
        const status = checkbox.checked ? "done" : "todo";
        data.tasks = data.tasks.map((task) => task.id === checkbox.dataset.taskToggle ? { ...task, status, done: checkbox.checked } : task);
        if (!saveData()) { data.tasks = prior; return renderTasks(); }
        render();
      });
      $("#task-kanban").addEventListener("dragstart", (event) => {
        const card = event.target.closest("[data-task-card]");
        if (!card) return;
        event.dataTransfer.setData("text/plain", card.dataset.taskCard);
        event.dataTransfer.effectAllowed = "move";
      });
      $("#task-kanban").addEventListener("dragover", (event) => {
        const column = event.target.closest("[data-kanban-column]");
        if (!column) return;
        event.preventDefault();
        column.classList.add("drag-target");
      });
      $("#task-kanban").addEventListener("dragleave", (event) => {
        const column = event.target.closest("[data-kanban-column]");
        if (column && !column.contains(event.relatedTarget)) column.classList.remove("drag-target");
      });
      $("#task-kanban").addEventListener("drop", (event) => {
        const column = event.target.closest("[data-kanban-column]");
        if (!column) return;
        event.preventDefault();
        column.classList.remove("drag-target");
        const id = event.dataTransfer.getData("text/plain");
        const status = column.dataset.kanbanColumn;
        const previous = data.tasks;
        data.tasks = data.tasks.map((task) => task.id === id ? { ...task, status, done: status === "done" } : task);
        if (!saveData()) { data.tasks = previous; return renderTasks(); }
        render();
      });
      $("#task-panel").addEventListener("click", (event) => {
        const edit = event.target.closest("[data-edit-task]");
        const remove = event.target.closest("[data-delete-task]");
        if (edit) openTaskDialog(data.tasks.find((task) => task.id === edit.dataset.editTask));
        if (remove) {
          const prior = data.tasks;
          data.tasks = data.tasks.filter((task) => task.id !== remove.dataset.deleteTask);
          if (!saveData()) { data.tasks = prior; return; }
          render();
          showToast("Study goal deleted.");
        }
      });
      $("#clear-completed").addEventListener("click", () => {
        const prior = data.tasks;
        data.tasks = data.tasks.filter((task) => taskStatus(task) !== "done");
        if (!saveData()) { data.tasks = prior; return; }
        render();
        showToast("Completed goals cleared.");
      });

      $("#module-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const id = $("#module-id").value;
        const existing = data.modules.find((module) => module.id === id);
        const name = $("#module-name").value.trim();
        const subject = $("#module-subject").value.trim();
        const weightText = $("#module-weight").value;
        const weight = weightText === "" ? "" : Number(weightText);
        if (!name || !subject || (weight !== "" && (!Number.isFinite(weight) || weight < 0 || weight > 100))) return showToast("Enter a module, subject, and a valid weight from 0 to 100.");
        const module = { id: id || makeId(), name, subject, weight, due: $("#module-due").value, examDate: $("#module-exam-date").value, createdAt: existing?.createdAt || Date.now() };
        const previous = data.modules;
        data.modules = existing ? data.modules.map((item) => item.id === id ? module : item) : [...data.modules, module];
        if (!saveData()) { data.modules = previous; return; }
        closeDialog($("#module-dialog"));
        render();
        showToast(existing ? "Module updated." : "Module added.");
      });

      $("#module-list").addEventListener("click", (event) => {
        const edit = event.target.closest("[data-edit-module]");
        const remove = event.target.closest("[data-delete-module]");
        if (edit) openModuleDialog(data.modules.find((module) => module.id === edit.dataset.editModule));
        if (remove) {
          const module = data.modules.find((item) => item.id === remove.dataset.deleteModule);
          if (!module) return;
          if (!window.confirm(`Delete "${module.name}"? Linked goals will remain but lose their module link.`)) return;
          const previousModules = data.modules;
          const previousTasks = data.tasks;
          data.modules = data.modules.filter((item) => item.id !== module.id);
          data.tasks = data.tasks.map((task) => task.moduleId === module.id ? { ...task, moduleId: "" } : task);
          if (!saveData()) { data.modules = previousModules; data.tasks = previousTasks; return; }
          render();
          showToast("Module deleted.");
        }
      });

      $("#schedule-list").addEventListener("click", (event) => {
        const button = event.target.closest("[data-schedule-edit-task]");
        if (button) openTaskDialog(data.tasks.find((task) => task.id === button.dataset.scheduleEditTask));
      });

      $("#flashcard-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const id = $("#flashcard-id").value;
        const existing = data.flashcards.find((card) => card.id === id);
        const front = $("#flashcard-front").value.trim();
        const back = $("#flashcard-back").value.trim();
        if (!front || !back) return showToast("Enter both a prompt and an answer.");
        const card = { id: id || makeId(), front, back, subject: $("#flashcard-subject").value.trim(), createdAt: existing?.createdAt || Date.now() };
        const previous = data.flashcards;
        data.flashcards = existing ? data.flashcards.map((item) => item.id === id ? card : item) : [...data.flashcards, card];
        if (!saveData()) { data.flashcards = previous; return; }
        closeDialog($("#flashcard-dialog"));
        render();
        showToast(existing ? "Flashcard updated." : "Flashcard added.");
      });

      $("#flashcard-list").addEventListener("click", (event) => {
        const reveal = event.target.closest("[data-reveal-card]");
        const edit = event.target.closest("[data-edit-card]");
        const remove = event.target.closest("[data-delete-card]");
        if (reveal) {
          const answer = $(`[data-answer-for="${CSS.escape(reveal.dataset.revealCard)}"]`);
          answer.hidden = !answer.hidden;
          reveal.textContent = answer.hidden ? "Reveal answer" : "Hide answer";
          reveal.setAttribute("aria-expanded", String(!answer.hidden));
        }
        if (edit) openFlashcardDialog(data.flashcards.find((card) => card.id === edit.dataset.editCard));
        if (remove) {
          const previous = data.flashcards;
          data.flashcards = data.flashcards.filter((card) => card.id !== remove.dataset.deleteCard);
          if (!saveData()) { data.flashcards = previous; return; }
          render();
          showToast("Flashcard deleted.");
        }
      });

      $("#session-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const minutes = Number($("#session-minutes").value);
        const date = $("#session-date").value;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || !dateFromISO(date)) return showToast("Enter a valid date and a study duration from 1 to 1,440 minutes.");
        const session = { id: makeId(), date, minutes, createdAt: Date.now() };
        data.sessions = [...data.sessions, session];
        if (!saveData()) { data.sessions.pop(); return; }
        closeDialog($("#session-dialog"));
        render();
        showToast(`${minutes} minutes of study time logged.`);
      });

      $("#question-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const topic = $("#question-topic").value.trim();
        const year = Number($("#question-year").value);
        if (!topic || !Number.isInteger(year) || year < 1900 || year > 2200) return showToast("Enter a question and a valid exam year.");
        const question = {
          id: makeId(), topic, subject: $("#question-subject").value.trim(), year,
          tags: $("#question-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
          createdAt: Date.now()
        };
        data.questions = [...data.questions, question];
        if (!saveData()) { data.questions.pop(); return; }
        $("#question-form").reset();
        $("#question-year").value = String(new Date().getFullYear());
        render();
        showToast("Question added to your paper library.");
      });
      $("#question-table-body").addEventListener("click", (event) => {
        const remove = event.target.closest("[data-delete-question]");
        if (!remove) return;
        const prior = data.questions;
        data.questions = data.questions.filter((question) => question.id !== remove.dataset.deleteQuestion);
        if (!saveData()) { data.questions = prior; return; }
        render();
        showToast("Past-paper entry deleted.");
      });

      async function processStudyDocumentFile(file, input, docType, { statusId = `${docType}-upload-status`, subjectInputSelector = "" } = {}) {
        if (!file || input.disabled) return;
        const acceptedExtension = /\.(?:pdf|txt|md)$/i.test(file.name);
        if (!acceptedExtension) {
          setDocumentUploadStatus(docType, "Choose a PDF, TXT, or MD file.", true, statusId);
          return showToast("Only PDF, TXT, and MD study documents are supported.");
        }
        setDocumentUploadStatus(docType, "Reading document and uploading…", false, statusId);
        input.disabled = true;
        try {
          await uploadStudyDocument(file, docType, subjectInputSelector);
          setDocumentUploadStatus(docType, "Uploaded · choose or drop another file.", false, statusId);
        } catch (error) {
          console.error(`Unable to upload ${docType} study document:`, error);
          setDocumentUploadStatus(docType, error.message || "Upload failed.", true, statusId);
          showToast(error.message || "The document could not be uploaded.");
        } finally {
          input.value = "";
          input.disabled = false;
        }
      }

      [
        { selector: "#module-document-file", docType: "module", dropzone: "module", statusId: "module-upload-status" },
        { selector: "#pyq-document-file", docType: "pyq", dropzone: "pyq", statusId: "pyq-upload-status" },
        { selector: "#paper-pyq-file", docType: "pyq", dropzone: "paper-pyq", statusId: "paper-pyq-upload-status", subjectInputSelector: "#paper-pyq-subject" }
      ].forEach(({ selector, docType, dropzone: dropzoneId, statusId, subjectInputSelector = "" }) => {
        const input = $(selector);
        input.addEventListener("change", async (event) => {
          const [file] = event.currentTarget.files || [];
          if (!file) return;
          await processStudyDocumentFile(file, input, docType, { statusId, subjectInputSelector });
        });
        const dropzone = $(`[data-document-drop="${dropzoneId}"]`);
        ["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          if (event.dataTransfer?.types.includes("Files")) dropzone.classList.add("drag-over");
        }));
        ["dragleave", "dragend"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
          if (eventName === "dragleave" && dropzone.contains(event.relatedTarget)) return;
          dropzone.classList.remove("drag-over");
        }));
        dropzone.addEventListener("drop", async (event) => {
          event.preventDefault();
          dropzone.classList.remove("drag-over");
          const [file] = event.dataTransfer?.files || [];
          if (file) await processStudyDocumentFile(file, input, docType, { statusId, subjectInputSelector });
        });
      });
      $("#document-list").addEventListener("click", (event) => {
        const preview = event.target.closest("[data-preview-document]");
        const remove = event.target.closest("[data-delete-document]");
        if (preview) void previewStudyDocument(preview.dataset.previewDocument);
        if (remove) void deleteStudyDocument(remove.dataset.deleteDocument);
      });
      $("#run-prediction").addEventListener("click", () => { void runExamPrediction(); });
      $("#export-study-sheet").addEventListener("click", exportStudySheet);
      $("#prediction-list").addEventListener("click", handlePredictionAnswerClick);
      $("#focus-question-list").addEventListener("click", handlePredictionAnswerClick);
      $("#focus-document-select").addEventListener("change", renderFocusWorkspace);
      $("#focus-preview-document").addEventListener("click", () => {
        const documentId = $("#focus-document-select").value;
        if (documentId) void previewStudyDocument(documentId);
      });
      $("#focus-pane-mode").addEventListener("click", () => {
        focusPaneMode = focusPaneMode === "questions" ? "tasks" : "questions";
        renderFocusWorkspace();
      });
      $("#focus-task-list").addEventListener("change", (event) => {
        const checkbox = event.target.closest("[data-focus-task]");
        if (!checkbox?.checked) return;
        const previous = data.tasks;
        data.tasks = data.tasks.map((task) => task.id === checkbox.dataset.focusTask
          ? { ...task, status: "done", done: true }
          : task);
        if (!saveData()) { data.tasks = previous; return render(); }
        render();
        showToast("Study goal completed.");
      });
      $("#focus-open-tasks").addEventListener("click", () => {
        navigate("dashboard");
        window.requestAnimationFrame(() => $("#task-panel").scrollIntoView({ behavior: "smooth", block: "start" }));
      });
      $("#predictor-subject").addEventListener("change", () => {
        if (predictionHasRun) predictionResults = analyzeExamTopics($("#predictor-subject").value);
        renderPredictionResults();
      });
      $("#schedule-topic-reminder").addEventListener("click", () => { void scheduleTopicReminder(); });
      $("#cancel-topic-reminder").addEventListener("click", () => {
        const previous = data.topicReminder;
        clearTimeout(topicReminderTimeout);
        topicReminderTimeout = null;
        data.topicReminder = null;
        if (!saveData()) { data.topicReminder = previous; scheduleSavedTopicReminder(); return; }
        renderReminderOptions();
        showToast("Topic reminder cancelled.");
      });

      $("#export-button").addEventListener("click", exportBackup);
      $("#settings-export").addEventListener("click", exportBackup);
      $("#settings-import").addEventListener("click", () => $("#import-file").click());
      $("#import-file").addEventListener("change", async (event) => {
        const [file] = event.target.files || [];
        if (!file) return;
        try {
          const imported = JSON.parse(await file.text());
          if (!validImport(imported)) throw new Error("This file does not contain a valid Studyspace backup.");
          if (!window.confirm("Restoring a backup will replace the study data currently saved in this browser. Continue?")) return;
          const previous = data;
          if (data.timer?.running) finalizeRunningTimer(data.timer);
          data = normalizePlannerData(imported);
          if (!saveData()) { data = previous; return; }
          clearInterval(timerInterval);
          timerInterval = null;
          setTheme(data.preferences.theme || "light");
          render();
          showToast("Backup restored successfully.");
        } catch (error) {
          console.error("Unable to restore backup:", error);
          showToast(error instanceof SyntaxError ? "That file isn't valid JSON." : error.message || "Couldn't restore this backup.");
        } finally {
          event.target.value = "";
        }
      });

      let savedTheme = null;
      try { savedTheme = localStorage.getItem(THEME_KEY); }
      catch (error) { console.error("Could not read appearance preference:", error); }
      setTheme(data.preferences.theme || savedTheme || (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
      $("#question-year").value = String(new Date().getFullYear());
      const initialView = location.hash.slice(1);
      render();
      window.setInterval(() => renderExamCountdown(), 60000);
      navigate(["dashboard", "predictor", "intelligence", "schedule", "modules", "flashcards", "settings"].includes(initialView) ? initialView : "dashboard");
      scheduleSavedTopicReminder();
      const initializeOnReady = () => { void initializeSupabase(); };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeOnReady, { once: true });
      else initializeOnReady();
    })();
