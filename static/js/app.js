// ─── Theme ────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", saved || (prefersDark ? "dark" : "light"));
})();

const SVG_SUN  = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
const SVG_MOON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function setupTheme() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  _updateThemeIcon(document.documentElement.getAttribute("data-theme"));
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    _updateThemeIcon(next);
  });
}

function _updateThemeIcon(theme) {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.innerHTML = theme === "dark" ? SVG_SUN : SVG_MOON;
  btn.setAttribute("aria-label", theme === "dark" ? "切換淺色模式" : "切換深色模式");
}

// ─── Globals ──────────────────────────────────────────────────
let ACCESS_TOKEN = "";
let CHAT_ID = "";
let USER_NAME = "";
let CURRENT_USER_ID = "";
let CURRENT_RECORDS = [];
let CURRENT_MEMBERS = [];

// ─── Init ─────────────────────────────────────────────────────
liff.init({ liffId: LIFF_ID })
  .then(async () => {
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    ACCESS_TOKEN = liff.getAccessToken();
    const ctx = liff.getContext();
    // Priority 1: URL param from bot message — most reliable, has real LINE group ID
    const _urlParams = new URLSearchParams(location.search);
    CHAT_ID = _urlParams.get("chat_id") || "";
    // Priority 2: localStorage from previous session
    if (!CHAT_ID) {
      CHAT_ID = localStorage.getItem("accounting_chat_id") || "";
    }
    // Priority 3: liff.getContext() user ID (last resort for personal use)
    if (!CHAT_ID && ctx && ctx.userId) {
      CHAT_ID = `user:${ctx.userId}`;
    }
    // Persist group/room ID for next time
    if (CHAT_ID && !CHAT_ID.startsWith("user:")) {
      localStorage.setItem("accounting_chat_id", CHAT_ID);
    }
    // Get user profile and register as member
    try {
      const profile = await liff.getProfile();
      USER_NAME = profile.displayName || "";
      CURRENT_USER_ID = profile.userId || "";
      if (CHAT_ID && USER_NAME) {
        api("POST", "/api/register_member", {
          chat_id: CHAT_ID,
          user_name: USER_NAME,
          picture_url: profile.pictureUrl || "",
        }).catch(() => {});
      }
    } catch (_) {}
    initApp();
  })
  .catch((err) => {
    document.getElementById("loading").innerHTML = `<p style="color:red">初始化失敗: ${err.message}</p>`;
  });

function initApp() {
  document.getElementById("loading").style.display = "none";
  document.getElementById("app").style.display = "block";

  // Set default dates
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  document.getElementById("date").value = today;
  document.getElementById("records-month").value = thisMonth;
  document.getElementById("settlement-month").value = thisMonth;

  setupTheme();
  setupTabs();
  setupForms();
  loadRecords();
  checkUnsettled();
}

// ─── Tabs ─────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).style.display = "block";

      if (tab === "records") loadRecords();
      else if (tab === "settlement") loadSettlement();
      else if (tab === "members") loadMembers();
    });
  });
}

// ─── API helper ───────────────────────────────────────────────
async function api(method, path, body = null, params = {}) {
  const qs = new URLSearchParams({ chat_id: CHAT_ID, ...params });
  const fullPath = `${path}?${qs.toString()}`;

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(fullPath, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "API error");
  return data;
}

function showMsg(elementId, text, isError = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  el.className = `msg-area ${isError ? "msg-error" : "msg-ok"}`;
  setTimeout(() => { el.textContent = ""; el.className = "msg-area"; }, 3000);
}

// ─── Utils ────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n) {
  return Number(n).toLocaleString("zh-TW") + " 元";
}

let _toastTimer = null;
function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.offsetHeight; // force reflow
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove("show"); }, 3000);
}

