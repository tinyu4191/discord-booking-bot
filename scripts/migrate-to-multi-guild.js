// 一次性遷移腳本：把現有單一語音群的資料庫，轉成多語音群架構
// 用法：node scripts/migrate-to-multi-guild.js <你現有語音群的guild_id>
//
// 這支腳本：
// 1. 建立 guild_settings 表，把目前 .env 裡的四個頻道 ID 寫進去（記得先確認 .env 還留著這幾個值再跑）
// 2. daily_summary / summary_pages 加上 guild_id 欄位並重建成複合主鍵
// 3. blocked_slots / recurring_blocked_slots 加上 guild_id 欄位
// 4. bookings 補齊 guild_id（理論上一直都有記錄，這裡是保險）
//
// 可以放心重複執行：每個步驟都會先檢查欄位/資料是否已經存在，不會重複處理或造成資料遺失

import "dotenv/config";
import Database from "better-sqlite3";

const guildId = process.argv[2];
if (!guildId) {
  console.error("用法：node scripts/migrate-to-multi-guild.js <你現有語音群的guild_id>");
  console.error("（在 Discord 裡對伺服器圖示按右鍵「複製伺服器 ID」取得）");
  process.exit(1);
}

const db = new Database("bookings.db");
db.pragma("journal_mode = WAL");

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

const migrate = db.transaction(() => {
  // 1. guild_settings：把現有 .env 頻道設定寫進去
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id                   TEXT PRIMARY KEY,
      booking_parent_channel_id  TEXT NOT NULL,
      admin_channel_id           TEXT,
      management_channel_id      TEXT,
      announcement_channel_id    TEXT,
      created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  if (!process.env.BOOKING_PARENT_CHANNEL_ID) {
    throw new Error("找不到 .env 裡的 BOOKING_PARENT_CHANNEL_ID，請確認 .env 還留著舊設定再跑這支腳本。");
  }

  db.prepare(`
    INSERT INTO guild_settings (guild_id, booking_parent_channel_id, admin_channel_id, management_channel_id, announcement_channel_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      booking_parent_channel_id = excluded.booking_parent_channel_id,
      admin_channel_id = excluded.admin_channel_id,
      management_channel_id = excluded.management_channel_id,
      announcement_channel_id = excluded.announcement_channel_id
  `).run(
    guildId,
    process.env.BOOKING_PARENT_CHANNEL_ID,
    process.env.ADMIN_CHANNEL_ID || null,
    process.env.MANAGEMENT_CHANNEL_ID || null,
    process.env.ANNOUNCEMENT_CHANNEL_ID || null
  );
  console.log(`✅ guild_settings 已寫入（guild_id=${guildId}）`);

  // 2. daily_summary 重建，加上 guild_id 並改成複合主鍵
  if (!hasColumn("daily_summary", "guild_id")) {
    db.exec(`ALTER TABLE daily_summary RENAME TO daily_summary_old`);
    db.exec(`
      CREATE TABLE daily_summary (
        guild_id     TEXT NOT NULL,
        booking_date TEXT NOT NULL,
        channel_id   TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        locked       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, booking_date)
      )
    `);
    db.prepare(`
      INSERT INTO daily_summary (guild_id, booking_date, channel_id, message_id, locked)
      SELECT ?, booking_date, channel_id, message_id, locked FROM daily_summary_old
    `).run(guildId);
    db.exec(`DROP TABLE daily_summary_old`);
    console.log("✅ daily_summary 已加上 guild_id 並重建為複合主鍵");
  } else {
    console.log("⏭️  daily_summary 已經有 guild_id 欄位，跳過");
  }

  // 3. summary_pages 重建，加上 guild_id 並改成複合主鍵
  if (!hasColumn("summary_pages", "guild_id")) {
    db.exec(`ALTER TABLE summary_pages RENAME TO summary_pages_old`);
    db.exec(`
      CREATE TABLE summary_pages (
        guild_id     TEXT NOT NULL,
        booking_date TEXT NOT NULL,
        page_index   INTEGER NOT NULL,
        message_id   TEXT NOT NULL,
        PRIMARY KEY (guild_id, booking_date, page_index)
      )
    `);
    db.prepare(`
      INSERT INTO summary_pages (guild_id, booking_date, page_index, message_id)
      SELECT ?, booking_date, page_index, message_id FROM summary_pages_old
    `).run(guildId);
    db.exec(`DROP TABLE summary_pages_old`);
    console.log("✅ summary_pages 已加上 guild_id 並重建為複合主鍵");
  } else {
    console.log("⏭️  summary_pages 已經有 guild_id 欄位，跳過");
  }

  // 4. blocked_slots 補上 guild_id 欄位
  if (!hasColumn("blocked_slots", "guild_id")) {
    db.exec(`ALTER TABLE blocked_slots ADD COLUMN guild_id TEXT`);
    db.prepare(`UPDATE blocked_slots SET guild_id = ? WHERE guild_id IS NULL`).run(guildId);
    console.log("✅ blocked_slots 已加上 guild_id");
  } else {
    console.log("⏭️  blocked_slots 已經有 guild_id 欄位，跳過");
  }

  // 5. recurring_blocked_slots 補上 guild_id 欄位
  if (!hasColumn("recurring_blocked_slots", "guild_id")) {
    db.exec(`ALTER TABLE recurring_blocked_slots ADD COLUMN guild_id TEXT`);
    db.prepare(`UPDATE recurring_blocked_slots SET guild_id = ? WHERE guild_id IS NULL`).run(guildId);
    console.log("✅ recurring_blocked_slots 已加上 guild_id");
  } else {
    console.log("⏭️  recurring_blocked_slots 已經有 guild_id 欄位，跳過");
  }

  // 6. bookings 補齊舊資料的 guild_id（保險，理論上一直都有記錄）
  const updated = db.prepare(`UPDATE bookings SET guild_id = ? WHERE guild_id IS NULL OR guild_id = ''`).run(guildId);
  console.log(`✅ bookings 補齊 guild_id（受影響 ${updated.changes} 筆，通常應該是 0）`);
});

migrate();
console.log("\n🎉 遷移完成！之後可以把 .env 裡的四個頻道 ID 拿掉了（改存在資料庫的 guild_settings 裡）。");
db.close();
