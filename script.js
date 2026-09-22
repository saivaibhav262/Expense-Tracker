(function () {
  "use strict";

  const STORAGE_KEY = "my-expenses-data-v1";

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
  let isSyncing = false;

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
  // Helper Utility Functions
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

  function generateId() {
    return "e-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 7);
  }

  function formatCurrency(amount) {
    const num = Number(amount) || 0;
    return "₹" + num.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  }

  function formatMonthLabel(ym) {
    const [y, m] = ym.split("-").map(Number);
    const date = new Date(y, m - 1, 1);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  function formatDateLabel(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
  }

  // --------------------------------------------------
  // Local Data Management
  // --------------------------------------------------

  function loadLocalData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.expenses)) state.expenses = parsed.expenses;
        if (Array.isArray(parsed.categories)) state.categories = parsed.categories;
      }
    } catch (e) {
      console.error("Error reading localStorage", e);
    }
  }

  function saveLocalData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        expenses: state.expenses,
        categories: state.categories
      }));
    } catch (e) {
      console.error("Error writing to localStorage", e);
    }
  }

  // --------------------------------------------------
  // Supabase Integration & Offline Sync
  // --------------------------------------------------

  function initSupabase() {
    if (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL && window.supabase) {
      try {
        supabaseClient = window.supabase.createClient(
          window.APP_CONFIG.SUPABASE_URL,
          window.APP_CONFIG.SUPABASE_ANON_KEY
        );
      } catch (e) {
        console.error("Failed to initialize Supabase:", e);
      }
    }
  }

  async function syncWithCloud() {
    if (!supabaseClient || !currentUser || isSyncing || !navigator.onLine) return;
    
    isSyncing = true;
    updateSyncStatus("Syncing...");

    try {
      // 1. Fetch remote expenses
      const { data: remoteData, error: fetchErr } = await supabaseClient
        .from("expenses")
        .select("*");

      if (fetchErr) throw fetchErr;

      const remoteMap = new Map();
      (remoteData || []).forEach(item => remoteMap.set(item.id, item));

      const localMap = new Map();
      state.expenses.forEach(item => localMap.set(item.id, item));

      const toUpsert = [];

      // 2. Identify local updates to send to Cloud
      for (const [id, localItem] of localMap.entries()) {
        const remoteItem = remoteMap.get(id);
        const localUpdated = new Date(localItem.updated_at || localItem.created_at || 0).getTime();
        const remoteUpdated = remoteItem ? new Date(remoteItem.updated_at || remoteItem.created_at || 0).getTime() : 0;

        if (!remoteItem || localUpdated > remoteUpdated) {
          toUpsert.push({
            id: localItem.id,
            user_id: currentUser.id,
            expense_date: localItem.date,
            category: localItem.category,
            description: localItem.description,
            amount: Number(localItem.amount),
            deleted: Boolean(localItem.deleted),
            created_at: localItem.created_at || new Date().toISOString(),
            updated_at: localItem.updated_at || new Date().toISOString()
          });
        }
      }

      // 3. Batch upsert changes
      if (toUpsert.length > 0) {
        const { error: upsertErr } = await supabaseClient
          .from("expenses")
          .upsert(toUpsert);

        if (upsertErr) throw upsertErr;
      }

      // 4. Merge remote expenses into local storage
      for (const [id, remoteItem] of remoteMap.entries()) {
        const localItem = localMap.get(id);
        const remoteUpdated = new Date(remoteItem.updated_at || remoteItem.created_at || 0).getTime();
        const localUpdated = localItem ? new Date(localItem.updated_at || localItem.created_at || 0).getTime() : 0;

        if (!localItem || remoteUpdated > localUpdated) {
          localMap.set(id, {
            id: remoteItem.id,
            date: remoteItem.expense_date,
            category: remoteItem.category,
            description: remoteItem.description,
            amount: Number(remoteItem.amount),
            deleted: remoteItem.deleted,
            created_at: remoteItem.created_at,
            updated_at: remoteItem.updated_at
          });
        }
      }

      state.expenses = Array.from(localMap.values());
      saveLocalData();
      renderAll();

      const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      updateSyncStatus(`Synced at ${timeStr}`);
    } catch (e) {
      console.error("Cloud sync error:", e);
      updateSyncStatus("Sync error (retrying when online)");
    } finally {
      isSyncing = false;
    }
  }

  function updateSyncStatus(text) {
    const el = document.getElementById("sync-status");
    if (el) el.textContent = text;
  }

  // --------------------------------------------------
  // UI Render Controllers
  // --------------------------------------------------

  function renderAll() {
    renderExpensesView();
    renderSummaryView();
    renderReportsView();
  }

  function getActiveExpenses() {
    return state.expenses.filter(e => !e.deleted);
  }

  function renderExpensesView() {
    document.getElementById("month-label").textContent = formatMonthLabel(state.currentMonth);

    const activeList = getActiveExpenses();
    const monthExpenses = activeList.filter(e => e.date.startsWith(state.currentMonth));

    // Sort newest date first
    monthExpenses.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id.localeCompare(a.id));

    const total = monthExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    document.getElementById("month-total").textContent = formatCurrency(total);
    document.getElementById("month-count").textContent = `${monthExpenses.length} expense${monthExpenses.length === 1 ? "" : "s"}`;

    const listEl = document.getElementById("expense-list");
    const emptyEl = document.getElementById("expenses-empty");
    listEl.innerHTML = "";

    if (monthExpenses.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    monthExpenses.forEach(exp => {
      const li = document.createElement("li");
      li.className = "expense-item";
      li.innerHTML = `
        <div class="exp-main">
          <strong>${escapeHTML(exp.description)}</strong>
          <div class="meta">${formatDateLabel(exp.date)} • ${escapeHTML(exp.category)}</div>
        </div>
        <div class="amount">${formatCurrency(exp.amount)}</div>
        <div class="row-actions">
          <button type="button" class="row-btn edit" data-id="${exp.id}">Edit</button>
          <button type="button" class="row-btn delete" data-id="${exp.id}">Delete</button>
        </div>
      `;
      listEl.appendChild(li);
    });
  }

  function renderSummaryView() {
    document.getElementById("breakdown-month").textContent = formatMonthLabel(state.currentMonth);
    const monthExpenses = getActiveExpenses().filter(e => e.date.startsWith(state.currentMonth));
    const total = monthExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

    const catTotals = {};
    monthExpenses.forEach(e => {
      catTotals[e.category] = (catTotals[e.category] || 0) + Number(e.amount);
    });

    const breakdownEl = document.getElementById("category-breakdown");
    breakdownEl.innerHTML = "";

    Object.keys(catTotals)
      .sort((a, b) => catTotals[b] - catTotals[a])
      .forEach(cat => {
        const amt = catTotals[cat];
        const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
        const li = document.createElement("li");
        li.className = "break-row";
        li.innerHTML = `
          <div>
            <strong>${escapeHTML(cat)}</strong> (${pct}%)
            <div class="bar-wrap"><div class="bar" style="width: ${pct}%"></div></div>
          </div>
          <div class="amount">${formatCurrency(amt)}</div>
        `;
        breakdownEl.appendChild(li);
      });

    // Monthly summary list
    const monthTotals = {};
    getActiveExpenses().forEach(e => {
      const ym = e.date.substring(0, 7);
      monthTotals[ym] = (monthTotals[ym] || 0) + Number(e.amount);
    });

    const monthSummaryEl = document.getElementById("monthly-summary");
    const summaryEmpty = document.getElementById("summary-empty");
    monthSummaryEl.innerHTML = "";

    const sortedMonths = Object.keys(monthTotals).sort().reverse();
    if (sortedMonths.length === 0) {
      summaryEmpty.hidden = false;
      return;
    }
    summaryEmpty.hidden = true;

    sortedMonths.forEach(ym => {
      const li = document.createElement("li");
      li.innerHTML = `
        <button type="button" class="summary-row" data-ym="${ym}">
          <strong>${formatMonthLabel(ym)}</strong>
          <span>${formatCurrency(monthTotals[ym])}</span>
        </button>
      `;
      monthSummaryEl.appendChild(li);
    });
  }

  function renderReportsView() {
    const fieldsEl = document.getElementById("report-fields");
    const type = state.reportType;
    const params = state.reportParams;

    if (type === "date") {
      fieldsEl.innerHTML = `
        <label for="rep-date">Select Date</label>
        <input type="date" id="rep-date" value="${params.date}" />
      `;
    } else if (type === "month") {
      fieldsEl.innerHTML = `
        <label for="rep-month">Select Month</label>
        <input type="month" id="rep-month" value="${params.month}" />
      `;
    } else if (type === "year") {
      const currentYear = new Date().getFullYear();
      let options = "";
      for (let y = currentYear; y >= currentYear - 5; y--) {
        options += `<option value="${y}" ${String(y) === params.year ? "selected" : ""}>${y}</option>`;
      }
      fieldsEl.innerHTML = `
        <label for="rep-year">Select Year</label>
        <select id="rep-year">${options}</select>
      `;
    } else if (type === "range") {
      fieldsEl.innerHTML = `
        <label for="rep-start">Start Date</label>
        <input type="date" id="rep-start" value="${params.startDate}" />
        <label for="rep-end">End Date</label>
        <input type="date" id="rep-end" value="${params.endDate}" />
      `;
    } else {
      fieldsEl.innerHTML = `<p class="muted">All historical expenses will be exported.</p>`;
    }

    renderReportPreview();
  }

  function getFilteredReportExpenses() {
    const active = getActiveExpenses();
    const type = state.reportType;
    const params = state.reportParams;

    if (type === "date") {
      return active.filter(e => e.date === params.date);
    } else if (type === "month") {
      return active.filter(e => e.date.startsWith(params.month));
    } else if (type === "year") {
      return active.filter(e => e.date.startsWith(params.year));
    } else if (type === "range") {
      return active.filter(e => e.date >= params.startDate && e.date <= params.endDate);
    }
    return active;
  }

  function renderReportPreview() {
    const list = getFilteredReportExpenses();
    const total = list.reduce((sum, e) => sum + Number(e.amount), 0);
    const previewEl = document.getElementById("report-preview");

    previewEl.innerHTML = `
      <p><strong>Matching Expenses:</strong> ${list.length}</p>
      <p><strong>Total Amount:</strong> ${formatCurrency(total)}</p>
    `;
  }

  function escapeHTML(str) {
    return String(str || "").replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[m]);
  }

  // --------------------------------------------------
  // User Actions & Event Handlers
  // --------------------------------------------------

  function populateCategories() {
    const sel = document.getElementById("exp-category");
    sel.innerHTML = state.categories
      .map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`)
      .join("");
  }

  function setupEventListeners() {
    // Tab Navigation
    document.querySelectorAll(".tabs .tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tabs .tab").forEach(t => t.classList.remove("is-active"));
        document.querySelectorAll(".view").forEach(v => v.classList.remove("is-visible"));

        tab.classList.add("is-active");
        const targetView = document.getElementById("view-" + tab.dataset.view);
        if (targetView) targetView.classList.add("is-visible");
      });
    });

    // Settings Navigation
    document.getElementById("open-settings").addEventListener("click", () => {
      document.querySelectorAll(".view").forEach(v => v.classList.remove("is-visible"));
      document.getElementById("view-settings").classList.add("is-visible");
    });

    document.getElementById("back-from-settings").addEventListener("click", () => {
      document.querySelectorAll(".view").forEach(v => v.classList.remove("is-visible"));
      document.getElementById("view-expenses").classList.add("is-visible");
    });

    // Month Navigation Controls
    document.getElementById("prev-month").addEventListener("click", () => {
      const [y, m] = state.currentMonth.split("-").map(Number);
      const prev = new Date(y, m - 2, 1);
      state.currentMonth = getYearMonthString(prev);
      renderAll();
    });

    document.getElementById("next-month").addEventListener("click", () => {
      const [y, m] = state.currentMonth.split("-").map(Number);
      const next = new Date(y, m, 1);
      state.currentMonth = getYearMonthString(next);
      renderAll();
    });

    // Add / Edit Expense Form Submission
    const form = document.getElementById("expense-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();

      const date = document.getElementById("exp-date").value;
      const amount = parseFloat(document.getElementById("exp-amount").value);
      const category = document.getElementById("exp-category").value;
      const description = document.getElementById("exp-desc").value.trim();

      if (!date || isNaN(amount) || !category || !description) return;

      const now = new Date().toISOString();

      if (state.editingId) {
        const item = state.expenses.find(x => x.id === state.editingId);
        if (item) {
          item.date = date;
          item.amount = amount;
          item.category = category;
          item.description = description;
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

      showToast(state.editingId ? "Expense updated!" : "Expense added!");
    });

    document.getElementById("form-cancel").addEventListener("click", resetForm);

    // Expense List Delegation (Edit / Delete)
    document.getElementById("expense-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      const id = btn.dataset.id;
      if (btn.classList.contains("edit")) {
        const exp = state.expenses.find(x => x.id === id);
        if (!exp) return;

        state.editingId = id;
        document.getElementById("exp-date").value = exp.date;
        document.getElementById("exp-amount").value = exp.amount;
        document.getElementById("exp-category").value = exp.category;
        document.getElementById("exp-desc").value = exp.description;

        document.getElementById("form-title").textContent = "EDIT EXPENSE";
        document.getElementById("form-submit").textContent = "Update Expense";
        document.getElementById("form-cancel").classList.remove("hidden");

        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (btn.classList.contains("delete")) {
        confirmModal("Are you sure you want to delete this expense?", () => {
          const exp = state.expenses.find(x => x.id === id);
          if (exp) {
            exp.deleted = true;
            exp.updated_at = new Date().toISOString();
            saveLocalData();
            renderAll();
            syncWithCloud();
          }
        });
      }
    });

    // Clear entire month
    document.getElementById("clear-month").addEventListener("click", () => {
      confirmModal(`Delete all expenses for ${formatMonthLabel(state.currentMonth)}?`, () => {
        const now = new Date().toISOString();
        state.expenses.forEach(e => {
          if (e.date.startsWith(state.currentMonth)) {
            e.deleted = true;
            e.updated_at = now;
          }
        });
        saveLocalData();
        renderAll();
        syncWithCloud();
      });
    });

    // Monthly summary row selection
    document.getElementById("monthly-summary").addEventListener("click", (e) => {
      const row = e.target.closest(".summary-row");
      if (row && row.dataset.ym) {
        state.currentMonth = row.dataset.ym;
        document.querySelector('.tab[data-view="expenses"]').click();
        renderAll();
      }
    });

    // Report Type Controls
    document.querySelectorAll(".choice-grid .choice").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".choice-grid .choice").forEach(c => c.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.reportType = btn.dataset.report;
        renderReportsView();
      });
    });

    document.getElementById("report-fields").addEventListener("input", (e) => {
      if (e.target.id === "rep-date") state.reportParams.date = e.target.value;
      if (e.target.id === "rep-month") state.reportParams.month = e.target.value;
      if (e.target.id === "rep-year") state.reportParams.year = e.target.value;
      if (e.target.id === "rep-start") state.reportParams.startDate = e.target.value;
      if (e.target.id === "rep-end") state.reportParams.endDate = e.target.value;
      renderReportPreview();
    });

    // Report Download Handlers
    document.getElementById("download-csv").addEventListener("click", exportCSV);
    document.getElementById("download-pdf").addEventListener("click", exportPDF);

    // Backup & Restore Handlers
    document.getElementById("export-backup").addEventListener("click", exportBackup);
    document.getElementById("import-backup").addEventListener("click", () => document.getElementById("import-file").click());
    document.getElementById("import-file").addEventListener("change", importBackup);

    // Data wipe handler
    document.getElementById("delete-all").addEventListener("click", () => {
      confirmModal("Delete all data completely? This cannot be undone.", () => {
        const now = new Date().toISOString();
        state.expenses.forEach(e => {
          e.deleted = true;
          e.updated_at = now;
        });
        saveLocalData();
        renderAll();
        syncWithCloud();
      });
    });

    // Auth Event Handlers
    document.getElementById("login-form").addEventListener("submit", handleLogin);
    document.getElementById("auth-logout").addEventListener("click", handleLogout);
    document.getElementById("auth-sync").addEventListener("click", syncWithCloud);

    window.addEventListener("online", syncWithCloud);
  }

  function resetForm() {
    state.editingId = null;
    document.getElementById("expense-form").reset();
    document.getElementById("exp-date").value = getTodayString();
    document.getElementById("form-title").textContent = "ADD EXPENSE";
    document.getElementById("form-submit").textContent = "+ Add Expense";
    document.getElementById("form-cancel").classList.add("hidden");
  }

  function showToast(msg) {
    const toast = document.getElementById("form-toast");
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 3000);
  }

  function confirmModal(text, onConfirm) {
    const modal = document.getElementById("modal");
    document.getElementById("modal-text").textContent = text;
    modal.hidden = false;

    const okBtn = document.getElementById("modal-ok");
    const cancelBtn = document.getElementById("modal-cancel");

    const cleanup = () => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
    };

    const onOk = () => { cleanup(); onConfirm(); };
    const onCancel = () => { cleanup(); };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  }

  // --------------------------------------------------
  // CSV & PDF Reporting
  // --------------------------------------------------

  function exportCSV() {
    const list = getFilteredReportExpenses();
    if (list.length === 0) {
      alert("No expenses found for this selection.");
      return;
    }

    let csv = "Date,Category,Description,Amount\n";
    list.forEach(e => {
      const desc = `"${e.description.replace(/"/g, '""')}"`;
      csv += `${e.date},"${e.category}",${desc},${e.amount}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `expenses-${state.reportType}-${getTodayString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPDF() {
    const list = getFilteredReportExpenses();
    if (list.length === 0) {
      alert("No expenses found for this selection.");
      return;
    }

    const total = list.reduce((sum, e) => sum + Number(e.amount), 0);
    const win = window.open("", "_blank");
    if (!win) {
      alert("Pop-up blocked. Please allow pop-ups to download PDF.");
      return;
    }

    let rows = list.map(e => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${formatDateLabel(e.date)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${escapeHTML(e.category)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${escapeHTML(e.description)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">Rs. ${Number(e.amount).toFixed(2)}</td>
      </tr>
    `).join("");

    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Expense Report</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 20px; color: #111; }
          h1 { margin-bottom: 4px; }
          .muted { color: #666; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th { text-align: left; padding: 8px; border-bottom: 2px solid #111; }
          .total { font-weight: bold; font-size: 18px; margin-top: 20px; text-align: right; }
        </style>
      </head>
      <body>
        <h1>Expense Report</h1>
        <p class="muted">Generated on ${formatDateLabel(getTodayString())}</p>
        <table>
          <thead>
            <tr><th>Date</th><th>Category</th><th>Description</th><th style="text-align: right;">Amount</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="total">Total: Rs. ${total.toFixed(2)}</p>
        <script>window.onload = function() { window.print(); };</script>
      </body>
      </html>
    `);
    win.document.close();
  }

  function exportBackup() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
    const a = document.createElement("a");
    a.href = dataStr;
    a.download = `my-expenses-backup-${getTodayString()}.json`;
    a.click();
  }

  function importBackup(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);
        if (Array.isArray(parsed.expenses)) {
          state.expenses = parsed.expenses;
          if (Array.isArray(parsed.categories)) state.categories = parsed.categories;
          saveLocalData();
          renderAll();
          syncWithCloud();
          alert("Backup imported successfully!");
        } else {
          alert("Invalid backup file format.");
        }
      } catch (err) {
        alert("Error parsing backup file.");
      }
    };
    reader.readAsText(file);
  }

  // --------------------------------------------------
  // Authentication Controllers
  // --------------------------------------------------

  async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const btn = document.getElementById("auth-login");
    const errEl = document.getElementById("login-error");

    if (!supabaseClient) {
      alert("Supabase client is not available. Check your config.js.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Logging in...";
    errEl.hidden = true;

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;

      currentUser = data.user;
      showAppScreen();
      syncWithCloud();
    } catch (err) {
      errEl.textContent = err.message || "Login failed.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Log In";
    }
  }

  async function handleLogout() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    document.getElementById("app").hidden = true;
    document.getElementById("login-screen").hidden = false;
  }

  function showAppScreen() {
    document.getElementById("login-screen").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("auth-who").textContent = `Logged in as: ${currentUser.email}`;
    document.getElementById("auth-who").hidden = false;
  }

  async function initAuth() {
    if (!supabaseClient) return;

    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session) {
      currentUser = data.session.user;
      showAppScreen();
      syncWithCloud();
    } else {
      document.getElementById("login-screen").hidden = false;
      document.getElementById("app").hidden = true;
    }

    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (session && session.user) {
        currentUser = session.user;
        showAppScreen();
      } else {
        currentUser = null;
        document.getElementById("app").hidden = true;
        document.getElementById("login-screen").hidden = false;
      }
    });
  }

  // --------------------------------------------------
  // Application Startup Initialization
  // --------------------------------------------------

  function init() {
    loadLocalData();
    populateCategories();
    document.getElementById("exp-date").value = getTodayString();
    setupEventListeners();
    renderAll();

    initSupabase();
    initAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();