const AVATAR_COLORS = ["#06C755", "#1976d2", "#FF9800", "#9c27b0", "#e53935", "#00897b"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ─── Add record ───────────────────────────────────────────────
function setupForms() {
  // Segmented control for record type
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("record-type-hidden").value = btn.dataset.value;
    });
  });

  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "記帳中...";
    const item = document.getElementById("item").value.trim();
    const amount = document.getElementById("amount").value;
    const recordType = document.getElementById("record-type-hidden").value;
    const dateValue = document.getElementById("date").value;
    try {
      await api("POST", "/api/record", {
        chat_id: CHAT_ID,
        user_name: USER_NAME,
        item,
        amount,
        record_type: recordType,
        date: dateValue,
      });
      showToast("記帳成功！");
      e.target.reset();
      document.getElementById("date").value = new Date().toISOString().slice(0, 10);
      // Reset segmented control to 支出
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      document.querySelector('.seg-btn[data-value="支出"]').classList.add("active");
      document.getElementById("record-type-hidden").value = "支出";

      // Send Flex message to group
      if (liff.isInClient()) {
        const isExpense = recordType === "支出";
        const color = isExpense ? "#EF4444" : "#10B981";
        const headerLabel = isExpense ? "📤 支出記帳" : "📥 收入記帳";
        liff.sendMessages([{
          type: "flex",
          altText: `${USER_NAME} 記帳：${item} $${amount}`,
          contents: {
            type: "bubble",
            size: "kilo",
            header: {
              type: "box", layout: "vertical", paddingAll: "14px",
              backgroundColor: color,
              contents: [{ type: "text", text: headerLabel, color: "#ffffff", weight: "bold", size: "sm" }]
            },
            body: {
              type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px",
              contents: [
                { type: "text", text: item, weight: "bold", size: "lg", color: "#222222" },
                { type: "text", text: `$${amount}`, size: "xxl", weight: "bold", color: color },
                { type: "separator", margin: "md" },
                { type: "text", text: `記帳人：${USER_NAME}`, size: "sm", color: "#888888", margin: "md" },
                { type: "text", text: `日期：${dateValue}`, size: "sm", color: "#888888" },
              ]
            }
          }
        }]).catch(() => {});
      }
    } catch (err) {
      showToast(`失敗：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "記帳";
    }
  });

  document.getElementById("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("edit-id").value;
    const chatId = document.getElementById("edit-chat-id").value;
    const sel = document.getElementById("edit-user-id");
    const payerUserId = sel.value;
    const payerName = sel.options[sel.selectedIndex]?.dataset.name || "";
    try {
      await api("PUT", `/api/record/${id}`, {
        chat_id: chatId,
        item: document.getElementById("edit-item").value.trim(),
        amount: document.getElementById("edit-amount").value,
        record_type: document.querySelector('input[name="edit_type"]:checked').value,
        date: document.getElementById("edit-date").value,
        user_id: payerUserId,
        user_name: payerName,
      });
      closeModal();
      loadRecords();
    } catch (err) {
      alert(`修改失敗：${err.message}`);
    }
  });

  document.getElementById("add-member-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("POST", "/api/members", {
        chat_id: CHAT_ID,
        name: document.getElementById("member-name").value.trim(),
      });
      showMsg("member-msg", "已新增成員！");
      document.getElementById("member-name").value = "";
      loadMembers();
    } catch (err) {
      showMsg("member-msg", `失敗：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Records tab ──────────────────────────────────────────────
async function loadRecords() {
  const month = document.getElementById("records-month").value;
  const summaryEl = document.getElementById("summary-card");
  const listEl = document.getElementById("records-list");
  summaryEl.innerHTML = "<p class='loading-text'>載入中...</p>";
  listEl.innerHTML = "";

  try {
    const [summaryData, recordsData, membersData] = await Promise.all([
      api("GET", "/api/summary", null, { month }),
      api("GET", "/api/records", null, { month }),
      api("GET", "/api/members"),
    ]);
    CURRENT_MEMBERS = membersData.members || [];

    const balanceClass = summaryData.balance >= 0 ? "income" : "expense";
    summaryEl.innerHTML = `
      <div class="summary-grid">
        <div class="summary-item">
          <span class="label">📅 銀行額度</span>
          <span class="value">${fmt(summaryData.previous_month_balance)}</span>
        </div>
        <div class="summary-item">
          <span class="label">💰 本月撥款</span>
          <span class="value income">${fmt(summaryData.total_income)}</span>
        </div>
        <div class="summary-item">
          <span class="label">💸 本月支出</span>
          <span class="value expense">${fmt(summaryData.total_expense)}</span>
        </div>
        <div class="summary-item">
          <span class="label">🏦 目前可用額度</span>
          <span class="value ${balanceClass}">${fmt(summaryData.balance)}</span>
        </div>
      </div>
      ${summaryData.paid_by_user.length ? `
        <div class="paid-summary">
          <p class="section-title">個人支出</p>
          ${summaryData.paid_by_user.map(u => `<div class="paid-row"><span>${escHtml(u.name)}</span><span>${fmt(u.paid)}</span></div>`).join("")}
        </div>` : ""}
    `;

    CURRENT_RECORDS = recordsData.records;
    if (!recordsData.records.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📝</div>
          <div>這個月還沒有記帳</div>
        </div>`;
      return;
    }

    listEl.innerHTML = `
      <p class="section-title">明細（共 ${recordsData.records.length} 筆）</p>
      ${recordsData.records.map((r) => `
        <div class="record-card">
          <div class="record-header">
            <span class="record-item">${escHtml(r.item)}</span>
            <span class="record-amount ${r.record_type === '支出' ? 'expense' : 'income'}">
              ${r.record_type === '支出' ? '-' : '+'}${fmt(r.amount)}
            </span>
          </div>
          <div class="record-footer">
            <div class="record-meta">
              <span>${r.created_at.slice(0, 10)}</span>
              <span>${escHtml(r.name)}</span>
              <span class="record-type-tag ${r.record_type === '支出' ? 'expense' : 'income'}">${r.record_type}</span>
            </div>
            <div class="record-actions">
              <button class="btn-edit" onclick="openEditModal(${r.id}, ${JSON.stringify(r).replace(/"/g, '&quot;')})">修改</button>
              <button class="btn-delete" onclick="deleteRecord(${r.id})">刪除</button>
            </div>
          </div>
        </div>
      `).join("")}
    `;
  } catch (err) {
    summaryEl.innerHTML = `<p class="error-msg">載入失敗：${err.message}</p>`;
  }
}

function openEditModal(id, record) {
  document.getElementById("edit-id").value = id;
  document.getElementById("edit-chat-id").value = CHAT_ID;
  document.getElementById("edit-item").value = record.item;
  document.getElementById("edit-amount").value = record.amount;
  document.getElementById("edit-date").value = record.created_at.slice(0, 10);
  const typeVal = record.record_type;
  document.querySelectorAll('input[name="edit_type"]').forEach((r) => {
    r.checked = r.value === typeVal;
  });

  // Populate payer dropdown
  const sel = document.getElementById("edit-user-id");
  sel.innerHTML = "";
  const memberOptions = CURRENT_MEMBERS.map(m => ({
    user_id: m.source === "manual" ? `__manual_${m.name}` : m.user_id,
    name: m.name,
  }));
  // Ensure current payer is in the list (old records might not be in members)
  if (!memberOptions.some(o => o.user_id === record.user_id)) {
    memberOptions.unshift({ user_id: record.user_id, name: record.name });
  }
  memberOptions.forEach(o => {
    const opt = document.createElement("option");
    opt.value = o.user_id;
    opt.dataset.name = o.name;
    opt.textContent = o.name;
    opt.selected = o.user_id === record.user_id;
    sel.appendChild(opt);
  });

  document.getElementById("modal").style.display = "flex";
}

function closeModal() {
  document.getElementById("modal").style.display = "none";
}

async function deleteRecord(id) {
  if (!confirm("確定要刪除這筆記帳？")) return;
  try {
    await api("DELETE", `/api/record/${id}`);
    loadRecords();
  } catch (err) {
    alert(`刪除失敗：${err.message}`);
  }
}

// ─── Settlement tab ───────────────────────────────────────────
async function loadSettlement() {
  const month = document.getElementById("settlement-month").value;
  const el = document.getElementById("settlement-result");
  el.innerHTML = "<p class='loading-text'>計算中...</p>";
  _updateUnsettledBanner();

  try {
    const data = await api("GET", "/api/settlement", null, { month });

    if (data.message) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💰</div>
          <div>${data.message}</div>
        </div>`;
      return;
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-header card-header--blue">💹 ${escHtml(data.month)} 統計</div>
        <div class="stat-row"><span>銀行額度</span><span>${fmt(data.previous_month_balance)}</span></div>
        <div class="stat-row"><span>本月撥款</span><span class="income">${fmt(data.total_income)}</span></div>
        <div class="stat-row"><span>本期總支出</span><span class="expense">${fmt(data.total_expense)}</span></div>
        <div class="stat-row"><span>銀行可支應</span><span>${fmt(data.bank_reimbursement)}</span></div>
        <div class="stat-row highlight"><span>每人須補差額</span><span>${fmt(data.per_person_extra)}</span></div>
      </div>

      <div class="card">
        <div class="card-header card-header--green">👤 每人分攤</div>
        ${data.participants.map((p) => `
          <div class="participant-row">
            <span class="participant-name">${escHtml(p.name)}</span>
            <span class="participant-paid">付：${fmt(p.paid)}</span>
            <span class="participant-withdraw">收：${fmt(p.bank_withdraw)}</span>
          </div>`).join("")}
      </div>

      ${data.transfers.length ? `
        <div class="card">
          <div class="card-header card-header--orange">🔁 轉帳建議</div>
          ${data.transfers.map((t) => `
            <div class="transfer-row">
              <span>${escHtml(t.from_name)}</span>
              <span class="arrow">→</span>
              <span>${escHtml(t.to_name)}</span>
              <span class="transfer-amt">${fmt(t.amount)}</span>
              <button class="btn-repay" data-to="${escHtml(t.to_name)}" data-amount="${t.amount}" data-from-user-id="${escHtml(t.from_user_id)}" data-from-name="${escHtml(t.from_name)}" onclick="openPaymentInline(this)">還款</button>
            </div>`).join("")}
          ${data.participants.some(p => p.bank_withdraw > 0) ? `
          <div class="bank-withdraw-section">
            <div class="bank-withdraw-title">💳 銀行領回</div>
            ${data.participants.filter(p => p.bank_withdraw > 0).map(p => `
              <div class="bank-withdraw-row">
                <span>${escHtml(p.name)}</span>
                <span class="bank-withdraw-amt">${fmt(p.bank_withdraw)}</span>
              </div>`).join("")}
          </div>` : ""}
        </div>` : `
        <div class="card">
          <div class="empty-state" style="padding:20px 0">
            <div class="empty-icon">✅</div>
            <div>無需轉帳</div>
          </div>
          ${data.participants.some(p => p.bank_withdraw > 0) ? `
          <div class="bank-withdraw-section">
            <div class="bank-withdraw-title">💳 銀行領回</div>
            ${data.participants.filter(p => p.bank_withdraw > 0).map(p => `
              <div class="bank-withdraw-row">
                <span>${escHtml(p.name)}</span>
                <span class="bank-withdraw-amt">${fmt(p.bank_withdraw)}</span>
              </div>`).join("")}
          </div>` : ""}
        </div>`}

      ${data.payments.length ? `
        <div class="card">
          <p class="card-title">已登記補款</p>
          ${data.payments.map((p) => `
            <div class="stat-row">
              <span>${escHtml(p.from_name)} → ${escHtml(p.to_name)}</span>
              <span>${fmt(p.amount)}</span>
              <button class="btn-delete-payment" onclick="deletePayment(${p.id}, this)">✕</button>
            </div>`).join("")}
        </div>` : ""}
    `;
  } catch (err) {
    el.innerHTML = `<p class="error-msg">載入失敗：${err.message}</p>`;
  }
}

// ─── Unsettled reminder ───────────────────────────────────────
let UNSETTLED_MONTH = "";

async function checkUnsettled() {
  try {
    const data = await api("GET", "/api/unsettled_check");
    UNSETTLED_MONTH = data.unsettled ? data.month : "";
    const badge = document.getElementById("settlement-badge");
    if (badge) badge.style.display = data.unsettled ? "inline-block" : "none";
    _updateUnsettledBanner();
  } catch (_) {}
}

function _updateUnsettledBanner() {
  const banner = document.getElementById("unsettled-banner");
  if (!banner) return;
  const month = document.getElementById("settlement-month").value;
  if (UNSETTLED_MONTH && month === UNSETTLED_MONTH) {
    banner.style.display = "flex";
    const [y, m] = UNSETTLED_MONTH.split("-");
    banner.textContent = `⚠️ ${y} 年 ${parseInt(m, 10)} 月尚未結算`;
  } else {
    banner.style.display = "none";
  }
}

function openPaymentInline(btn) {
  document.querySelectorAll(".payment-inline").forEach(el => el.remove());
  document.querySelectorAll(".btn-repay").forEach(b => b.classList.remove("active"));

  const toName = btn.dataset.to;
  const defaultAmt = btn.dataset.amount;
  const fromUserId = btn.dataset.fromUserId;
  const fromName = btn.dataset.fromName;
  const row = btn.closest(".transfer-row");

  btn.classList.add("active");

  const isSelf = (CURRENT_USER_ID && fromUserId && CURRENT_USER_ID === fromUserId)
             || (USER_NAME && fromName && USER_NAME === fromName)
             || (USER_NAME && toName && USER_NAME === toName);
  const isOther = !isSelf && !!(fromUserId || fromName);
  if (isOther && !confirm(`你不是 ${fromName}，確定要幫他登記還款給 ${toName} 嗎？`)) {
    btn.classList.remove("active");
    return;
  }

  const inline = document.createElement("div");
  inline.className = "payment-inline";
  inline.dataset.to = toName;
  inline.dataset.fromUserId = fromUserId;
  inline.innerHTML = `
    <div class="payment-inline-label">還給 ${escHtml(toName)}</div>
    <div class="payment-inline-controls">
      <input type="number" class="payment-inline-input" value="${defaultAmt}" min="1">
      <button class="btn-primary payment-inline-confirm" onclick="submitPaymentInline(this)">確認還款</button>
      <button class="btn-secondary payment-inline-cancel" onclick="closePaymentInline(this)">取消</button>
    </div>
  `;
  row.insertAdjacentElement("afterend", inline);
  inline.querySelector(".payment-inline-input").focus();
}

async function deletePayment(id, btn) {
  if (!confirm("確定刪除這筆補款紀錄？")) return;
  btn.disabled = true;
  try {
    await api("DELETE", `/api/payment/${id}`);
    loadSettlement();
    checkUnsettled();
  } catch (err) {
    showToast(`刪除失敗：${err.message}`, true);
    btn.disabled = false;
  }
}

function closePaymentInline(btn) {
  btn.closest(".payment-inline").remove();
  document.querySelectorAll(".btn-repay").forEach(b => b.classList.remove("active"));
}

async function submitPaymentInline(btn) {
  const inline = btn.closest(".payment-inline");
  const toName = inline.dataset.to;
  const amount = inline.querySelector(".payment-inline-input").value;
  if (!amount || Number(amount) < 1) return;
  btn.disabled = true;
  btn.textContent = "登記中...";
  try {
    const month = document.getElementById("settlement-month").value;
    const fromUserId = inline.dataset.fromUserId || "";
    await api("POST", "/api/payment", { chat_id: CHAT_ID, to_name: toName, amount, month, from_user_id: fromUserId });
    showToast(`已登記還款 ${fmt(amount)} 給 ${escHtml(toName)}`);
    inline.remove();
    loadSettlement();
    checkUnsettled();
  } catch (err) {
    showToast(`失敗：${err.message}`, true);
    btn.disabled = false;
    btn.textContent = "確認還款";
  }
}

// ─── Members tab ──────────────────────────────────────────────
async function loadMembers() {
  const el = document.getElementById("members-list");
  el.innerHTML = "<p class='loading-text'>載入中...</p>";
  try {
    const data = await api("GET", "/api/members");
    if (!data.members.length) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">👥</div>
          <div>尚無成員資料</div>
        </div>`;
      return;
    }
    const lineMembers = data.members.filter(m => m.source === "line");
    el.innerHTML = `
      <p class="section-title">共 ${data.members.length} 人</p>
      ${data.members.map((m) => {
        const avatarHtml = m.picture_url
          ? `<img class="member-avatar-img" src="${escHtml(m.picture_url)}" alt="">`
          : `<div class="member-avatar" style="background:${avatarColor(m.name)}">${escHtml(m.name.charAt(0))}</div>`;
        return `
          <div class="member-row">
            ${avatarHtml}
            <span>${escHtml(m.name)}</span>
            <span class="member-source">${m.source === "manual" ? "手動" : "群組"}</span>
            ${m.source === "manual" ? `
              ${lineMembers.length ? `<button class="btn-edit" onclick="openMergeModal('${escHtml(m.name)}', ${JSON.stringify(lineMembers).replace(/"/g, '&quot;')})">合併</button>` : ""}
              <button class="btn-delete" onclick="deleteMember('${escHtml(m.name)}')">刪除</button>
            ` : ""}
          </div>`;
      }).join("")}
    `;
  } catch (err) {
    el.innerHTML = `<p class="error-msg">載入失敗：${err.message}</p>`;
  }
}

function openMergeModal(manualName, lineMembers) {
  document.getElementById("merge-manual-name").textContent = manualName;
  const listEl = document.getElementById("merge-line-list");
  listEl.innerHTML = lineMembers.map(m => `
    <button class="merge-option" onclick="confirmMerge('${escHtml(manualName)}', '${escHtml(m.user_id)}', '${escHtml(m.name)}')">
      <span>${escHtml(m.name)}</span>
      <span class="merge-arrow">→ 保留此人</span>
    </button>
  `).join("");
  document.getElementById("merge-modal").style.display = "flex";
}

function closeMergeModal() {
  document.getElementById("merge-modal").style.display = "none";
}

async function confirmMerge(manualName, _realUserId, realName) {
  if (!confirm(`確定將手動成員「${manualName}」合併為「${realName}」？\n手動成員將被移除。`)) return;
  try {
    await api("POST", "/api/members/merge", { chat_id: CHAT_ID, manual_name: manualName });
    closeMergeModal();
    loadMembers();
  } catch (err) {
    alert(`合併失敗：${err.message}`);
  }
}

async function deleteMember(name) {
  if (!confirm(`確定刪除成員「${name}」？`)) return;
  try {
    await api("DELETE", `/api/members/${encodeURIComponent(name)}`);
    loadMembers();
  } catch (err) {
    alert(`刪除失敗：${err.message}`);
  }
}
