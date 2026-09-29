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
      const emptyData = () => ({ version: 1, tasks: [], sessions: [], questions: [], modules: [], logs: [], flashcards: [], timer: null });
      let toastTimeout;
      let currentFilter = "active";

      function loadData() {
        try {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (!stored) return emptyData();
          const parsed = JSON.parse(stored);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Saved study data must be a JSON object.");
          return {
            ...emptyData(), ...parsed,
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions : (Array.isArray(parsed.logs) ? parsed.logs : []),
            logs: Array.isArray(parsed.logs) ? parsed.logs : (Array.isArray(parsed.sessions) ? parsed.sessions : []),
            questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            modules: Array.isArray(parsed.modules) ? parsed.modules : [],
            flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards : [],
            timer: parsed.timer && typeof parsed.timer === "object" ? parsed.timer : null
          };
        } catch (error) {
          console.error("Unable to load local study data:", error);
          showToast("Saved data could not be read. Check this browser's storage.");
          return emptyData();
        }
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

      function hasStudyData(value) {
        return ["tasks", "sessions", "questions", "modules", "logs", "flashcards"].some((key) => Array.isArray(value[key]) && value[key].length > 0);
      }

      function normalizeCloudData(value) {
        if (!validImport(value)) throw new Error("The saved cloud record has an unsupported data format.");
        return {
          ...emptyData(), ...value,
          tasks: value.tasks,
          sessions: Array.isArray(value.sessions) ? value.sessions : (Array.isArray(value.logs) ? value.logs : []),
          logs: Array.isArray(value.logs) ? value.logs : (Array.isArray(value.sessions) ? value.sessions : []),
          questions: Array.isArray(value.questions) ? value.questions : [],
          modules: Array.isArray(value.modules) ? value.modules : [],
          flashcards: Array.isArray(value.flashcards) ? value.flashcards : [],
          timer: value.timer && typeof value.timer === "object" ? { ...value.timer, running: false, paused: Boolean(value.timer.running || value.timer.paused), startedAt: undefined } : null
        };
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
            const localHasData = hasStudyData(data);
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
          supabaseClient.auth.onAuthStateChange((_event, session) => {
            queueMicrotask(() => { void applyAuthSession(session); });
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
        return task.priority === "high" || (task.moduleId && moduleLevel(data.modules.find((module) => module.id === task.moduleId)) === "high");
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
        const tasks = data.tasks.filter((task) => !task.done);
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
      }

      function renderSummary() {
        const todayTasks = data.tasks.filter((task) => task.due === todayISO());
        const completed = todayTasks.filter((task) => task.done).length;
        const percent = todayTasks.length ? Math.round(completed / todayTasks.length * 100) : 0;
        $("#today-percent").textContent = String(percent);
        $("#today-progress-bar").style.width = `${percent}%`;
        $("#today-progress-track").setAttribute("aria-valuenow", String(percent));
        $("#today-progress-caption").textContent = `${completed} of ${todayTasks.length} ${todayTasks.length === 1 ? "goal" : "goals"} complete`;
        $("#high-yield-remaining").textContent = String(data.tasks.filter((task) => !task.done && taskIsHighYield(task)).length);
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
          if (currentFilter === "active" && task.done) return false;
          if (currentFilter === "done" && !task.done) return false;
          const text = `${task.title || ""} ${task.description || ""} ${task.subject || ""}`.toLocaleLowerCase();
          return !query || text.includes(query);
        }).sort((a, b) => Number(a.done) - Number(b.done) || (a.due || "9999").localeCompare(b.due || "9999") || priorityRank(a.priority) - priorityRank(b.priority));
        $("#task-count").textContent = `${data.tasks.length} ${data.tasks.length === 1 ? "goal" : "goals"}`;
        const list = $("#task-list");
        list.innerHTML = filtered.map((task) => {
          const priority = ["high", "medium", "low"].includes(task.priority) ? task.priority : "medium";
          return `<article class="task-row ${task.done ? "task-done" : ""}">
            <input class="task-checkbox" type="checkbox" data-task-toggle="${escapeHTML(task.id)}" aria-label="Mark ${escapeHTML(task.title)} complete" ${task.done ? "checked" : ""}>
            <div class="task-copy"><p class="task-title">${escapeHTML(task.title || "Untitled goal")}</p>${task.description ? `<p class="task-description">${escapeHTML(task.description)}</p>` : ""}<div class="task-meta"><span>${escapeHTML(friendlyDue(task.due))}</span><span>·</span><span class="priority-badge priority-${priority}">${priority}</span>${task.moduleId ? `<span>·</span><span>${escapeHTML(data.modules.find((module) => module.id === task.moduleId)?.name || "Linked module")}</span>` : ""}</div></div>
            <div class="task-actions"><button class="task-action" type="button" data-edit-task="${escapeHTML(task.id)}" aria-label="Edit ${escapeHTML(task.title)}" title="Edit goal">✎</button><button class="task-action" type="button" data-delete-task="${escapeHTML(task.id)}" aria-label="Delete ${escapeHTML(task.title)}" title="Delete goal">×</button></div>
          </article>`;
        }).join("");
        const empty = filtered.length === 0;
        $("#task-empty").hidden = !empty;
        $("#task-empty-title").textContent = query ? "No matching goals." : currentFilter === "done" ? "Nothing completed yet." : currentFilter === "active" && data.tasks.length ? "You're all caught up." : "A fresh page.";
        $("#task-empty-copy").textContent = query ? "Try another search, or clear your search to see all goals." : currentFilter === "active" && data.tasks.length ? "Add another goal whenever you're ready." : "Add a goal to begin shaping your study day.";
        $("#clear-completed").hidden = !data.tasks.some((task) => task.done);
        $("#task-footer-copy").textContent = `${data.tasks.filter((task) => task.done).length} complete · ${data.tasks.filter((task) => !task.done).length} remaining`;
      }

      function renderModules() {
        const yieldRank = { high: 0, medium: 1, low: 2 };
        const sorted = [...data.modules].sort((a, b) => yieldRank[moduleLevel(a)] - yieldRank[moduleLevel(b)] || String(a.subject).localeCompare(String(b.subject)) || String(a.name).localeCompare(String(b.name)));
        const cardHTML = (module) => {
          const level = moduleLevel(module);
          const weight = module.weight !== "" && module.weight != null && Number.isFinite(Number(module.weight)) ? `${Number(module.weight)}% exam weight` : "Scored from past-paper patterns";
          const linkedTasks = data.tasks.filter((task) => task.moduleId === module.id && !task.done).length;
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
          ...data.tasks.filter((task) => !task.done && dateFromISO(task.due)).map((task) => ({
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

      function render() {
        renderHeader();
        renderSummary();
        renderStudyAnalytics();
        renderTasks();
        renderPredictor();
        renderModules();
        renderSchedule();
        renderFlashcards();
        renderTimer();
        renderSettings();
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
          try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); }
          catch (error) { console.error("Could not save appearance preference:", error); showToast("Couldn't save the theme preference."); }
        }
      }

      function navigate(view) {
        const validViews = ["dashboard", "predictor", "schedule", "modules", "flashcards", "settings"];
        const valid = validViews.includes(view) ? view : "dashboard";
        $$(".page-view").forEach((section) => { section.hidden = section.id !== `${valid}-view`; });
        $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === valid));
        $("#crumb-section").textContent = ({ dashboard: "Workspace", predictor: "Exam insights", schedule: "Study schedule", modules: "Module tracker", flashcards: "Quick revise", settings: "Settings" })[valid];
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
        if (typeof $("#task-dialog").showModal === "function") $("#task-dialog").showModal();
        else $("#task-dialog").setAttribute("open", "");
        $("#task-title-input").focus();
      }

      function closeDialog(dialog) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }

      function exportBackup() {
        const contents = { ...data, timer: data.timer ? { ...data.timer } : null, exportedAt: new Date().toISOString() };
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
        return value.tasks.every((task) => record(task) && typeof task.title === "string" && typeof task.id === "string")
          && (value.questions == null || (Array.isArray(value.questions) && value.questions.every((question) =>
            record(question) && typeof question.topic === "string" && Number.isInteger(Number(question.year)))))
          && (value.modules == null || (Array.isArray(value.modules) && value.modules.every((module) => record(module) && typeof module.id === "string" && typeof module.name === "string")))
          && (value.logs == null || (Array.isArray(value.logs) && value.logs.every((session) => record(session) && typeof session.date === "string")))
          && (value.sessions == null || (Array.isArray(value.sessions) && value.sessions.every((session) => record(session) && typeof session.date === "string")))
          && (value.flashcards == null || (Array.isArray(value.flashcards) && value.flashcards.every((card) => record(card) && typeof card.id === "string" && typeof card.front === "string" && typeof card.back === "string")))
          && (value.timer == null || (record(value.timer) && ["focus", "break"].includes(value.timer.mode) && Number.isFinite(Number(value.timer.remaining)) && Number(value.timer.remaining) >= 0 && Number(value.timer.remaining) <= TIMER_LENGTHS[value.timer.mode]));
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

      function openAuthDialog(mode) {
        authMode = mode;
        $("#auth-form").reset();
        $("#auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
        $("#auth-dialog-title").textContent = mode === "signup" ? "Create your account" : "Sign in to sync";
        $("#auth-submit-button").textContent = mode === "signup" ? "Sign up" : "Login";
        $("#auth-mode-toggle").textContent = "Need an account? Sign up";
        $("#auth-mode-toggle").hidden = mode === "signup";
        $("#auth-config-note").hidden = false;
        setAuthMessage("");
        $("#auth-dialog").showModal();
      }

      $("#auth-open-button").addEventListener("click", () => openAuthDialog("signin"));
      $("#auth-signup-open-button").addEventListener("click", () => openAuthDialog("signup"));
      $("#auth-mode-toggle").addEventListener("click", () => {
        authMode = authMode === "signin" ? "signup" : "signin";
        $("#auth-dialog-title").textContent = authMode === "signup" ? "Create your account" : "Sign in to sync";
        $("#auth-submit-button").textContent = authMode === "signup" ? "Sign up" : "Login";
        $("#auth-mode-toggle").textContent = authMode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up";
        $("#auth-password").autocomplete = authMode === "signup" ? "new-password" : "current-password";
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
        const task = {
          id: id || makeId(), title, description: $("#task-description").value.trim(),
          priority: $("#task-priority").value, due, done: existing?.done || false,
          moduleId: $("#task-module").value, subject: existing?.subject || "",
          createdAt: existing?.createdAt || Date.now()
        };
        const next = existing ? data.tasks.map((item) => item.id === id ? task : item) : [...data.tasks, task];
        const prior = data.tasks;
        data.tasks = next;
        if (!saveData()) { data.tasks = prior; return; }
        closeDialog($("#task-dialog"));
        render();
        showToast(existing ? "Study goal updated." : "Study goal added.");
      });

      $("#task-list").addEventListener("change", (event) => {
        const checkbox = event.target.closest("[data-task-toggle]");
        if (!checkbox) return;
        const prior = data.tasks;
        data.tasks = data.tasks.map((task) => task.id === checkbox.dataset.taskToggle ? { ...task, done: checkbox.checked } : task);
        if (!saveData()) { data.tasks = prior; return renderTasks(); }
        render();
      });
      $("#task-list").addEventListener("click", (event) => {
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
        data.tasks = data.tasks.filter((task) => !task.done);
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
          data = {
            ...emptyData(), ...imported,
            tasks: imported.tasks,
            sessions: Array.isArray(imported.sessions) ? imported.sessions : (Array.isArray(imported.logs) ? imported.logs : []),
            logs: Array.isArray(imported.logs) ? imported.logs : (Array.isArray(imported.sessions) ? imported.sessions : []),
            questions: Array.isArray(imported.questions) ? imported.questions : [],
            modules: Array.isArray(imported.modules) ? imported.modules : [],
            flashcards: Array.isArray(imported.flashcards) ? imported.flashcards : [],
            timer: imported.timer && typeof imported.timer === "object" ? { ...imported.timer, running: false, paused: Boolean(imported.timer.running || imported.timer.paused), startedAt: undefined } : null
          };
          if (!saveData()) { data = previous; return; }
          clearInterval(timerInterval);
          timerInterval = null;
          render();
          showToast("Backup restored successfully.");
        } catch (error) {
          console.error("Unable to restore backup:", error);
          showToast(error instanceof SyntaxError ? "That file isn't valid JSON." : error.message || "Couldn't restore this backup.");
        } finally {
          event.target.value = "";
        }
      });

      setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
      $("#question-year").value = String(new Date().getFullYear());
      const initialView = location.hash.slice(1);
      render();
      navigate(["dashboard", "predictor", "schedule", "modules", "flashcards", "settings"].includes(initialView) ? initialView : "dashboard");
      const initializeOnReady = () => { void initializeSupabase(); };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeOnReady, { once: true });
      else initializeOnReady();
    })();
