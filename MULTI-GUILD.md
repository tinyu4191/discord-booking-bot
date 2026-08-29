# 多語音群架構說明

機器人現在可以同一個帳號、同時服務多個 Discord 語音群，每個語音群各自的頻道設定存在資料庫的
`guild_settings` 表，不再寫死在 `.env` 裡。週期鎖定樣板也是每個語音群各自獨立，互不影響。

⚠️ 這次改動的核心原則：**不能影響現有正式群的運作**。以下步驟務必照順序做，尤其是遷移前的備份。

## 第一步：你現有的語音群 —— 遷移（只需要做一次）

因為你已經有正式在用的資料，**不要刪除 `bookings.db` 重來**，用遷移腳本把現有資料轉過去。

### 1. 備份資料庫（一定要做）

```bash
cd ~/booking-bot
cp bookings.db bookings.db.backup-$(date +%Y%m%d-%H%M)
```

如果遷移過程出任何差錯，把備份檔案複製回 `bookings.db` 就能完整還原。

### 2. 找到你現有語音群的 guild_id

Discord 裡對你的語音群伺服器圖示按右鍵 →「複製伺服器 ID」（要先開開發者模式：設定 → 進階 → 開發者模式）。

### 3. 確認 `.env` 裡還留著舊的四個頻道 ID

遷移腳本需要從 `.env` 讀取現有設定寫進資料庫，跑遷移之前**先不要刪**這幾行：
```
BOOKING_PARENT_CHANNEL_ID=...
ADMIN_CHANNEL_ID=...
MANAGEMENT_CHANNEL_ID=...
ANNOUNCEMENT_CHANNEL_ID=...
```

### 4. 更新程式碼

```bash
cd ~/booking-bot
git pull   # 或覆蓋 src/db.js、src/index.js、scripts/ 底下的檔案
```

**注意**：這次也把週報告功能整個移除了（`src/report.js`、`scripts/generate-weekly-report.js`、
`scripts/generate-html-report.js` 都不存在了）。如果你 VM 上還留著這幾個檔案跟 `reports/` 資料夾，
可以順手清掉：
```bash
rm -f src/report.js scripts/generate-weekly-report.js scripts/generate-html-report.js
rm -rf reports/
```
如果你之前為了看 `report.html` 開過防火牆規則（例如 8080 port），現在也可以去 Google Cloud 主控台把那條規則刪掉，因為機器人裡面內建的網頁伺服器已經拿掉了。

### 5. 先不要重啟機器人，跑遷移腳本

```bash
node scripts/migrate-to-multi-guild.js <你的guild_id>
```

會依序印出每個資料表的處理結果，最後看到「🎉 遷移完成！」代表成功。這支腳本可以放心重複執行，每一步都會先檢查有沒有做過，不會造成資料重複或遺失。

### 6. 這時候才重啟機器人

```bash
pm2 restart booking-bot
pm2 logs booking-bot --lines 30
```

確認只有一行「已登入」，沒有任何 `SyntaxError` 或崩潰重啟的跡象。

### 7. 完整驗證正式群功能正常，這步不要省

- 去討論串測試留言預約（確認 ✅ 反應、班表更新正常）
- 去管理頻道測試「查詢本週鎖定」「功能查詢」這種唯讀指令，確認能正常回覆
- 如果方便，找一個影響小的時段測試「鎖定」再「解除鎖定」，確認整套流程沒問題

全部正常運作，才進行下一步（加入第二個語音群）。

### 8. 清理 `.env`（選填，第 7 步驗證都沒問題後才做）

```bash
nano .env
```
刪掉 `BOOKING_PARENT_CHANNEL_ID`、`ADMIN_CHANNEL_ID`、`MANAGEMENT_CHANNEL_ID`、`ANNOUNCEMENT_CHANNEL_ID` 這四行，只留 `DISCORD_TOKEN`。這幾個設定之後都從資料庫讀取，`.env` 留著也不會被讀到，純粹是為了乾淨。

---

## 第二步：加入新的語音群

### 1. 把機器人邀請進新語音群

用之前 OAuth2 URL Generator 產生的邀請連結（同一個機器人帳號），邀請進第二個語音群。

### 2. 在新語音群建立對應頻道

預約區用的論壇頻道、管理頻道，其他（機器人紀錄、公告）選填。

### 3. 複製新語音群的 guild_id 跟各頻道 ID

跟第一步驟找 guild_id 的方式一樣（右鍵複製 ID）。

### 4. 登記語音群

```bash
cd ~/booking-bot
node scripts/add-guild.js <新語音群guild_id> \
  --booking <預約區頻道ID> \
  --admin <機器人紀錄頻道ID> \
  --management <管理頻道ID> \
  --announcement <公告頻道ID>
```

`--booking` 必填，其他三個選填。

### 5. 重啟機器人

```bash
pm2 restart booking-bot
```

重啟後，這個新語音群會在下一次 `ensureUpcomingThreads` 執行時（重啟當下就會跑一次）自動建立好未來 7 天的討論串，開始運作。不需要更新 `.env`、不需要改任何程式碼，也不會影響第一個語音群的運作。

---

## 移除一個語音群

目前沒有指令介面，直接下 SQL：

```bash
sqlite3 bookings.db "DELETE FROM guild_settings WHERE guild_id = '要移除的guild_id';"
```

移除後機器人不會再幫這個語音群開新討論串、不會再處理它的訊息，但**歷史資料不會被刪除**。

## 查詢目前登記了哪些語音群

```bash
sqlite3 bookings.db "SELECT guild_id, booking_parent_channel_id, admin_channel_id, management_channel_id, announcement_channel_id FROM guild_settings;"
```

## 架構重點

- `guild_settings` 表：每個語音群一列，存四個頻道 ID
- `bookings`、`daily_summary`、`summary_pages`、`blocked_slots`、`recurring_blocked_slots` 都有 `guild_id` 欄位，不同語音群的資料完全隔離
- 機器人收到訊息時，用 `message.guildId`（Discord 原生就有）查 `guild_settings`，決定要用哪個語音群的設定處理這則訊息；語音群沒登記過就直接忽略
- 每天的排程（開新討論串、鎖定過期討論串）會依序處理所有已登記的語音群
- 週期鎖定樣板（`recurring_blocked_slots`）也是每個語音群各自獨立，A 群設的規則不會套用到 B 群
- 「建立/刪除測試討論串」指令也是綁定發指令那個語音群，不會跨群互相影響
