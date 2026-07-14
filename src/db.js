import Database from "better-sqlite3";

const db = new Database("bookings.db");
db.pragma("journal_mode = WAL");

// 預約主表：每一筆預約對應到討論串裡的一則留言（message_id）
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    booking_date  TEXT NOT NULL,        -- YYYY-MM-DD（依 Asia/Ho_Chi_Minh 時區）
    message_id    TEXT UNIQUE,          -- 使用者留言的 Discord message id，用來追蹤編輯/刪除
    location      TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    channel       TEXT,                  -- 遊戲頻道，可能是「當日決定」或空字串
    booker_id     TEXT NOT NULL,         -- 留言者的 Discord user id
    proxy_for     TEXT,                  -- 若為代約，填代約對象（目前討論串格式尚未使用）
    status        TEXT NOT NULL DEFAULT 'confirmed',
    fee           INTEGER,               -- 之後結算費用用，先留空
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 記錄每天討論串 + 統計訊息(starter message)的 id，方便之後查找與編輯
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_summary (
    booking_date TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,  -- 討論串(thread) id
    message_id   TEXT NOT NULL,  -- 統計訊息(starter message) id
    locked       INTEGER NOT NULL DEFAULT 0  -- 是否已被自動鎖定/封存
  )
`);

export function insertBooking({ guildId, bookingDate, messageId, location, time, channel, bookerId, proxyFor }) {
  const stmt = db.prepare(`
    INSERT INTO bookings (guild_id, booking_date, message_id, location, scheduled_time, channel, booker_id, proxy_for)
    VALUES (@guildId, @bookingDate, @messageId, @location, @time, @channel, @bookerId, @proxyFor)
  `);
  const result = stmt.run({
    guildId,
    bookingDate,
    messageId,
    location,
    time,
    channel,
    bookerId,
    proxyFor: proxyFor || null,
  });
  return result.lastInsertRowid;
}

export function getBookingByMessageId(messageId) {
  return db.prepare(`SELECT * FROM bookings WHERE message_id = ?`).get(messageId);
}

export function updateBookingFromMessage(messageId, { location, time, channel, proxyFor }) {
  db.prepare(`
    UPDATE bookings SET location = ?, scheduled_time = ?, channel = ?, proxy_for = ?
    WHERE message_id = ?
  `).run(location, time, channel, proxyFor || null, messageId);
}

export function deleteBookingByMessageId(messageId) {
  db.prepare(`DELETE FROM bookings WHERE message_id = ?`).run(messageId);
}

// 同一天、同一地點的所有已確認預約（用於衝突比對）
export function getBookingsByDateLocation(bookingDate, location) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE booking_date = ? AND location = ? AND status = 'confirmed'
  `).all(bookingDate, location);
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

export function getSummaryByThreadId(threadId) {
  return db.prepare(`SELECT * FROM daily_summary WHERE channel_id = ?`).get(threadId);
}

export function setSummaryMessage(bookingDate, channelId, messageId) {
  db.prepare(`
    INSERT INTO daily_summary (booking_date, channel_id, message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(booking_date) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
  `).run(bookingDate, channelId, messageId);
}

// 日期已過去、但還沒被鎖定的討論串（供每日排程鎖定用）
export function getUnlockedPastSummaries(todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary
    WHERE booking_date < ? AND locked = 0
  `).all(todayStr);
}

export function markSummaryLocked(bookingDate) {
  db.prepare(`UPDATE daily_summary SET locked = 1 WHERE booking_date = ?`).run(bookingDate);
}

export default db;