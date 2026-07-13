# 出租迴響群 - 預約機器人 POC

## 這個 POC 做了什麼

1. 玩家在 Discord 打 `/預約`，跳出表單填「地點 / 時間 / 頻道 / 代約對象」
2. 送出後寫入 SQLite（狀態 `pending`），並在管理頻道推播一張確認卡片（✅/❌ 按鈕）
3. 管理員按下確認後，狀態改為 `confirmed`，機器人會自動重新渲染並編輯【預約統計】訊息
4. 所有預約都存在 `bookings.db`（SQLite 檔案），之後要做費用結算、歷史查詢都可以直接查這張表

## 安裝步驟

```bash
npm install
cp .env.example .env
```

編輯 `.env`，填入：
- `DISCORD_TOKEN`、`CLIENT_ID`：在 Discord Developer Portal 建立 Application 後取得
- `GUILD_ID`：你的測試伺服器 ID（開發者模式下右鍵伺服器圖示複製 ID）
- `ADMIN_CHANNEL_ID`：確認卡片要發到哪個頻道
- `SUMMARY_CHANNEL_ID`：【預約統計】訊息要發布/更新的頻道

機器人在 Developer Portal 的 **OAuth2 → URL Generator** 需要勾選 `bot` + `applications.commands` scope，
權限至少要有：`Send Messages`、`Embed Links`、`Read Message History`。

## 註冊 slash command

```bash
npm run deploy
```

## 啟動機器人

```bash
npm start
```

## 資料庫欄位（bookings.db → bookings 資料表）

| 欄位 | 說明 |
|---|---|
| booking_date | 依 Asia/Ho_Chi_Minh 時區的日期，YYYY-MM-DD |
| location / scheduled_time / channel | 對應地點/時間/頻道 |
| booker_id | 送出表單的 Discord user id |
| proxy_for | 代約對象（自由文字，若非代約則為 NULL） |
| status | pending / confirmed / rejected / completed |
| fee | 目前先留空，之後接費用結算時使用 |

## 目前 POC 還沒做，但架構已經預留的部分

- **費用結算**：`fee` 欄位已存在，之後可以加一個 `/結算` 指令依 `booking_date` 區間加總
- **提醒功能**：可以在 `confirmed` 當下額外排一個 timeout，時間到前提醒負責施法的人
- **代約對象改成真的 Discord 使用者選取**：目前 Modal 元件不支援 Select Menu，只能先用自由文字；
  如果要更嚴謹，可以在確認卡片階段用 Select Menu 讓管理員手動綁定使用者
- **多筆同時段/同地點衝突檢查**：目前沒有做防呆，同一時段同地點可以重複預約成功

## 已知限制

- 目前每天的【預約統計】訊息是「找不到舊訊息就重新發一則」，如果頻道歷史被清空、訊息被手動刪除，
  舊的 `daily_summary` 紀錄會失效但不影響新訊息產生
- 沒有做權限管控：目前任何人按 ✅/❌ 都可以確認/退回，正式版建議加上角色權限檢查
