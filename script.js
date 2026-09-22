(function () {
  "use strict";

  const BASE_STORAGE_KEY = "my-expenses-data-v1";

  const CATEGORIES = [
    "Food & Dining",
    "Groceries",
    "Shopping",
    "Transport & Fuel",
    "Bills & Utilities",
    "Rent & Housing",
    "Entertainment",
    "Health & Medical",
    "Personal Care",
    "Education",
    "Investments & Savings",
    "Gifts & Donations",
    "Travel",
    "Other"
  ];

  let supabaseClient = null;
  let currentUser = null;
  let activeSyncController = null;
  let syncSessionId = 0;

  let state = {
    expenses: [],
    categories: [...CATEGORIES],
    currentMonth: getYearMonthString(new Date()),
    editingId: null,
    reportType: "date",
    reportParams: {
      date: getTodayString(),
      month: getYearMonthString(new Date()),
      year: String(new Date().getFullYear()),
      startDate: getTodayString(),
      endDate: getTodayString()
    }
  };

  // --------------------------------------------------
  // STORAGE
  // --------------------------------------------------

  function getStorageKey() {
    return currentUser
      ? `${BASE_STORAGE_KEY}_${currentUser.id}`
      : BASE_STORAGE_KEY;
  }

  // --------------------------------------------------
  // DATE / NUMBER / FORMAT UTILITIES
  // --------------------------------------------------

  function getTodayString() {
    const d = new Date();

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function getYearMonthString(dateObj) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");

    return `${year}-${month}`;
  }

  /*
   * Strict YYYY-MM-DD validation.
   *
   * This rejects invalid dates such as:
   * 2026-02-31
   * 2026-04-31
   * 2026-13-10
   */
  function isValidISO8601Date(dateStr) {
    if (
      typeof dateStr !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ) {
      return false;
    }

    const [year, month, day] = dateStr.split("-").map(Number);

    const date = new Date(year, month - 1, day);

    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    );
  }

  function isValidYearMonth(monthStr) {
    if (
      typeof monthStr !== "string" ||
      !/^\d{4}-\d{2}$/.test(monthStr)
    ) {
      return false;
    }

    const [year, month] = monthStr.split("-").map(Number);

    return (
      year >= 1900 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12
    );
  }

  function isValidYear(yearStr) {
    if (!/^\d{4}$/.test(String(yearStr))) {
      return false;
    }

    const year = Number(yearStr);

    return year >= 1900 && year <= 9999;
  }

  function generateId() {
    return (
      "e-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).substring(2, 9)
    );
  }

  function formatCurrency(amount) {
    const num = Number(amount);

    if (!Number.isFinite(num)) {
      return "₹0";
    }

    return (
      "₹" +
      num.toLocaleString("en-IN", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 0
      })
    );
  }

  function formatMonthLabel(ym) {
    if (!isValidYearMonth(ym)) {
      return ym || "";
    }

    const [year, month] = ym.split("-").map(Number);

    const date = new Date(year, month - 1, 1);

    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric"
    });
  }

  function formatDateLabel(dateStr) {
    if (!isValidISO8601Date(dateStr)) {
      return dateStr || "";
    }

    const [year, month, day] = dateStr.split("-").map(Number);

    const date = new Date(year, month - 1, day);

    return date.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[m]);
  }

  function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function parseTimestamp(ts) {
    if (!ts) {
      return 0;
    }

    const time = new Date(ts).getTime();

    return Number.isNaN(time) ? 0 : time;
  }

  function getValidTimestamp(ts, fallback) {
    const parsed = parseTimestamp(ts);

    if (parsed > 0) {
      return ts;
    }

    return fallback;
  }

  // --------------------------------------------------
  // EXPENSE VALIDATION
  // --------------------------------------------------

  function validateExpenseObject(exp) {
    if (!exp || typeof exp !== "object") {
      return false;
    }

    if (
      typeof exp.id !== "string" ||
      exp.id.trim().length === 0
    ) {
      return false;
    }

    if (!isValidISO8601Date(exp.date)) {
      return false;
    }

    if (
      typeof exp.category !== "string" ||
      exp.category.trim().length === 0
    ) {
      return false;
    }

    if (
      typeof exp.description !== "string" ||
      exp.description.trim().length === 0
    ) {
      return false;
    }

    const amount = Number(exp.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return false;
    }

    if (
      exp.deleted !== undefined &&
      typeof exp.deleted !== "boolean"
    ) {
      return false;
    }

    if (
      exp.created_at !== undefined &&
      parseTimestamp(exp.created_at) === 0
    ) {
      return false;
    }

    if (
      exp.updated_at !== undefined &&
      parseTimestamp(exp.updated_at) === 0
    ) {
      return false;
    }

    return true;
  }

  // --------------------------------------------------
  // LOCAL DATA MANAGEMENT
  // --------------------------------------------------

  function loadLocalData() {
    try {
      const raw = localStorage.getItem(getStorageKey());

      if (!raw) {
        state.expenses = [];
        state.categories = [...CATEGORIES];
        return;
      }

      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== "object") {
        state.expenses = [];
        state.categories = [...CATEGORIES];
        return;
      }

      state.expenses = Array.isArray(parsed.expenses)
        ? parsed.expenses.filter(validateExpenseObject)
        : [];

      state.categories = Array.isArray(parsed.categories)
        ? parsed.categories.filter(
            category =>
              typeof category === "string" &&
              category.trim().length > 0
          )
        : [...CATEGORIES];

      if (state.categories.length === 0) {
        state.categories = [...CATEGORIES];
      }
    } catch (e) {
      console.error("Error reading localStorage:", e);

      state.expenses = [];
      state.categories = [...CATEGORIES];
    }
  }

  function saveLocalData() {
    try {
      localStorage.setItem(
        getStorageKey(),
        JSON.stringify({
          expenses: state.expenses,
          categories: state.categories
        })
      );
    } catch (e) {
      console.error("Error writing to localStorage:", e);

      showToast("Unable to save data locally.");
    }
  }

  function resetLocalUIState() {
    state.expenses = [];
    state.editingId = null;
    state.categories = [...CATEGORIES];
  }

  // --------------------------------------------------
  // SUPABASE INITIALIZATION
  // --------------------------------------------------

  function initSupabase() {
    if (
      !window.APP_CONFIG ||
      !window.APP_CONFIG.SUPABASE_URL ||
      !window.APP_CONFIG.SUPABASE_ANON_KEY ||
      !window.supabase
    ) {
      console.error("Supabase configuration is missing.");

      return;
    }

    try {
      supabaseClient = window.supabase.createClient(
        window.APP_CONFIG.SUPABASE_URL,
        window.APP_CONFIG.SUPABASE_ANON_KEY
      );

      supabaseClient.auth
        .getSession()
        .then(({ data: { session } }) => {
          if (session && session.user) {
            handleUserAuthenticated(session.user);
          } else {
            handleUserSignedOut();
          }
        })
        .catch(error => {
          console.error("Failed to get Supabase session:", error);
          handleUserSignedOut();
        });

      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session) {
          handleUserAuthenticated(session.user);
        } else if (event === "SIGNED_OUT") {
          handleUserSignedOut();
        }
      });
    } catch (e) {
      console.error("Failed to initialize Supabase:", e);
    }
  }

  function handleUserAuthenticated(user) {
    if (!user || !user.id) {
      return;
    }

    /*
     * Prevent duplicate initialization when Supabase fires
     * SIGNED_IN after getSession().
     */
    if (currentUser && currentUser.id === user.id) {
      return;
    }

    cancelPendingSyncs();

    currentUser = user;

    resetLocalUIState();
    loadLocalData();

    populateCategories();
    resetForm();

    showAppView();
    renderAll();

    syncWithCloud();
  }

  function handleUserSignedOut() {
    cancelPendingSyncs();

    currentUser = null;

    resetLocalUIState();

    showLoginView();
  }

  function cancelPendingSyncs() {
    syncSessionId++;

    if (activeSyncController) {
      activeSyncController.abort();
      activeSyncController = null;
    }
  }

  // --------------------------------------------------
  // CLOUD SYNC
  // --------------------------------------------------

  async function syncWithCloud() {
    if (!supabaseClient || !currentUser) {
      return;
    }

    if (!navigator.onLine) {
      updateSyncStatus("Offline (Changes saved locally)");
      return;
    }

    if (activeSyncController) {
      activeSyncController.abort();
    }

    activeSyncController = new AbortController();

    const currentSyncToken = ++syncSessionId;
    const targetUserId = currentUser.id;
    const signal = activeSyncController.signal;

    updateSyncStatus("Syncing...");

    try {
      /*
       * Fetch only this authenticated user's records.
       */
      const {
        data: remoteData,
        error: fetchErr
      } = await supabaseClient
        .from("expenses")
        .select("*")
        .eq("user_id", targetUserId)
        .abortSignal(signal);

      if (fetchErr) {
        throw fetchErr;
      }

      /*
       * Stop if another sync/user session has become active.
       */
      if (
        currentSyncToken !== syncSessionId ||
        !currentUser ||
        currentUser.id !== targetUserId
      ) {
        return;
      }

      const remoteMap = new Map();

      (remoteData || []).forEach(item => {
        if (item && item.id) {
          remoteMap.set(item.id, item);
        }
      });

      const localMap = new Map();

      state.expenses.forEach(item => {
        if (item && item.id) {
          localMap.set(item.id, item);
        }
      });

      const toUpsert = [];

      /*
       * Compare local and remote records using updated_at.
       *
       * Local wins only when:
       * - the record doesn't exist remotely, or
       * - local record is newer.
       */
      for (const [id, localItem] of localMap.entries()) {
        const remoteItem = remoteMap.get(id);

        const localUpdated = parseTimestamp(
          localItem.updated_at || localItem.created_at
        );

        const remoteUpdated = remoteItem
          ? parseTimestamp(
              remoteItem.updated_at || remoteItem.created_at
            )
          : 0;

        if (!remoteItem || localUpdated > remoteUpdated) {
          const now = new Date().toISOString();

          toUpsert.push({
            id: localItem.id,
            user_id: targetUserId,
            expense_date: localItem.date,
            category: localItem.category,
            description: localItem.description,
            amount: Number(localItem.amount),
            deleted: Boolean(localItem.deleted),
            created_at: getValidTimestamp(
              localItem.created_at,
              now
            ),
            updated_at: getValidTimestamp(
              localItem.updated_at,
              now
            )
          });
        }
      }

      /*
       * Push local changes to Supabase.
       */
      if (toUpsert.length > 0) {
        const {
          error: upsertErr
        } = await supabaseClient
          .from("expenses")
          .upsert(toUpsert)
          .abortSignal(signal);

        if (upsertErr) {
          throw upsertErr;
        }
      }

      /*
       * Make sure this sync is still valid before changing UI/local data.
       */
      if (
        currentSyncToken !== syncSessionId ||
        !currentUser ||
        currentUser.id !== targetUserId
      ) {
        return;
      }

      /*
       * Merge remote records that are newer than local.
       */
      for (const [id, remoteItem] of remoteMap.entries()) {
        if (!remoteItem || !remoteItem.id) {
          continue;
        }

        const localItem = localMap.get(id);

        const remoteUpdated = parseTimestamp(
          remoteItem.updated_at || remoteItem.created_at
        );

        const localUpdated = localItem
          ? parseTimestamp(
              localItem.updated_at || localItem.created_at
            )
          : 0;

        if (!localItem || remoteUpdated > localUpdated) {
          localMap.set(id, {
            id: remoteItem.id,
            date: remoteItem.expense_date,
            category: remoteItem.category,
            description: remoteItem.description,
            amount: Number(remoteItem.amount),
            deleted: Boolean(remoteItem.deleted),
            created_at: remoteItem.created_at,
            updated_at: remoteItem.updated_at
          });
        }
      }

      /*
       * Remove any malformed records that somehow came from the cloud.
       */
      state.expenses = Array.from(localMap.values()).filter(
        validateExpenseObject
      );

      saveLocalData();

      renderAll();

      const timeStr = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });

      updateSyncStatus(`Synced at ${timeStr}`);
    } catch (e) {
      /*
       * Abort is expected when:
       * - another sync starts
       * - user signs out
       * - another user logs in
       */
      if (
        e &&
        (
          e.name === "AbortError" ||
          String(e.message || "").includes("AbortError")
        )
      ) {
        return;
      }

      console.error("Cloud Sync failure details:", e);

      if (
        e &&
        (
          e.code === "42501" ||
          e.status === 403 ||
          String(e.message || "")
            .toLowerCase()
            .includes("row-level security")
        )
      ) {
        updateSyncStatus("Sync failed: RLS Policy Violation");
      } else if (e && e.message) {
        updateSyncStatus(`Sync error: ${e.message}`);
      } else {
        updateSyncStatus("Sync error (Check console)");
      }
    } finally {
      if (currentSyncToken === syncSessionId) {
        activeSyncController = null;
      }
    }
  }

  function updateSyncStatus(text) {
    const el = document.getElementById("sync-status");

    if (el) {
      el.textContent = text;
    }
  }

  // --------------------------------------------------
  // AUTH UI
  // --------------------------------------------------

  function showAppView() {
    const loginScreen = document.getElementById("login-screen");
    const app = document.getElementById("app");
    const authWho = document.getElementById("auth-who");

    if (loginScreen) {
      loginScreen.hidden = true;
    }

    if (app) {
      app.hidden = false;
    }

    if (authWho && currentUser) {
      authWho.textContent =
        `Logged in as: ${currentUser.email || "User"}`;

      authWho.hidden = false;
    }
  }

  function showLoginView() {
    const loginScreen = document.getElementById("login-screen");
    const app = document.getElementById("app");
    const authWho = document.getElementById("auth-who");

    if (loginScreen) {
      loginScreen.hidden = false;
    }

    if (app) {
      app.hidden = true;
    }

    if (authWho) {
      authWho.hidden = true;
    }
  }

  async function handleLogin(e) {
    e.preventDefault();

    const emailEl = document.getElementById("auth-email");
    const passwordEl = document.getElementById("auth-password");
    const errEl = document.getElementById("login-error");

    if (!emailEl || !passwordEl || !errEl) {
      return;
    }

    const email = emailEl.value.trim();
    const password = passwordEl.value;

    errEl.hidden = true;
    errEl.textContent = "";

    if (!supabaseClient) {
      errEl.textContent = "Supabase client not initialized.";
      errEl.hidden = false;
      return;
    }

    if (!email || !password) {
      errEl.textContent = "Please enter your email and password.";
      errEl.hidden = false;
      return;
    }

    try {
      const { error } =
        await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

      if (error) {
        errEl.textContent = error.message;
        errEl.hidden = false;
      }
    } catch (error) {
      console.error("Login error:", error);

      errEl.textContent =
        "Unable to sign in. Please try again.";

      errEl.hidden = false;
    }
  }

  async function handleLogout() {
    if (supabaseClient) {
      try {
        await supabaseClient.auth.signOut();
      } catch (error) {
        console.error("Logout error:", error);
      }
    } else {
      handleUserSignedOut();
    }
  }

  // --------------------------------------------------
  // RENDER CONTROLLERS
  // --------------------------------------------------

  function renderAll() {
    renderExpensesView();
    renderSummaryView();
    renderReportsView();
  }

  function getActiveExpenses() {
    return state.expenses.filter(
      e => e && !e.deleted && validateExpenseObject(e)
    );
  }

  // --------------------------------------------------
  // EXPENSE VIEW
  // --------------------------------------------------

  function renderExpensesView() {
    const monthLabel = document.getElementById("month-label");
    const monthTotal = document.getElementById("month-total");
    const monthCount = document.getElementById("month-count");
    const listEl = document.getElementById("expense-list");
    const emptyEl = document.getElementById("expenses-empty");

    if (!monthLabel || !monthTotal || !monthCount || !listEl) {
      return;
    }

    monthLabel.textContent =
      formatMonthLabel(state.currentMonth);

    const activeList = getActiveExpenses();

    const monthExpenses = activeList.filter(
      e =>
        e.date &&
        e.date.startsWith(state.currentMonth)
    );

    /*
     * YYYY-MM-DD strings can be compared directly.
     * This avoids unnecessary Date parsing.
     */
    monthExpenses.sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.id.localeCompare(a.id)
    );

    const total = monthExpenses.reduce(
      (sum, e) => sum + Number(e.amount),
      0
    );

    monthTotal.textContent = formatCurrency(total);

    monthCount.textContent =
      `${monthExpenses.length} expense` +
      `${monthExpenses.length === 1 ? "" : "s"}`;

    listEl.innerHTML = "";

    if (monthExpenses.length === 0) {
      if (emptyEl) {
        emptyEl.hidden = false;
      }

      return;
    }

    if (emptyEl) {
      emptyEl.hidden = true;
    }

    monthExpenses.forEach(exp => {
      const li = document.createElement("li");

      li.className = "expense-item";

      /*
       * Escape all user-controlled text before inserting HTML.
       */
      li.innerHTML = `
        <div class="exp-main">
          <strong>${escapeHTML(exp.description)}</strong>
          <div class="meta">
            ${formatDateLabel(exp.date)}
            •
            ${escapeHTML(exp.category)}
          </div>
        </div>

        <div class="amount">
          ${formatCurrency(exp.amount)}
        </div>

        <div class="row-actions">
          <button
            type="button"
            class="row-btn edit"
            data-id="${escapeHTML(exp.id)}"
          >
            Edit
          </button>

          <button
            type="button"
            class="row-btn delete"
            data-id="${escapeHTML(exp.id)}"
          >
            Delete
          </button>
        </div>
      `;

      listEl.appendChild(li);
    });
  }

  // --------------------------------------------------
  // SUMMARY VIEW
  // --------------------------------------------------

  function renderSummaryView() {
    const breakdownMonth =
      document.getElementById("breakdown-month");

    const breakdownEl =
      document.getElementById("category-breakdown");

    const monthSummaryEl =
      document.getElementById("monthly-summary");

    const summaryEmpty =
      document.getElementById("summary-empty");

    if (
      !breakdownMonth ||
      !breakdownEl ||
      !monthSummaryEl
    ) {
      return;
    }

    breakdownMonth.textContent =
      formatMonthLabel(state.currentMonth);

    const monthExpenses = getActiveExpenses().filter(
      e =>
        e.date &&
        e.date.startsWith(state.currentMonth)
    );

    const total = monthExpenses.reduce(
      (sum, e) => sum + Number(e.amount),
      0
    );

    const catTotals = {};

    monthExpenses.forEach(e => {
      catTotals[e.category] =
        (catTotals[e.category] || 0) +
        Number(e.amount);
    });

    breakdownEl.innerHTML = "";

    Object.keys(catTotals)
      .sort((a, b) => catTotals[b] - catTotals[a])
      .forEach(cat => {
        const amt = catTotals[cat];

        const pct =
          total > 0
            ? Math.round((amt / total) * 100)
            : 0;

        const li = document.createElement("li");

        li.className = "break-row";

        li.innerHTML = `
          <div>
            <strong>${escapeHTML(cat)}</strong>
            (${pct}%)

            <div class="bar-wrap">
              <div
                class="bar"
                style="width: ${pct}%"
              ></div>
            </div>
          </div>

          <div class="amount">
            ${formatCurrency(amt)}
          </div>
        `;

        breakdownEl.appendChild(li);
      });

    /*
     * Historical monthly totals.
     */
    const monthTotals = {};

    getActiveExpenses().forEach(e => {
      if (!e.date) {
        return;
      }

      const ym = e.date.substring(0, 7);

      monthTotals[ym] =
        (monthTotals[ym] || 0) +
        Number(e.amount);
    });

    monthSummaryEl.innerHTML = "";

    const sortedMonths =
      Object.keys(monthTotals).sort().reverse();

    if (sortedMonths.length === 0) {
      if (summaryEmpty) {
        summaryEmpty.hidden = false;
      }

      return;
    }

    if (summaryEmpty) {
      summaryEmpty.hidden = true;
    }

    sortedMonths.forEach(ym => {
      const li = document.createElement("li");

      li.innerHTML = `
        <button
          type="button"
          class="summary-row"
          data-ym="${escapeHTML(ym)}"
        >
          <strong>${escapeHTML(formatMonthLabel(ym))}</strong>
          <span>${formatCurrency(monthTotals[ym])}</span>
        </button>
      `;

      monthSummaryEl.appendChild(li);
    });
  }

  // --------------------------------------------------
  // REPORT VIEW
  // --------------------------------------------------

  function renderReportsView() {
    const fieldsEl =
      document.getElementById("report-fields");

    if (!fieldsEl) {
      return;
    }

    const type = state.reportType;
    const params = state.reportParams;

    if (type === "date") {
      fieldsEl.innerHTML = `
        <label for="rep-date">Select Date</label>

        <input
          type="date"
          id="rep-date"
          value="${escapeHTML(params.date)}"
        />
      `;
    } else if (type === "month") {
      fieldsEl.innerHTML = `
        <label for="rep-month">Select Month</label>

        <input
          type="month"
          id="rep-month"
          value="${escapeHTML(params.month)}"
        />
      `;
    } else if (type === "year") {
      const currentYear = new Date().getFullYear();

      let options = "";

      for (
        let y = currentYear;
        y >= currentYear - 5;
        y--
      ) {
        options += `
          <option
            value="${y}"
            ${String(y) === String(params.year) ? "selected" : ""}
          >
            ${y}
          </option>
        `;
      }

      fieldsEl.innerHTML = `
        <label for="rep-year">Select Year</label>

        <select id="rep-year">
          ${options}
        </select>
      `;
    } else if (type === "range") {
      fieldsEl.innerHTML = `
        <label for="rep-start">Start Date</label>

        <input
          type="date"
          id="rep-start"
          value="${escapeHTML(params.startDate)}"
        />

        <label for="rep-end">End Date</label>

        <input
          type="date"
          id="rep-end"
          value="${escapeHTML(params.endDate)}"
        />
      `;
    } else {
      fieldsEl.innerHTML = `
        <p class="muted">
          All historical expenses will be exported.
        </p>
      `;
    }

    renderReportPreview();
  }

  function getFilteredReportExpenses() {
    const active = getActiveExpenses();

    const type = state.reportType;
    const params = state.reportParams;

    if (type === "date") {
      if (!isValidISO8601Date(params.date)) {
        return [];
      }

      return active.filter(
        e => e.date === params.date
      );
    }

    if (type === "month") {
      if (!isValidYearMonth(params.month)) {
        return [];
      }

      return active.filter(
        e =>
          e.date &&
          e.date.startsWith(params.month)
      );
    }

    if (type === "year") {
      if (!isValidYear(params.year)) {
        return [];
      }

      return active.filter(
        e =>
          e.date &&
          e.date.startsWith(String(params.year))
      );
    }

    if (type === "range") {
      if (
        !isValidISO8601Date(params.startDate) ||
        !isValidISO8601Date(params.endDate)
      ) {
        return [];
      }

      /*
       * Prevent an invalid reversed date range.
       */
      if (params.startDate > params.endDate) {
        return [];
      }

      /*
       * YYYY-MM-DD strings are safe to compare
       * lexicographically.
       */
      return active.filter(
        e =>
          e.date >= params.startDate &&
          e.date <= params.endDate
      );
    }

    return active;
  }

  function isReportRangeInvalid() {
    if (state.reportType !== "range") {
      return false;
    }

    const { startDate, endDate } =
      state.reportParams;

    return (
      !isValidISO8601Date(startDate) ||
      !isValidISO8601Date(endDate) ||
      startDate > endDate
    );
  }

  function renderReportPreview() {
    const previewEl =
      document.getElementById("report-preview");

    if (!previewEl) {
      return;
    }

    if (isReportRangeInvalid()) {
      previewEl.innerHTML = `
        <p>
          <strong>Invalid date range.</strong>
          Please select a valid start and end date.
        </p>
      `;

      return;
    }

    const list = getFilteredReportExpenses();

    const total = list.reduce(
      (sum, e) => sum + Number(e.amount),
      0
    );

    previewEl.innerHTML = `
      <p>
        <strong>Matching Expenses:</strong>
        ${list.length}
      </p>

      <p>
        <strong>Total Amount:</strong>
        ${formatCurrency(total)}
      </p>
    `;
  }

  // --------------------------------------------------
  // CATEGORIES
  // --------------------------------------------------

  function populateCategories() {
    const sel =
      document.getElementById("exp-category");

    if (!sel) {
      return;
    }

    const categories =
      Array.isArray(state.categories) &&
      state.categories.length > 0
        ? state.categories
        : CATEGORIES;

    sel.innerHTML = categories
      .map(category => `
        <option value="${escapeHTML(category)}">
          ${escapeHTML(category)}
        </option>
      `)
      .join("");
  }

  // --------------------------------------------------
  // EVENT LISTENERS
  // --------------------------------------------------

  function setupEventListeners() {
    /*
     * Tabs
     */
    document
      .querySelectorAll(".tabs .tab")
      .forEach(tab => {
        tab.addEventListener("click", () => {
          document
            .querySelectorAll(".tabs .tab")
            .forEach(t =>
              t.classList.remove("is-active")
            );

          document
            .querySelectorAll(".view")
            .forEach(v =>
              v.classList.remove("is-visible")
            );

          tab.classList.add("is-active");

          const targetView =
            document.getElementById(
              "view-" + tab.dataset.view
            );

          if (targetView) {
            targetView.classList.add("is-visible");
          }
        });
      });

    /*
     * Settings
     */
    const openSettings =
      document.getElementById("open-settings");

    if (openSettings) {
      openSettings.addEventListener("click", () => {
        document
          .querySelectorAll(".view")
          .forEach(v =>
            v.classList.remove("is-visible")
          );

        const settingsView =
          document.getElementById("view-settings");

        if (settingsView) {
          settingsView.classList.add("is-visible");
        }
      });
    }

    const backFromSettings =
      document.getElementById("back-from-settings");

    if (backFromSettings) {
      backFromSettings.addEventListener("click", () => {
        document
          .querySelectorAll(".view")
          .forEach(v =>
            v.classList.remove("is-visible")
          );

        const expenseView =
          document.getElementById("view-expenses");

        if (expenseView) {
          expenseView.classList.add("is-visible");
        }
      });
    }

    /*
     * Previous month
     */
    const prevMonth =
      document.getElementById("prev-month");

    if (prevMonth) {
      prevMonth.addEventListener("click", () => {
        const [year, month] =
          state.currentMonth.split("-").map(Number);

        const prev =
          new Date(year, month - 2, 1);

        state.currentMonth =
          getYearMonthString(prev);

        renderAll();
      });
    }

    /*
     * Next month
     */
    const nextMonth =
      document.getElementById("next-month");

    if (nextMonth) {
      nextMonth.addEventListener("click", () => {
        const [year, month] =
          state.currentMonth.split("-").map(Number);

        const next =
          new Date(year, month, 1);

        state.currentMonth =
          getYearMonthString(next);

        renderAll();
      });
    }

    // --------------------------------------------------
    // ADD / EDIT EXPENSE
    // --------------------------------------------------

    const form =
      document.getElementById("expense-form");

    if (form) {
      form.addEventListener("submit", e => {
        e.preventDefault();

        const date =
          document.getElementById("exp-date").value;

        const amountInput =
          document.getElementById("exp-amount").value;

        const category =
          document.getElementById("exp-category").value;

        const description =
          document
            .getElementById("exp-desc")
            .value
            .trim();

        /*
         * Number() is used instead of parseFloat()
         * so values such as "100abc" aren't accepted.
         */
        const amount = Number(amountInput);

        if (
          !isValidISO8601Date(date) ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          !category ||
          !description
        ) {
          alert(
            "Please enter a valid date, a positive numeric amount, and a description."
          );

          return;
        }

        const now =
          new Date().toISOString();

        const wasEditing =
          Boolean(state.editingId);

        if (state.editingId) {
          const item =
            state.expenses.find(
              x => x.id === state.editingId
            );

          if (item) {
            item.date = date;
            item.amount = amount;
            item.category = category;
            item.description = description;
            item.deleted = false;
            item.updated_at = now;
          }
        } else {
          state.expenses.push({
            id: generateId(),
            date,
            amount,
            category,
            description,
            deleted: false,
            created_at: now,
            updated_at: now
          });
        }

        saveLocalData();

        resetForm();

        renderAll();

        syncWithCloud();

        showToast(
          wasEditing
            ? "Expense updated!"
            : "Expense added!"
        );
      });
    }

    /*
     * Cancel editing
     */
    const formCancel =
      document.getElementById("form-cancel");

    if (formCancel) {
      formCancel.addEventListener(
        "click",
        resetForm
      );
    }

    // --------------------------------------------------
    // EXPENSE LIST
    // --------------------------------------------------

    const expenseList =
      document.getElementById("expense-list");

    if (expenseList) {
      expenseList.addEventListener("click", e => {
        const btn =
          e.target.closest("button");

        if (!btn) {
          return;
        }

        const id = btn.dataset.id;

        if (!id) {
          return;
        }

        /*
         * EDIT
         */
        if (btn.classList.contains("edit")) {
          const exp =
            state.expenses.find(
              x => x.id === id
            );

          if (!exp) {
            return;
          }

          state.editingId = id;

          document.getElementById(
            "exp-date"
          ).value = exp.date;

          document.getElementById(
            "exp-amount"
          ).value = exp.amount;

          document.getElementById(
            "exp-category"
          ).value = exp.category;

          document.getElementById(
            "exp-desc"
          ).value = exp.description;

          document.getElementById(
            "form-title"
          ).textContent = "EDIT EXPENSE";

          document.getElementById(
            "form-submit"
          ).textContent = "Update Expense";

          document.getElementById(
            "form-cancel"
          ).classList.remove("hidden");

          window.scrollTo({
            top: 0,
            behavior: "smooth"
          });

          return;
        }

        /*
         * DELETE
         */
        if (btn.classList.contains("delete")) {
          confirmModal(
            "Are you sure you want to delete this expense?",
            () => {
              const exp =
                state.expenses.find(
                  x => x.id === id
                );

              if (!exp) {
                return;
              }

              exp.deleted = true;
              exp.updated_at =
                new Date().toISOString();

              saveLocalData();

              renderAll();

              syncWithCloud();
            }
          );
        }
      });
    }

    // --------------------------------------------------
    // CLEAR MONTH
    // --------------------------------------------------

    const clearMonth =
      document.getElementById("clear-month");

    if (clearMonth) {
      clearMonth.addEventListener("click", () => {
        confirmModal(
          `Delete all expenses for ${formatMonthLabel(
            state.currentMonth
          )}?`,
          () => {
            const now =
              new Date().toISOString();

            state.expenses.forEach(e => {
              if (
                e.date &&
                e.date.startsWith(
                  state.currentMonth
                )
              ) {
                e.deleted = true;
                e.updated_at = now;
              }
            });

            saveLocalData();

            renderAll();

            syncWithCloud();
          }
        );
      });
    }

    // --------------------------------------------------
    // MONTHLY SUMMARY
    // --------------------------------------------------

    const monthlySummary =
      document.getElementById(
        "monthly-summary"
      );

    if (monthlySummary) {
      monthlySummary.addEventListener(
        "click",
        e => {
          const row =
            e.target.closest(
              ".summary-row"
            );

          if (
            row &&
            row.dataset.ym &&
            isValidYearMonth(
              row.dataset.ym
            )
          ) {
            state.currentMonth =
              row.dataset.ym;

            const expenseTab =
              document.querySelector(
                '.tab[data-view="expenses"]'
              );

            if (expenseTab) {
              expenseTab.click();
            }

            renderAll();
          }
        }
      );
    }

    // --------------------------------------------------
    // REPORT CHOICES
    // --------------------------------------------------

    document
      .querySelectorAll(
        ".choice-grid .choice"
      )
      .forEach(btn => {
        btn.addEventListener("click", () => {
          document
            .querySelectorAll(
              ".choice-grid .choice"
            )
            .forEach(c =>
              c.classList.remove("is-active")
            );

          btn.classList.add("is-active");

          state.reportType =
            btn.dataset.report;

          renderReportsView();
        });
      });

    // --------------------------------------------------
    // REPORT INPUTS
    // --------------------------------------------------

    const reportFields =
      document.getElementById(
        "report-fields"
      );

    if (reportFields) {
      reportFields.addEventListener(
        "input",
        e => {
          if (e.target.id === "rep-date") {
            state.reportParams.date =
              e.target.value;
          }

          if (e.target.id === "rep-month") {
            state.reportParams.month =
              e.target.value;
          }

          if (e.target.id === "rep-year") {
            state.reportParams.year =
              e.target.value;
          }

          if (e.target.id === "rep-start") {
            state.reportParams.startDate =
              e.target.value;
          }

          if (e.target.id === "rep-end") {
            state.reportParams.endDate =
              e.target.value;
          }

          renderReportPreview();
        }
      );
    }

    // --------------------------------------------------
    // EXPORTS
    // --------------------------------------------------

    const downloadCSV =
      document.getElementById(
        "download-csv"
      );

    if (downloadCSV) {
      downloadCSV.addEventListener(
        "click",
        exportCSV
      );
    }

    const downloadPDF =
      document.getElementById(
        "download-pdf"
      );

    if (downloadPDF) {
      downloadPDF.addEventListener(
        "click",
        exportPDF
      );
    }

    // --------------------------------------------------
    // BACKUP
    // --------------------------------------------------

    const exportBackupButton =
      document.getElementById(
        "export-backup"
      );

    if (exportBackupButton) {
      exportBackupButton.addEventListener(
        "click",
        exportBackup
      );
    }

    const importBackupButton =
      document.getElementById(
        "import-backup"
      );

    const importFile =
      document.getElementById(
        "import-file"
      );

    if (
      importBackupButton &&
      importFile
    ) {
      importBackupButton.addEventListener(
        "click",
        () => importFile.click()
      );

      importFile.addEventListener(
        "change",
        importBackup
      );
    }

    // --------------------------------------------------
    // DELETE ALL
    // --------------------------------------------------

    const deleteAll =
      document.getElementById(
        "delete-all"
      );

    if (deleteAll) {
      deleteAll.addEventListener(
        "click",
        () => {
          confirmModal(
            "Delete all data completely? This cannot be undone.",
            () => {
              const now =
                new Date().toISOString();

              state.expenses.forEach(e => {
                e.deleted = true;
                e.updated_at = now;
              });

              saveLocalData();

              renderAll();

              syncWithCloud();
            }
          );
        }
      );
    }

    // --------------------------------------------------
    // AUTH
    // --------------------------------------------------

    const loginForm =
      document.getElementById(
        "login-form"
      );

    if (loginForm) {
      loginForm.addEventListener(
        "submit",
        handleLogin
      );
    }

    const logoutButton =
      document.getElementById(
        "auth-logout"
      );

    if (logoutButton) {
      logoutButton.addEventListener(
        "click",
        handleLogout
      );
    }

    const syncButton =
      document.getElementById(
        "auth-sync"
      );

    if (syncButton) {
      syncButton.addEventListener(
        "click",
        syncWithCloud
      );
    }

    // --------------------------------------------------
    // NETWORK STATUS
    // --------------------------------------------------

    window.addEventListener(
      "online",
      () => {
        updateSyncStatus(
          "Back online. Syncing..."
        );

        syncWithCloud();
      }
    );

    window.addEventListener(
      "offline",
      () => {
        updateSyncStatus(
          "Offline (Changes saved locally)"
        );
      }
    );
  }

  // --------------------------------------------------
  // FORM RESET
  // --------------------------------------------------

  function resetForm() {
    state.editingId = null;

    const form =
      document.getElementById(
        "expense-form"
      );

    if (form) {
      form.reset();
    }

    const date =
      document.getElementById(
        "exp-date"
      );

    if (date) {
      date.value = getTodayString();
    }

    const title =
      document.getElementById(
        "form-title"
      );

    if (title) {
      title.textContent =
        "ADD EXPENSE";
    }

    const submit =
      document.getElementById(
        "form-submit"
      );

    if (submit) {
      submit.textContent =
        "+ Add Expense";
    }

    const cancel =
      document.getElementById(
        "form-cancel"
      );

    if (cancel) {
      cancel.classList.add("hidden");
    }
  }

  // --------------------------------------------------
  // TOAST
  // --------------------------------------------------

  let toastTimer = null;

  function showToast(msg) {
    const toast =
      document.getElementById(
        "form-toast"
      );

    if (!toast) {
      return;
    }

    toast.textContent = msg;
    toast.hidden = false;

    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
      toast.hidden = true;
      toastTimer = null;
    }, 3000);
  }

  // --------------------------------------------------
  // CONFIRM MODAL
  // --------------------------------------------------

  function confirmModal(text, onConfirm) {
    const modal =
      document.getElementById(
        "modal"
      );

    const modalText =
      document.getElementById(
        "modal-text"
      );

    const okBtn =
      document.getElementById(
        "modal-ok"
      );

    const cancelBtn =
      document.getElementById(
        "modal-cancel"
      );

    if (
      !modal ||
      !modalText ||
      !okBtn ||
      !cancelBtn
    ) {
      /*
       * Fallback if modal elements are missing.
       */
      if (window.confirm(text)) {
        onConfirm();
      }

      return;
    }

    modalText.textContent = text;
    modal.hidden = false;

    const cleanup = () => {
      modal.hidden = true;

      okBtn.removeEventListener(
        "click",
        onOk
      );

      cancelBtn.removeEventListener(
        "click",
        onCancel
      );
    };

    const onOk = () => {
      cleanup();
      onConfirm();
    };

    const onCancel = () => {
      cleanup();
    };

    okBtn.addEventListener(
      "click",
      onOk
    );

    cancelBtn.addEventListener(
      "click",
      onCancel
    );
  }

  // --------------------------------------------------
  // CSV EXPORT
  // --------------------------------------------------

  function exportCSV() {
    const list =
      getFilteredReportExpenses();

    if (list.length === 0) {
      if (isReportRangeInvalid()) {
        alert(
          "Please select a valid date range."
        );
      } else {
        alert(
          "No expenses found for this selection."
        );
      }

      return;
    }

    let csv =
      "Date,Category,Description,Amount\n";

    list.forEach(e => {
      csv += [
        csvEscape(e.date),
        csvEscape(e.category),
        csvEscape(e.description),
        Number(e.amount).toFixed(2)
      ].join(",") + "\n";
    });

    /*
     * UTF-8 BOM improves Excel compatibility.
     */
    const blob = new Blob(
      ["\uFEFF" + csv],
      {
        type: "text/csv;charset=utf-8;"
      }
    );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement("a");

    a.href = url;

    a.download =
      `expenses-${state.reportType}-${getTodayString()}.csv`;

    document.body.appendChild(a);

    a.click();

    a.remove();

    /*
     * Give the browser time to start the download
     * before releasing the object URL.
     */
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // --------------------------------------------------
  // PDF EXPORT
  // --------------------------------------------------

  function exportPDF() {
    const list =
      getFilteredReportExpenses();

    if (list.length === 0) {
      if (isReportRangeInvalid()) {
        alert(
          "Please select a valid date range."
        );
      } else {
        alert(
          "No expenses found for this selection."
        );
      }

      return;
    }

    const win =
      window.open("", "_blank");

    if (!win) {
      alert(
        "Pop-up blocked. Please allow pop-ups to download PDF."
      );

      return;
    }

    const rows = list
      .map(
        e => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #ddd;">
              ${escapeHTML(formatDateLabel(e.date))}
            </td>

            <td style="padding:8px;border-bottom:1px solid #ddd;">
              ${escapeHTML(e.category)}
            </td>

            <td style="padding:8px;border-bottom:1px solid #ddd;">
              ${escapeHTML(e.description)}
            </td>

            <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right;">
              Rs. ${Number(e.amount).toFixed(2)}
            </td>
          </tr>
        `
      )
      .join("");

    win.document.write(`
      <!DOCTYPE html>

      <html>
      <head>
        <meta charset="UTF-8">

        <title>Expense Report</title>

        <style>
          body {
            font-family: system-ui, sans-serif;
            padding: 20px;
            color: #111;
          }

          h1 {
            margin-bottom: 20px;
          }

          table {
            width: 100%;
            border-collapse: collapse;
          }

          th {
            text-align: left;
            padding: 8px;
            border-bottom: 2px solid #333;
          }

          td {
            vertical-align: top;
          }

          @media print {
            body {
              padding: 0;
            }
          }
        </style>
      </head>

      <body>
        <h1>Expense Report</h1>

        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Description</th>
              <th style="text-align:right;">
                Amount
              </th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
      </html>
    `);

    win.document.close();

    /*
     * Wait for the document to render before printing.
     */
    setTimeout(() => {
      win.focus();
      win.print();
    }, 250);
  }

  // --------------------------------------------------
  // BACKUP EXPORT
  // --------------------------------------------------

  function exportBackup() {
    const payload = {
      user_id:
        currentUser
          ? currentUser.id
          : null,

      user_email:
        currentUser
          ? currentUser.email || null
          : null,

      exported_at:
        new Date().toISOString(),

      expenses:
        state.expenses,

      categories:
        state.categories
    };

    const json =
      JSON.stringify(
        payload,
        null,
        2
      );

    const blob = new Blob(
      [json],
      {
        type: "application/json;charset=utf-8;"
      }
    );

    const url =
      URL.createObjectURL(blob);

    const downloadAnchor =
      document.createElement("a");

    downloadAnchor.href = url;

    downloadAnchor.download =
      `expenses-backup-${getTodayString()}.json`;

    document.body.appendChild(
      downloadAnchor
    );

    downloadAnchor.click();

    downloadAnchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // --------------------------------------------------
  // BACKUP IMPORT
  // --------------------------------------------------

  function importBackup(e) {
    const file =
      e.target.files &&
      e.target.files[0];

    if (!file) {
      return;
    }

    const reader =
      new FileReader();

    reader.onload = event => {
      try {
        const imported =
          JSON.parse(
            event.target.result
          );

        if (
          !imported ||
          typeof imported !== "object"
        ) {
          alert(
            "Invalid backup file."
          );

          return;
        }

        if (
          !Array.isArray(
            imported.expenses
          )
        ) {
          alert(
            "Invalid backup file structure."
          );

          return;
        }

        /*
         * Validate every imported expense.
         */
        const validImportedExpenses =
          imported.expenses.filter(
            validateExpenseObject
          );

        /*
         * If the backup contains records but
         * none are valid, reject the backup.
         */
        if (
          validImportedExpenses.length === 0 &&
          imported.expenses.length > 0
        ) {
          alert(
            "Backup contains no valid expense records."
          );

          return;
        }

        /*
         * Warn when importing another user's backup.
         */
        if (
          currentUser &&
          imported.user_id &&
          imported.user_id !== currentUser.id
        ) {
          const proceed = window.confirm(
            `Warning: This backup was exported from a different account (${imported.user_email || "another user"}).\n\n` +
            `Importing it will merge these expenses into ${currentUser.email || "your"} account.\n\n` +
            `Do you want to proceed?`
          );

          if (!proceed) {
            return;
          }
        }

        /*
         * Merge by unique expense ID.
         */
        const existingMap =
          new Map();

        state.expenses.forEach(exp => {
          if (
            exp &&
            typeof exp.id === "string" &&
            exp.id.trim()
          ) {
            existingMap.set(
              exp.id,
              exp
            );
          }
        });

        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;

        validImportedExpenses.forEach(
          impExp => {
            const existing =
              existingMap.get(
                impExp.id
              );

            if (!existing) {
              existingMap.set(
                impExp.id,
                impExp
              );

              addedCount++;

              return;
            }

            const existingTime =
              parseTimestamp(
                existing.updated_at ||
                existing.created_at
              );

            const importedTime =
              parseTimestamp(
                impExp.updated_at ||
                impExp.created_at
              );

            /*
             * Imported record replaces local only
             * when it is newer or equal.
             */
            if (
              importedTime >=
              existingTime
            ) {
              existingMap.set(
                impExp.id,
                impExp
              );

              updatedCount++;
            } else {
              skippedCount++;
            }
          }
        );

        state.expenses =
          Array.from(
            existingMap.values()
          ).filter(
            validateExpenseObject
          );

        /*
         * Import categories only when they are
         * valid strings.
         */
        if (
          Array.isArray(
            imported.categories
          )
        ) {
          const importedCategories =
            imported.categories.filter(
              category =>
                typeof category === "string" &&
                category.trim().length > 0
            );

          if (
            importedCategories.length > 0
          ) {
            /*
             * Keep existing categories and add
             * any missing imported categories.
             */
            const categorySet =
              new Set(
                state.categories
              );

            importedCategories.forEach(
              category => {
                if (
                  !categorySet.has(
                    category
                  )
                ) {
                  state.categories.push(
                    category
                  );

                  categorySet.add(
                    category
                  );
                }
              }
            );
          }
        }

        saveLocalData();

        populateCategories();

        renderAll();

        /*
         * Sync imported records with cloud.
         */
        syncWithCloud();

        alert(
          `Backup imported successfully!\n\n` +
          `Added: ${addedCount}\n` +
          `Updated: ${updatedCount}\n` +
          `Skipped older records: ${skippedCount}`
        );
      } catch (err) {
        console.error(
          "Backup import error:",
          err
        );

        alert(
          "Failed to parse backup JSON file."
        );
      } finally {
        /*
         * Allows the same file to be selected again.
         */
        e.target.value = "";
      }
    };

    reader.onerror = () => {
      alert(
        "Unable to read the backup file."
      );

      e.target.value = "";
    };

    reader.readAsText(file);
  }

  // --------------------------------------------------
  // APPLICATION START
  // --------------------------------------------------

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      populateCategories();

      setupEventListeners();

      resetForm();

      initSupabase();
    }
  );
})();
