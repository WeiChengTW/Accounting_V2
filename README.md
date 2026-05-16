# Accounting V2 (記帳系統)

這是一個基於 LINE Bot 與 LIFF (LINE Front-end Framework) 建立的群組記帳與分帳系統。系統允許使用者在 LINE 聊天室中呼叫記帳工具，並透過網頁介面輕鬆記錄花費、檢視收支統計以及計算結算與分帳金額。

## 功能特色

- **LINE Bot 整合**：支援在群組、聊天室或個人對話中 @提及機器人來喚醒記帳功能。
- **LIFF 網頁介面**：提供直覺的 Web 介面，免去在聊天室輸入繁瑣指令的麻煩。
- **收支紀錄**：支援記錄各項「收入」與「支出」，並記錄付款人與款項名稱。
- **統計與結算**：自動計算本月結餘、各成員支出金額，並具備智慧分帳功能，能計算出最少轉帳次數的還款方案。
- **自訂成員**：除了群組內已授權的 LINE 使用者外，也可以手動新增「未加入 LINE 群組的成員」進行記帳與分帳。

## 技術架構

- **後端框架**：Python 3 + Flask
- **資料庫**：SQLite (`bookkeeping.db`)
- **LINE 整合**：`line-bot-sdk` (Messaging API & Webhook)
- **環境變數管理**：`python-dotenv`

## 安裝與執行

### 1. 建立環境與安裝依賴

建議使用虛擬環境 (Virtual Environment)：

```bash
python -m venv .venv
source .venv/bin/activate  # Windows 環境請使用 .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. 環境變數設定

請在專案根目錄建立一個 `.env` 檔案，並填入以下資訊：

```env
CHANNEL_ACCESS_TOKEN=你的_LINE_BOT_ACCESS_TOKEN
CHANNEL_SECRET=你的_LINE_BOT_CHANNEL_SECRET
```

*(請確保從 LINE Developers Console 中獲取正確的 Token 資訊)*

### 3. 啟動服務

可直接使用 Python 執行，或使用提供的啟動腳本：

```bash
bash start.sh
# 或
python app.py
```

預設會運行在本機的 Flask 伺服器，若要供 LINE Webhook 呼叫，建議搭配 `ngrok` 使用：

```bash
ngrok http 5000
```
然後將 `ngrok` 提供的 HTTPS 網址加上 `/callback`，填入 LINE Developers Console 的 Webhook URL 欄位。

## 專案結構

- `app.py`: 主要的 Flask 應用程式邏輯、API 路由與資料庫操作。
- `requirements.txt`: 專案所需的 Python 套件清單。
- `start.sh`: 啟動腳本。
- `bookkeeping.db`: 系統自動生成的 SQLite 資料庫檔案。
- `templates/`: HTML 樣板資料夾（包含 LIFF 頁面）。
- `static/`: 靜態資源資料夾（CSS, JS 等）。
- `ngrok.yml`: ngrok 相關設定檔。

## 注意事項

- 請在 `app.py` 中將 `LIFF_ID` 替換為你在 LINE Login 頻道中所建立的 LIFF ID。
- 請確保 Webhook 已開啟並且通過驗證。

