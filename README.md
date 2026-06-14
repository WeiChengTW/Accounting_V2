# Accounting V2 (記帳系統)

基於 LINE Bot + LIFF 的群組記帳與分帳系統，整合以房養老貸款追蹤。

---

## 技術架構

- **後端**：Python 3 + Flask，單一檔案 `app.py`
- **資料庫**：SQLite (`bookkeeping.db`)，無 ORM，全部走 `run_query()`
- **前端**：單頁 LIFF App，`templates/liff.html` + `static/js/app.js`
- **LINE 整合**：Messaging API Webhook (`/callback`) + LIFF (`/liff`)

---

## 快速啟動

```bash
bash start.sh              # Flask + ngrok 一起啟動（推薦）
.venv/bin/python3 app.py   # 只啟動 Flask（port 5001）
tail -f app.log            # 看即時 log
```

環境變數放 `.env`：

```env
CHANNEL_ACCESS_TOKEN=...
CHANNEL_SECRET=...
```

`LIFF_ID` 寫死在 `app.py:34`，換 LIFF App 時要更新。

---

## 資料庫結構

| 資料表 | 用途 |
|--------|------|
| `records` | 收支記帳，欄位：`chat_id`, `user_id`, `user_name`, `item`, `amount`, `record_type`（收入/支出）, `created_at` |
| `members` | LINE 用戶（每次開 LIFF 時 upsert） |
| `manual_members` | 手動新增的非 LINE 成員，`user_id` 格式為 `__manual_<name>` |
| `settlement_payments` | 已還款紀錄 |
| `group_config` | 每個 chat 的設定，`(chat_id, key, value)` |

### group_config 常用 key

| key | 說明 | 預設 |
|-----|------|------|
| `balance_start_month` | 結餘計算起始月，格式 `YYYY-MM` | 前一個月 |
| `loan_quota` | 每月銀行可動用額度（元） | 0 |
| `loan_rate` | 以房養老年利率（%） | 2.79 |

---

## 以房養老邏輯（重要）

### 概念

本系統將「以房養老」（逆向抵押貸款信用額度）整合進分帳計算。銀行每月最多可撥 **70,833 元**（預設值，存於 group_config `loan_quota`），只對實際動用金額收利息。

### 收入優先順序

> **手動記的收入先用，不夠再動用銀行額度。**

```
shortfall      = max(當月支出 - 上月結餘 - 手動收入, 0)
loan_used      = min(shortfall, loan_quota)          # 只取需要的部分
available_bank = 上月結餘 + 手動收入 + loan_used
bank_reimburse = min(當月支出, available_bank)       # 銀行替大家付的部分
member_extra   = 當月支出 - bank_reimburse           # 成員需自行分攤的部分
```

### 相關函式（`app.py`）

| 函式 | 說明 |
|------|------|
| `get_loan_quota(chat_id)` | 從 group_config 讀取每月額度 |
| `get_balance_summary(chat_id, range_spec)` | 回傳 `(total_expense, manual_income, paid_rows)`，**不含**銀行額度 |
| `get_previous_month_balance(chat_id, range_spec)` | 逐月滾算結餘，每月先用手動收入，不足才動用 loan_quota |
| `compute_transfers(chat_id, range_spec)` | 跑完整分帳算法，回傳轉帳清單，用於判斷是否有未結算 |
| `api_settlement()` | 算錢分頁的主要 API，同樣套用 shortfall 邏輯 |

### 月結餘滾算（`get_previous_month_balance`）

從 `balance_start_month` 開始逐月計算，餘額每月不會低於 0：

```python
shortfall = max(expense - balance - manual_income, 0)
loan_used = min(shortfall, loan_quota)
balance   = max(balance + manual_income + loan_used - expense, 0)
```

### 未結算判定

`/api/unsettled_check` 跑 `compute_transfers()` 來判斷，若轉帳清單為空代表已結算（不看還款紀錄筆數）。這樣銀行完全 cover 所有費用時，成員間不需互相轉帳，也不會誤判為未結算。

---

## 貸款計算分頁

- **起算月**：2026-06（寫死在 `static/js/app.js` `loanImportFromRecords`，`d.month >= "2026-06"`）
- **每月額度**：預設 70,833 元（唯讀顯示，存在 group_config `loan_quota`）
- **年利率**：存在 group_config `loan_rate`，離開輸入框時自動儲存
- **利息計算**：`本月動用 × 年利率 / 12`（單利，只算當月動用本金）
- **資料來源**：自動從 `records` 表匯入各月支出加總，用戶可手動覆蓋
- **手動覆蓋保護**：`loanManualEdits` Set 記錄用戶改過的月份，重新匯入時不覆蓋

### 前端相關函式（`static/js/app.js`）

| 函式 | 說明 |
|------|------|
| `initLoanCalc()` | Tab 初始化，載入利率、同步 loan_quota，呼叫 `loanImportFromRecords(true)` |
| `loanImportFromRecords(silent)` | 從 `/api/monthly_expenses` 拉資料，過濾 >= 2025-06，保留手動編輯月份 |
| `renderLoanTable()` | 重繪月份卡片（本月動用、本月利息、累積利息）和頂部統計（累計動用、累計利息、最近一期利息） |
| `calcLoan()` | 切換到貸款 Tab 時呼叫，等同 `loanImportFromRecords(false)` |

### 後端 API

| 路由 | 說明 |
|------|------|
| `GET /api/monthly_expenses?chat_id=` | 回傳所有月份支出加總 `[{month, total}]`，無年份過濾 |
| `GET /api/config?chat_id=&key=` | 讀取 group_config 單一 key |
| `POST /api/config` body `{chat_id, key, value}` | 寫入 group_config |

---

## 分帳演算法（`app.py` `api_settlement`）

1. 算出銀行實際補貼（`bank_reimburse`）與成員需分攤金額（`member_extra`）
2. 銀行補貼按各人實際付出比例退還（`allocate_proportional`）
3. 成員分攤金額平均拆分
4. 加總每人「應收／應付」後，以 greedy 法配對算出最少轉帳次數

---

## 專案結構

```
app.py                  # Flask 主程式（所有後端邏輯、API、DB）
templates/liff.html     # 前端單頁 App HTML
static/js/app.js        # 前端邏輯
static/css/style.css    # 樣式
start.sh                # 啟動腳本（Flask + ngrok）
bookkeeping.db          # SQLite 資料庫（自動產生）
```

---

## 注意事項

- 所有 API 都需 LINE LIFF Access Token（`Authorization: Bearer <token>`），由 `get_verified_user_id()` 驗證
- `chat_id` 格式：`group:<id>`、`room:<id>`、`user:<id>`
- Schema 變更用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 在 `init_db()` 裡做，不用 migration 工具
