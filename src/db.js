import Database from "better-sqlite3";

const db = new Database("bookings.db");
db.pragma("journal_mode = WAL");

// 預約主表
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    booking_date  TEXT NOT NULL,        -- YYYY-MM-DD（依 Asia/Ho_Chi_Minh 時區）
    location      TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    channel       TEXT,                  -- 遊戲頻道，可能是「當日決定」
    booker_id     TEXT NOT NULL,         -- 送出表單的 Discord user id
    proxy_for     TEXT,                  -- 若為代約，填代約對象（自由文字/@提及）
    status        TEXT NOT NULL DEFAULT 'pending', -- pending / confirmed / rejected / completed
    fee           INTEGER,               -- 之後結算費用用，先留空
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 記錄每天【預約統計】訊息的 message id，方便之後編輯
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_summary (
    booking_date TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    message_id   TEXT NOT NULL
  )
`);

export function insertBooking({ guildId, bookingDate, location, time, channel, bookerId, proxyFor }) {
  const stmt = db.prepare(`
    INSERT INTO bookings (guild_id, booking_date, location, scheduled_time, channel, booker_id, proxy_for)
    VALUES (@guildId, @bookingDate, @location, @time, @channel, @bookerId, @proxyFor)
  `);
  const result = stmt.run({ guildId, bookingDate, location, time, channel, bookerId, proxyFor: proxyFor || null });
  return result.lastInsertRowid;
}

export function getBooking(id) {
  return db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
}

export function updateBookingStatus(id, status) {
  db.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).run(status, id);
}

export function getConfirmedBookingsByDate(bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE booking_date = ? AND status = 'confirmed'
    ORDER BY scheduled_time ASC, id ASC
  `).all(bookingDate);
}

export function getSummaryMessage(bookingDate) {
  return db.prepare(`SELECT * FROM daily_summary WHERE booking_date = ?`).get(bookingDate);
}

export function setSummaryMessage(bookingDate, channelId, messageId) {
  db.prepare(`
    INSERT INTO daily_summary (booking_date, channel_id, message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(booking_date) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
  `).run(bookingDate, channelId, messageId);
}

export default db;
