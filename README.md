# 出租迴響群 - 預約機器人 POC（討論串自動化版）

## 這個版本做了什麼

1. 機器人每天固定時間（凌晨 00:05，Asia/Ho_Chi_Minh 時區）自動檢查，確保「今天 ~ 未來 7 天」都各自有一個討論串
   （討論串開在你設定的 `BOOKING_PARENT_CHANNEL_ID` 頻道底下，標題格式：`【07/14 (一) 預約討論串】`）
2. 討論串建立後，機器人立刻附上對應星期的圖片，並發第一則【日期 預約統計】訊息（含格式教學）並置頂
3. 同一時間，機器人會把「日期已經過去、還沒鎖定」的舊討論串設為鎖定 + 封存（**不會刪除**，資料還在，只是不能再留言）
4. 使用者直接在對應日期的討論串留言預約，格式：
   ```
   地點：龍王
   時間：21:30
   頻道：當日決定
   代約：(如有代約請填寫遊戲ID)
   ```
   （代約欄位可留空，非必填）
5. 機器人監聽留言，自動解析、檢查衝突（同日期+同地點，時間差 ≤10 分鐘視為衝突）：
   - 成功 → 在留言按 ✅，並自動更新第一則統計訊息
   - 格式錯誤或衝突 → 在留言按 ❌，並回覆說明，不會被記入統計
6. **修改預約**：直接編輯自己原本那則留言即可（例如後來確定了頻道），機器人會自動偵測並同步更新統計
7. **取消預約**：直接刪除自己那則留言即可，機器人會自動把這筆從統計中移除
8. 開討論串、鎖定討論串、新預約/更新這些動作，都會額外推播一則紀錄到 `ADMIN_CHANNEL_ID`（跟玩家看到的討論串頻道完全分開）
9. 所有預約都存在 `bookings.db`（SQLite 檔案），之後要做費用結算、歷史查詢都可以直接查這張表

## 星期圖片設定（必須）

在專案根目錄建立 `assets/weekday/` 資料夾，放入 7 張圖片，檔名固定為：

```
assets/weekday/
├── sun.png   （星期日）
├── mon.png   （星期一）
├── tue.png   （星期二）
├── wed.png   （星期三）
├── thu.png   （星期四）
├── fri.png   （星期五）
└── sat.png   （星期六）
```

如果你的圖檔是 `.jpg` 或其他格式，跟我說一聲，我把程式碼裡的副檔名對應改掉即可。

如果某天對應的圖片檔案不存在，機器人會在終端機印出警告訊息，但不會中斷，討論串照樣會建立，只是沒有附圖。

## 安裝步驟

```bash
npm install
cp .env.example .env
```

編輯 `.env`，填入：
- `DISCORD_TOKEN`：在 Discord Developer Portal 建立 Application 後，於 **Bot** 頁面取得
- `BOOKING_PARENT_CHANNEL_ID`：你要放置每日討論串的「預約區」頻道 ID
- `ADMIN_CHANNEL_ID`（選填）：新預約要留紀錄用的頻道 ID，不需要可以留空

## 重要：需要開啟 Message Content Intent

因為機器人現在要讀取使用者留言的文字內容做解析，必須手動開啟一個特殊權限：

1. 前往 https://discord.com/developers/applications → 你的 Application → **Bot**
2. 找到 **Privileged Gateway Intents** 區塊
3. 打開 **MESSAGE CONTENT INTENT** 開關
4. 存檔

沒開這個的話，機器人收得到訊息事件，但 `message.content` 會是空字串，永遠解析失敗。

## 機器人需要的權限

邀請機器人時（OAuth2 → URL Generator → Scopes 勾 `bot`），Bot Permissions 至少要勾：
- `Send Messages`
- `Send Messages in Threads`
- `Create Public Threads`
- `Manage Threads`
- `Manage Messages`（置頂統計訊息需要）
- `Read Message History`
- `Add Reactions`（在留言按 ✅ / ❌ 需要）

## 啟動機器人

```bash
npm start
```

第一次啟動時，機器人會立刻檢查並補齊「今天 ~ 未來 7 天」的討論串（如果 `BOOKING_PARENT_CHANNEL_ID` 底下還沒有任何討論串，這時候會一次建立 7 個）。

## 資料庫欄位（bookings.db → bookings 資料表）

| 欄位 | 說明 |
|---|---|
| booking_date | 依 Asia/Ho_Chi_Minh 時區的日期，YYYY-MM-DD |
| message_id | 使用者留言的 Discord message id，用來追蹤編輯/刪除 |
| location / scheduled_time / channel | 對應地點/時間/頻道 |
| booker_id | 留言者的 Discord user id |
| proxy_for | 代約對象，目前討論串固定格式尚未使用這欄位（保留給之後擴充） |
| status | 目前一律是 confirmed（衝突就直接拒絕，不會進資料庫） |
| fee | 目前先留空，之後接費用結算時使用 |

## 目前 POC 還沒做，但架構已經預留的部分

- **費用結算**：`fee` 欄位已存在，之後可以加一個指令依 `booking_date` 區間加總
- **代約對象**：資料庫欄位有保留，但討論串固定格式還沒加這行，需要的話可以加一行 `代約：@某人`
- **提醒功能**：時間到前提醒負責施法的人

## 已知限制

- 衝突檢查只比對「同日期 + 同地點」，不同地點即使時間重疊也不會擋
- 使用者編輯留言若改動後仍與別人衝突，機器人只會回覆說明並保留舊資料，不會自動幫忙改內容
- 討論串鎖定是每天固定時間批次處理，不是「日期一到就馬上鎖」，最多會晚幾分鐘到隔天排程跑的時候才鎖上
- `daily_summary` 資料表新增了 `locked` 欄位，如果你先前測試過舊版，**建議直接刪除舊的 `bookings.db` 檔案重新開始**，避免欄位缺漏造成錯誤