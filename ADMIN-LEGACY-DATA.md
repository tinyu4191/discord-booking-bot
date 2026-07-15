# 舊資料人工修改/刪除流程

適用對象：透過 `scripts/migrate-legacy-days.js` 直接寫進資料庫的舊資料（07/14 ~ 07/19 這批過渡期資料）。
這批資料**沒有對應到真實的 Discord 留言**，所以使用者沒辦法自己編輯/刪除留言來修改，需要管理員用這份流程手動處理。

一般透過討論串留言正常登記的預約，不需要用這份文件——請使用者自己編輯/刪除留言就好，機器人會自動同步。

## 前置需求

VM 上要有 `sqlite3` 指令：

```bash
sudo apt update
sudo apt install -y sqlite3
```

如果不想裝，也可以改用 node 查詢，見文末〈備用查詢方式〉。

## 1. 先查出要改的那筆 id

```bash
cd ~/booking-bot
sqlite3 bookings.db "SELECT id, location, scheduled_time, channel, booker_id, proxy_for FROM bookings WHERE booking_date='2026-07-14' ORDER BY scheduled_time;"
```

把 `2026-07-14` 換成你要查的日期。輸出的每一行最前面的數字就是 `id`。

## 2. 改頻道（最常見的需求）

```bash
node scripts/admin-manage-booking.js edit 5 --channel 115
```

## 3. 改時間、地點、代約也都可以

```bash
node scripts/admin-manage-booking.js edit 5 --time 21:10 --channel 115 --proxy rhhhhh
```

只需要給你想改的欄位，沒給的維持原值。

## 4. 取消/刪除

```bash
node scripts/admin-manage-booking.js delete 5
```

每次操作完，腳本都會自動連線 Discord、更新那天討論串裡的統計 embed，不需要再手動做任何事。

## 注意事項

- 這支工具是「管理員直接改資料庫」，**不會幫你檢查時間衝突**（因為是人工判斷、你自己看得到全貌，系統不用在這插手）
- 確認使用者的需求沒問題後再執行，操作是直接生效的，沒有二次確認
- 等這批舊資料的日期都過去（討論串自動鎖定）、或使用者都陸續處理完，這份文件用到的機會就會越來越少

## 備用查詢方式（沒裝 sqlite3 時）

```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('bookings.db');
const rows = db.prepare(\"SELECT id, location, scheduled_time, channel, booker_id, proxy_for FROM bookings WHERE booking_date='2026-07-14' ORDER BY scheduled_time\").all();
console.table(rows);
"
```
