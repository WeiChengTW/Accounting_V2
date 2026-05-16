// ─── Globals ──────────────────────────────────────────────────
let ACCESS_TOKEN = "";
let CHAT_ID = "";
let USER_NAME = "";
let CURRENT_RECORDS = [];

// ─── Init ─────────────────────────────────────────────────────
liff.init({ liffId: LIFF_ID })
  .then(async () => {
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    ACCESS_TOKEN = liff.getAccessToken();
    const ctx = liff.getContext();
    if (ctx) {
      if (ctx.groupId) CHAT_ID = `group:${ctx.groupId}`;
      else if (ctx.roomId) CHAT_ID = `room:${ctx.roomId}`;
      else if (ctx.userId) CHAT_ID = `user:${ctx.userId}`;
    }
    // Fallback: read from URL param (passed by bot in LIFF URL)
    if (!CHAT_ID) {
      const params = new URLSearchParams(location.search);
      CHAT_ID = params.get("chat_id") || "";
    }
    // Fallback: localStorage (persists across LIFF restarts)
    if (!CHAT_ID) {
      CHAT_ID = localStorage.getItem("accounting_chat_id") || "";
    }
    // Persist for next time
    if (CHAT_ID) localStorage.setItem("accounting_chat_id", CHAT_ID);
    // Get user profile and register as member
    try {
      const profile = await liff.getProfile();
      USER_NAME = profile.displayName || "";
      if (CHAT_ID && USER_NAME) {
        api("POST", "/api/register_member", { chat_id: CHAT_ID, user_name: USER_NAME }).catch(() => {});
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

  setupTabs();
  setupForms();
  loadRecords();
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
  const url = new URL(path, location.origin);
  url.searchParams.set("chat_id", CHAT_ID);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
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

// ─── Add record ───────────────────────────────────────────────
function setupForms() {
  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    const item = document.getElementById("item").value.trim();
    const amount = document.getElementById("amount").value;
    const recordType = document.querySelector('input[name="record_type"]:checked').value;
    const dateValue = document.getElementById("date").value;
    try {
      await api("POST", "/api/record", {
        chat_id: CHAT_ID,
        item,
        amount,
        record_type: recordType,
        date: dateValue,
      });
      showMsg("add-msg", "記帳成功！");
      e.target.reset();
      document.getElementById("date").value = new Date().toISOString().slice(0, 10);
      document.querySelector('input[name="record_type"][value="支出"]').checked = true;

      // Send Flex message to group
      if (liff.isInClient()) {
        const isExpense = recordType === "支出";
        const color = isExpense ? "#e53935" : "#1976d2";
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
      showMsg("add-msg", `失敗：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("edit-id").value;
    const chatId = document.getElementById("edit-chat-id").value;
    try {
      await api("PUT", `/api/record/${id}`, {
        chat_id: chatId,
        item: document.getElementById("edit-item").value.trim(),
        amount: document.getElementById("edit-amount").value,
        record_type: document.querySelector('input[name="edit_type"]:checked').value,
        date: document.getElementById("edit-date").value,
      });
      closeModal();
      loadRecords();
    } catch (err) {
      alert(`修改失敗：${err.message}`);
    }
  });

  document.getElementById("payment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("POST", "/api/payment", {
        chat_id: CHAT_ID,
        to_name: document.getElementById("payment-to").value.trim(),
        amount: document.getElementById("payment-amount").value,
      });
      showMsg("payment-msg", "補款登記成功！");
      e.target.reset();
      loadSettlement();
    } catch (err) {
      showMsg("payment-msg", `失敗：${err.message}`, true);
    } finally {
      btn.disabled = false;
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
    const [summaryData, recordsData] = await Promise.all([
      api("GET", "/api/summary", null, { month }),
      api("GET", "/api/records", null, { month }),
    ]);

    // Summary card
    summaryEl.innerHTML = `
      <div class="summary-grid">
        <div class="summary-item">
          <span class="label">前月結餘</span>
          <span class="value">${summaryData.previous_month_balance}</span>
        </div>
        <div class="summary-item">
          <span class="label">本月收入</span>
          <span class="value income">${summaryData.total_income}</span>
        </div>
        <div class="summary-item">
          <span class="label">本月支出</span>
          <span class="value expense">${summaryData.total_expense}</span>
        </div>
        <div class="summary-item">
          <span class="label">目前餘額</span>
          <span class="value ${summaryData.balance >= 0 ? 'income' : 'expense'}">${summaryData.balance}</span>
        </div>
      </div>
      ${summaryData.paid_by_user.length ? `
        <div class="paid-summary">
          <p class="section-title">各人支出</p>
          ${summaryData.paid_by_user.map(u => `<div class="paid-row"><span>${u.name}</span><span>${u.paid}</span></div>`).join("")}
        </div>` : ""}
    `;

    CURRENT_RECORDS = recordsData.records;
    if (!recordsData.records.length) {
      listEl.innerHTML = "<p class='empty-msg'>該月份尚無紀錄</p>";
      return;
    }

    listEl.innerHTML = `
      <p class="section-title">明細（共 ${recordsData.records.length} 筆）</p>
      ${recordsData.records.map((r) => `
        <div class="record-card">
          <div class="record-header">
            <span class="record-item">${escHtml(r.item)}</span>
            <span class="record-amount ${r.record_type === '支出' ? 'expense' : 'income'}">
              ${r.record_type === '支出' ? '-' : '+'}${r.amount}
            </span>
          </div>
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

  try {
    const data = await api("GET", "/api/settlement", null, { month });

    if (data.message) {
      el.innerHTML = `<p class="empty-msg">${data.message}</p>`;
      return;
    }

    el.innerHTML = `
      <div class="card">
        <p class="card-title">${data.month} 算錢結果</p>
        <div class="stat-row"><span>前月結餘</span><span>${data.previous_month_balance}</span></div>
        <div class="stat-row"><span>本月收入</span><span class="income">${data.total_income}</span></div>
        <div class="stat-row"><span>本期總支出</span><span class="expense">${data.total_expense}</span></div>
        <div class="stat-row"><span>銀行可支應</span><span>${data.bank_reimbursement}</span></div>
        <div class="stat-row highlight"><span>每人須補差額</span><span>${data.per_person_extra}</span></div>
      </div>

      <div class="card">
        <p class="card-title">付款明細</p>
        ${data.participants.map((p) => `
          <div class="stat-row">
            <span>${escHtml(p.name)}</span>
            <span>付了 ${p.paid}，可領 ${p.bank_withdraw}</span>
          </div>`).join("")}
      </div>

      ${data.transfers.length ? `
        <div class="card">
          <p class="card-title">轉帳建議</p>
          ${data.transfers.map((t) => `
            <div class="transfer-row">
              <span>${escHtml(t.from_name)}</span>
              <span class="arrow">→</span>
              <span>${escHtml(t.to_name)}</span>
              <span class="transfer-amt">${t.amount}</span>
            </div>`).join("")}
        </div>` : `<div class="card"><p class="empty-msg">無需轉帳</p></div>`}

      ${data.payments.length ? `
        <div class="card">
          <p class="card-title">已登記補款</p>
          ${data.payments.map((p) => `
            <div class="stat-row">
              <span>${escHtml(p.from_name)} → ${escHtml(p.to_name)}</span>
              <span>${p.amount}</span>
            </div>`).join("")}
        </div>` : ""}
    `;
  } catch (err) {
    el.innerHTML = `<p class="error-msg">載入失敗：${err.message}</p>`;
  }
}

// ─── Members tab ──────────────────────────────────────────────
async function loadMembers() {
  const el = document.getElementById("members-list");
  el.innerHTML = "<p class='loading-text'>載入中...</p>";
  try {
    const data = await api("GET", "/api/members");
    if (!data.members.length) {
      el.innerHTML = "<p class='empty-msg'>尚無成員資料</p>";
      return;
    }
    const lineMembers = data.members.filter(m => m.source === "line");
    el.innerHTML = data.members.map((m) => `
      <div class="member-row">
        <span>${escHtml(m.name)}</span>
        <span class="member-source">${m.source === "manual" ? "手動" : "群組"}</span>
        ${m.source === "manual" ? `
          ${lineMembers.length ? `<button class="btn-edit" onclick="openMergeModal('${escHtml(m.name)}', ${JSON.stringify(lineMembers).replace(/"/g, '&quot;')})">合併</button>` : ""}
          <button class="btn-delete" onclick="deleteMember('${escHtml(m.name)}')">刪除</button>
        ` : ""}
      </div>
    `).join("");
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

async function confirmMerge(manualName, realUserId, realName) {
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

// ─── Utils ────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
