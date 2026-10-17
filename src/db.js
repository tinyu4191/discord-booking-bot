import Database from "better-sqlite3";

const db = new Database("bookings.db");
db.pragma("journal_mode = WAL");

// 每個語音群各自的頻道設定（取代原本寫死在 .env 的四個頻道 ID）
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id                   TEXT PRIMARY KEY,
    booking_parent_channel_id  TEXT NOT NULL,  -- 預約區，機器人在這裡開每日討論串
    admin_channel_id           TEXT,           -- 選填，機器人紀錄用
    management_channel_id      TEXT,           -- 管理員下鎖定指令的頻道
    announcement_channel_id    TEXT,           -- 選填，@everyone 公告頻道
    reminder_channel_id        TEXT,           -- 選填，管理者專用的預約提醒頻道（沒設定就不啟用提醒）
    created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 舊資料庫的 guild_settings 沒有 reminder_channel_id 欄位，啟動時自動補上（已經有就略過）
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("guild_settings", "reminder_channel_id", "reminder_channel_id TEXT");
// 每日日報：report_channel_id 沒設定就不發；report_enabled 是管理頻道「取消訂閱／訂閱報告」切換的開關（預設訂閱中）
ensureColumn("guild_settings", "report_channel_id", "report_channel_id TEXT");
ensureColumn("guild_settings", "report_enabled", "report_enabled INTEGER NOT NULL DEFAULT 1");

// 日報發送紀錄：每個語音群每一天最多一筆，避免重複發送。status = sent（已發）／skipped（當時取消訂閱，不補發）
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_reports (
    guild_id     TEXT NOT NULL,
    report_date  TEXT NOT NULL,
    status       TEXT NOT NULL,
    message_id   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, report_date)
  )
`);

// 預約主表：每一筆預約對應到討論串裡的一則留言（message_id），guild_id 區分是哪個語音群的資料
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    booking_date  TEXT NOT NULL,        -- YYYY-MM-DD（依 BOT_TIMEZONE（預設 Asia/Taipei）時區）
    message_id    TEXT UNIQUE,          -- 使用者留言的 Discord message id，用來追蹤編輯/刪除
    location      TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    channel       TEXT,                  -- 遊戲頻道，可能是「當日決定」或空字串
    booker_id     TEXT NOT NULL,         -- 留言者的 Discord user id
    proxy_for     TEXT,                  -- 若為代約，填代約對象
    status        TEXT NOT NULL DEFAULT 'confirmed',
    fee           INTEGER,               -- 之後結算費用用，先留空
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 記錄每個語音群、每天討論串 + 統計訊息(starter message，第 0 頁) 的 id
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_summary (
    guild_id     TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    channel_id   TEXT NOT NULL,  -- 討論串(thread) id
    message_id   TEXT NOT NULL,  -- 統計訊息(starter message，第 0 頁) id
    locked       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, booking_date)
  )
`);

// 當某天預約筆數多到讓班表 embed 超過長度上限時，多出來的部分會拆到額外分頁訊息
db.exec(`
  CREATE TABLE IF NOT EXISTS summary_pages (
    guild_id     TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    page_index   INTEGER NOT NULL,
    message_id   TEXT NOT NULL,
    PRIMARY KEY (guild_id, booking_date, page_index)
  )
`);

// 班表改成「單一訊息 + 翻頁」之後，這則訊息目前停在第幾頁、最後一次有人操作是什麼時候，要記在資料庫
// （重啟後才不會忘）。layout_version：0 = 還是舊版版面（可能還有多餘的分頁訊息），1 = 已換成新版面
ensureColumn("daily_summary", "current_page", "current_page INTEGER NOT NULL DEFAULT 0");
ensureColumn("daily_summary", "last_touch", "last_touch INTEGER NOT NULL DEFAULT 0"); // 毫秒時間戳，0 = 從來沒人操作過
ensureColumn("daily_summary", "layout_version", "layout_version INTEGER NOT NULL DEFAULT 0");
// 引導訊息的版本：0 = 舊文案，1 = 有「請直接編輯留言，不要刪除重打」的新文案（啟動時會把還沒過期的舊文案更新掉）
ensureColumn("daily_summary", "guide_version", "guide_version INTEGER NOT NULL DEFAULT 0");

// 記錄「某語音群、某天某時段不開放預約」的設定
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id            TEXT NOT NULL,
    booking_date        TEXT NOT NULL,
    start_time          TEXT NOT NULL,  -- HH:MM
    end_time            TEXT NOT NULL,  -- HH:MM
    reason              TEXT,
    source_recurring_id INTEGER,        -- 由哪條週期鎖定樣板自動產生，手動建立的是 NULL
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 週期鎖定「樣板」：每個語音群各自的每週固定星期幾時段設定，互不影響
db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_blocked_slots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    weekday    INTEGER NOT NULL,  -- 0=週日 ... 6=週六
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 限定地點時段：某天某時段「只接受指定地點」的預約（locations 是 JSON 陣列，內容是 location-rules.js 的 key）
db.exec(`
  CREATE TABLE IF NOT EXISTS location_windows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    start_time   TEXT NOT NULL,  -- HH:MM
    end_time     TEXT NOT NULL,  -- HH:MM
    locations    TEXT NOT NULL,  -- JSON，例如 ["dragon","tree"]
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 休假：start_date ~ end_date（含頭尾）整天不開放預約
db.exec(`
  CREATE TABLE IF NOT EXISTS vacations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    start_date TEXT NOT NULL,  -- YYYY-MM-DD
    end_date   TEXT NOT NULL,  -- YYYY-MM-DD（含這一天）
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 預約提醒：預約開始前幾分鐘，在提醒頻道發一則帶「續約／不續約」按鈕的訊息。
// 一筆提醒 = 某筆預約在某個日期＋時間的那一次提醒（預約被改時間後，會算成新的一筆提醒）
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_reminders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    booking_id    INTEGER NOT NULL,
    booking_date  TEXT NOT NULL,      -- 被提醒的那筆預約的日期（提醒當下的值）
    booking_time  TEXT NOT NULL,      -- 被提醒的那筆預約的時間（提醒當下的值）
    renew_date    TEXT,               -- 預檢算出的續約日期（跨午夜會是隔天）
    renew_time    TEXT,               -- 預檢算出的續約時間（原時間 +50 分鐘）
    can_renew     INTEGER NOT NULL DEFAULT 1,  -- 預檢結果：1=沒衝突有按鈕、0=有衝突不給按鈕
    base_content  TEXT NOT NULL,      -- 提醒訊息的固定部分（標題＋預約內容），之後改訊息時重用
    precheck_note TEXT,               -- 預檢發現的衝突原因
    result_note   TEXT,               -- 續約失敗原因／過期原因（預約被改、取消等）
    channel_id    TEXT,               -- 提醒訊息所在頻道
    message_id    TEXT,               -- 提醒訊息 id
    status        TEXT NOT NULL DEFAULT 'pending',
      -- pending=待處理(有按鈕) / no_renew=預檢有衝突(沒按鈕) / processing=處理中
      -- renewed=已續約 / declined=不續約 / failed=續約失敗 / expired=過期
    handled_by    TEXT,               -- 按按鈕的人
    new_booking_id INTEGER,           -- 續約新增的預約 id
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    handled_at    TEXT,
    UNIQUE (booking_id, booking_date, booking_time)
  )
`);
// 已處理（續約／不續約／失敗）的提醒，過了預約開始時間後會整則劃線，劃過就標記 1，不重複處理
ensureColumn("booking_reminders", "finalized", "finalized INTEGER NOT NULL DEFAULT 0");

// ---- 語音群設定 ----

export function upsertGuildSettings(
  guildId,
  { bookingParentChannelId, adminChannelId, managementChannelId, announcementChannelId, reminderChannelId, reportChannelId }
) {
  db.prepare(`
    INSERT INTO guild_settings (guild_id, booking_parent_channel_id, admin_channel_id, management_channel_id, announcement_channel_id, reminder_channel_id, report_channel_id)
    VALUES (@guildId, @bookingParentChannelId, @adminChannelId, @managementChannelId, @announcementChannelId, @reminderChannelId, @reportChannelId)
    ON CONFLICT(guild_id) DO UPDATE SET
      booking_parent_channel_id = excluded.booking_parent_channel_id,
      admin_channel_id = excluded.admin_channel_id,
      management_channel_id = excluded.management_channel_id,
      announcement_channel_id = excluded.announcement_channel_id,
      reminder_channel_id = excluded.reminder_channel_id,
      report_channel_id = excluded.report_channel_id
  `).run({
    guildId,
    bookingParentChannelId,
    adminChannelId: adminChannelId || null,
    managementChannelId: managementChannelId || null,
    announcementChannelId: announcementChannelId || null,
    reminderChannelId: reminderChannelId || null,
    reportChannelId: reportChannelId || null,
  });
}

export function getGuildSettings(guildId) {
  return db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`).get(guildId);
}

export function getAllGuildSettings() {
  return db.prepare(`SELECT * FROM guild_settings`).all();
}

// ---- 每日日報 ----

export function setReportEnabled(guildId, enabled) {
  db.prepare(`UPDATE guild_settings SET report_enabled = ? WHERE guild_id = ?`).run(enabled ? 1 : 0, guildId);
}

// 已鎖定、日期落在 [fromDate, toDate] 的班表（日期由舊到新）。日報只會針對「討論串真的存在而且已鎖定」的日子發
export function getLockedSummariesBetween(guildId, fromDate, toDate) {
  return db.prepare(`
    SELECT * FROM daily_summary
    WHERE guild_id = ? AND locked = 1 AND booking_date >= ? AND booking_date <= ?
    ORDER BY booking_date ASC
  `).all(guildId, fromDate, toDate);
}

export function getDailyReportRecord(guildId, reportDate) {
  return db.prepare(`SELECT * FROM daily_reports WHERE guild_id = ? AND report_date = ?`).get(guildId, reportDate);
}

export function recordDailyReport(guildId, reportDate, status, messageId = null) {
  db.prepare(`
    INSERT OR IGNORE INTO daily_reports (guild_id, report_date, status, message_id) VALUES (?, ?, ?, ?)
  `).run(guildId, reportDate, status, messageId);
}

export function deleteGuildSettings(guildId) {
  db.prepare(`DELETE FROM guild_settings WHERE guild_id = ?`).run(guildId);
}

// 週期鎖定可以一條規則涵蓋多個星期（例如「每天」）：weekday_mask 是 7 個位元（bit0=週日 ... bit6=週六），
// NULL 代表舊資料，等同只有 weekday 那一天。單日手動改過的鎖定（detached = 1）之後修改週期規則時不會被覆蓋；
// 單日被解除的週期鎖定要記在例外表，之後修改規則時才不會又被「復活」
ensureColumn("recurring_blocked_slots", "weekday_mask", "weekday_mask INTEGER");
ensureColumn("blocked_slots", "detached", "detached INTEGER NOT NULL DEFAULT 0");
db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_exceptions (
    rule_id      INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    PRIMARY KEY (rule_id, booking_date)
  )
`);

// ---- 預約 ----

export function insertBooking({ guildId, bookingDate, messageId, location, time, channel, bookerId, proxyFor }) {
  const stmt = db.prepare(`
    INSERT INTO bookings (guild_id, booking_date, message_id, location, scheduled_time, channel, booker_id, proxy_for)
    VALUES (@guildId, @bookingDate, @messageId, @location, @time, @channel, @bookerId, @proxyFor)
  `);
  const result = stmt.run({
    guildId, bookingDate, messageId, location, time, channel, bookerId, proxyFor: proxyFor || null,
  });
  return result.lastInsertRowid;
}

export function getBookingByMessageId(messageId) {
  return db.prepare(`SELECT * FROM bookings WHERE message_id = ?`).get(messageId);
}

export function getBookingById(id) {
  return db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
}

export function updateBookingById(id, { location, time, channel, proxyFor }) {
  db.prepare(`
    UPDATE bookings SET location = ?, scheduled_time = ?, channel = ?, proxy_for = ?
    WHERE id = ?
  `).run(location, time, channel, proxyFor || null, id);
}

export function deleteBookingById(id) {
  db.prepare(`DELETE FROM bookings WHERE id = ?`).run(id);
}

export function cancelBookingById(id) {
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(id);
}

export function restoreBookingById(id) {
  db.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ?`).run(id);
}

export function getCancelledBookingsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE guild_id = ? AND booking_date = ? AND status = 'cancelled'
    ORDER BY scheduled_time ASC, id ASC
  `).all(guildId, bookingDate);
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

export function getBookingsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE guild_id = ? AND booking_date = ? AND status = 'confirmed'
  `).all(guildId, bookingDate);
}

export function getConfirmedBookingsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE guild_id = ? AND booking_date = ? AND status = 'confirmed'
    ORDER BY scheduled_time ASC, id ASC
  `).all(guildId, bookingDate);
}

export function getSummaryMessage(guildId, bookingDate) {
  return db.prepare(`SELECT * FROM daily_summary WHERE guild_id = ? AND booking_date = ?`).get(guildId, bookingDate);
}

// thread id 在整個 Discord 是全域唯一的，不需要另外帶 guildId 也能查到正確的一筆
export function getSummaryByThreadId(threadId) {
  return db.prepare(`SELECT * FROM daily_summary WHERE channel_id = ?`).get(threadId);
}

export function setSummaryMessage(guildId, bookingDate, channelId, messageId) {
  db.prepare(`
    INSERT INTO daily_summary (guild_id, booking_date, channel_id, message_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, booking_date) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
  `).run(guildId, bookingDate, channelId, messageId);
}

export function getUnlockedPastSummaries(guildId, todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary
    WHERE guild_id = ? AND booking_date < ? AND locked = 0
  `).all(guildId, todayStr);
}

export function markSummaryLocked(guildId, bookingDate) {
  db.prepare(`UPDATE daily_summary SET locked = 1 WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

// 記錄班表目前停在第幾頁。touchMs 有給的話，同時更新「最後操作時間」（有人翻頁、衝突時機器人切頁、閒置復位都算）
export function setSummaryView(guildId, bookingDate, page, touchMs = null) {
  if (touchMs === null) {
    db.prepare(`UPDATE daily_summary SET current_page = ? WHERE guild_id = ? AND booking_date = ?`).run(page, guildId, bookingDate);
  } else {
    db.prepare(`UPDATE daily_summary SET current_page = ?, last_touch = ? WHERE guild_id = ? AND booking_date = ?`)
      .run(page, touchMs, guildId, bookingDate);
  }
}

export function markSummaryLayout(guildId, bookingDate, version = 1) {
  db.prepare(`UPDATE daily_summary SET layout_version = ? WHERE guild_id = ? AND booking_date = ?`).run(version, guildId, bookingDate);
}

export function markGuideVersion(guildId, bookingDate, version = 1) {
  db.prepare(`UPDATE daily_summary SET guide_version = ? WHERE guild_id = ? AND booking_date = ?`).run(version, guildId, bookingDate);
}

// 還沒鎖定、日期是今天（含）以後、引導訊息還是舊文案的班表
export function getSummariesNeedingGuideUpdate(guildId, todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary WHERE guild_id = ? AND booking_date >= ? AND locked = 0 AND guide_version < 1 ORDER BY booking_date
  `).all(guildId, todayStr);
}

// 還沒鎖定、日期是今天（含）以後的班表：閒置復位要掃描的對象
export function getActiveSummaries(guildId, todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary WHERE guild_id = ? AND booking_date >= ? AND locked = 0 ORDER BY booking_date
  `).all(guildId, todayStr);
}

// 還沒鎖定、日期是今天（含）以後、而且還是舊版版面的班表：啟動時要遷移成新版面
export function getLegacyLayoutSummaries(guildId, todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary
    WHERE guild_id = ? AND booking_date >= ? AND locked = 0 AND layout_version = 0
    ORDER BY booking_date
  `).all(guildId, todayStr);
}

// 完全刪掉某個語音群、某個日期的討論串紀錄，只給測試討論串清理用
export function deleteSummaryMessage(guildId, bookingDate) {
  db.prepare(`DELETE FROM daily_summary WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

export function deleteAllSummaryPages(guildId, bookingDate) {
  db.prepare(`DELETE FROM summary_pages WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

export function deleteBookingsByDate(guildId, bookingDate) {
  db.prepare(`DELETE FROM bookings WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

// ---- 班表分頁訊息（page_index >= 1，page 0 記錄在 daily_summary） ----

export function getSummaryPages(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM summary_pages WHERE guild_id = ? AND booking_date = ? ORDER BY page_index
  `).all(guildId, bookingDate);
}

export function setSummaryPage(guildId, bookingDate, pageIndex, messageId) {
  db.prepare(`
    INSERT INTO summary_pages (guild_id, booking_date, page_index, message_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, booking_date, page_index) DO UPDATE SET message_id = excluded.message_id
  `).run(guildId, bookingDate, pageIndex, messageId);
}

export function deleteSummaryPage(guildId, bookingDate, pageIndex) {
  db.prepare(`DELETE FROM summary_pages WHERE guild_id = ? AND booking_date = ? AND page_index = ?`).run(guildId, bookingDate, pageIndex);
}

// ---- 鎖定時段（不開放預約）相關 ----

export function insertBlockedSlot({ guildId, bookingDate, startTime, endTime, reason, sourceRecurringId }) {
  const stmt = db.prepare(`
    INSERT INTO blocked_slots (guild_id, booking_date, start_time, end_time, reason, source_recurring_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(guildId, bookingDate, startTime, endTime, reason || null, sourceRecurringId || null);
  return result.lastInsertRowid;
}

export function getBlockedSlotsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? AND booking_date = ? ORDER BY start_time
  `).all(guildId, bookingDate);
}

// 查同一天、同時段有沒有已經存在的鎖定紀錄，用來避免週期鎖定重複產生同一筆
export function getBlockedSlotByDateTimeRange(guildId, bookingDate, startTime, endTime) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? AND booking_date = ? AND start_time = ? AND end_time = ?
  `).get(guildId, bookingDate, startTime, endTime);
}

// 查某條週期鎖定樣板，目前已經產生過哪些一次性鎖定（用於樣板刪除時一併清理）
export function getBlockedSlotsBySourceRecurringId(sourceRecurringId) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE source_recurring_id = ?
  `).all(sourceRecurringId);
}

// 查詢某語音群所有鎖定時段（不分日期），過期與否由呼叫端依「現在時間」判斷後過濾
export function getAllBlockedSlots(guildId) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? ORDER BY booking_date, start_time
  `).all(guildId);
}

export function getBlockedSlotById(id) {
  return db.prepare(`SELECT * FROM blocked_slots WHERE id = ?`).get(id);
}

export function deleteBlockedSlot(id) {
  db.prepare(`DELETE FROM blocked_slots WHERE id = ?`).run(id);
}

// ---- 預約提醒 ----

// 新增一筆提醒。同一筆預約、同一個日期時間已經提醒過就回傳 null（不重複提醒）
export function insertReminder({
  guildId, bookingId, bookingDate, bookingTime, renewDate, renewTime, canRenew, baseContent, precheckNote,
}) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO booking_reminders
      (guild_id, booking_id, booking_date, booking_time, renew_date, renew_time, can_renew, base_content, precheck_note, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, bookingId, bookingDate, bookingTime,
    renewDate || null, renewTime || null,
    canRenew ? 1 : 0, baseContent, precheckNote || null,
    canRenew ? "pending" : "no_renew"
  );
  return result.changes ? Number(result.lastInsertRowid) : null;
}

export function getReminderById(id) {
  return db.prepare(`SELECT * FROM booking_reminders WHERE id = ?`).get(id);
}

export function getReminderBySlot(bookingId, bookingDate, bookingTime) {
  return db.prepare(`
    SELECT * FROM booking_reminders WHERE booking_id = ? AND booking_date = ? AND booking_time = ?
  `).get(bookingId, bookingDate, bookingTime);
}

export function setReminderMessage(id, channelId, messageId) {
  db.prepare(`UPDATE booking_reminders SET channel_id = ?, message_id = ? WHERE id = ?`).run(channelId, messageId, id);
}

export function deleteReminder(id) {
  db.prepare(`DELETE FROM booking_reminders WHERE id = ?`).run(id);
}

// 還沒處理、之後可能需要過期劃線的提醒（有按鈕的 pending + 預檢有衝突沒按鈕的 no_renew）
export function getOpenReminders(guildId) {
  return db.prepare(`
    SELECT * FROM booking_reminders WHERE guild_id = ? AND status IN ('pending', 'no_renew') ORDER BY id
  `).all(guildId);
}

// 已經處理過（續約／不續約／失敗）、但還沒在過了開始時間後劃線的提醒
export function getHandledUnfinalizedReminders(guildId) {
  return db.prepare(`
    SELECT * FROM booking_reminders
    WHERE guild_id = ? AND status IN ('renewed', 'declined', 'failed') AND finalized = 0 AND message_id IS NOT NULL
    ORDER BY id
  `).all(guildId);
}

export function markReminderFinalized(id) {
  db.prepare(`UPDATE booking_reminders SET finalized = 1 WHERE id = ?`).run(id);
}

// 搶占處理權：只有 pending 才能被搶到，一次只會有一個人成功（避免兩位管理員同時按）
export function claimReminder(id) {
  const r = db.prepare(`UPDATE booking_reminders SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(id);
  return r.changes === 1;
}

// 搶到處理權之後如果沒辦法完成（例如 Discord 互動逾時），把它放回待處理，讓管理者可以重按
export function releaseReminder(id) {
  db.prepare(`UPDATE booking_reminders SET status = 'pending' WHERE id = ? AND status = 'processing'`).run(id);
}

export function finishReminder(id, status, { handledBy, newBookingId, note } = {}) {
  db.prepare(`
    UPDATE booking_reminders
    SET status = ?, handled_by = ?, new_booking_id = ?, result_note = ?, handled_at = datetime('now')
    WHERE id = ?
  `).run(status, handledBy || null, newBookingId || null, note || null, id);
}

// 把還沒處理的提醒標成過期；已經被處理過（或正在處理）的不會被動到，成功才回傳 true
export function expireReminder(id, note) {
  const r = db.prepare(`
    UPDATE booking_reminders
    SET status = 'expired', result_note = ?, handled_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'no_renew')
  `).run(note || null, id);
  return r.changes === 1;
}

// 清掉太舊且已經結案的提醒紀錄，避免資料表一直長大
export function purgeOldReminders(days) {
  db.prepare(`
    DELETE FROM booking_reminders
    WHERE created_at < datetime('now', ?) AND status NOT IN ('pending', 'no_renew', 'processing')
  `).run(`-${Number(days)} day`);
}

// ---- 週期鎖定樣板 ----

// 規則涵蓋的星期遮罩（舊資料沒有 weekday_mask，就是只有 weekday 那一天）
export function ruleWeekdayMask(rule) {
  return rule.weekday_mask ?? 1 << rule.weekday;
}

const lowestWeekday = (mask) => [0, 1, 2, 3, 4, 5, 6].find((d) => mask & (1 << d)) ?? 0;

// weekdayMask 沒給就用 weekday 那一天。weekday 欄位存遮罩裡最小的星期（舊指令的相容用）
export function insertRecurringBlockedSlot({ guildId, weekday, weekdayMask, startTime, endTime, reason }) {
  const mask = weekdayMask ?? 1 << weekday;
  const stmt = db.prepare(`
    INSERT INTO recurring_blocked_slots (guild_id, weekday, weekday_mask, start_time, end_time, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(guildId, weekdayMask === undefined ? weekday : lowestWeekday(mask), mask, startTime, endTime, reason || null);
  return result.lastInsertRowid;
}

export function updateRecurringBlockedSlot(id, { weekdayMask, startTime, endTime, reason }) {
  db.prepare(`
    UPDATE recurring_blocked_slots SET weekday = ?, weekday_mask = ?, start_time = ?, end_time = ?, reason = ? WHERE id = ?
  `).run(lowestWeekday(weekdayMask), weekdayMask, startTime, endTime, reason || null, id);
}

export function getRecurringBlockedSlotsByWeekday(guildId, weekday) {
  return db
    .prepare(`SELECT * FROM recurring_blocked_slots WHERE guild_id = ? ORDER BY start_time`)
    .all(guildId)
    .filter((r) => ruleWeekdayMask(r) & (1 << weekday));
}

// 修改單日鎖定。detached = 1 代表這一天是手動改過的（週期規則之後修改不再覆蓋它）
export function updateBlockedSlot(id, { startTime, endTime, reason, detached }) {
  db.prepare(`UPDATE blocked_slots SET start_time = ?, end_time = ?, reason = ?, detached = ? WHERE id = ?`).run(
    startTime, endTime, reason || null, detached ? 1 : 0, id
  );
}

// 從今天（含）起的鎖定，給指令的自動完成選單用
export function getUpcomingBlockedSlots(guildId, fromDate) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? AND booking_date >= ? ORDER BY booking_date, start_time
  `).all(guildId, fromDate);
}

export function addRecurringException(ruleId, bookingDate) {
  db.prepare(`INSERT OR IGNORE INTO recurring_exceptions (rule_id, booking_date) VALUES (?, ?)`).run(ruleId, bookingDate);
}

export function hasRecurringException(ruleId, bookingDate) {
  return !!db.prepare(`SELECT 1 FROM recurring_exceptions WHERE rule_id = ? AND booking_date = ?`).get(ruleId, bookingDate);
}

export function deleteRecurringExceptions(ruleId) {
  db.prepare(`DELETE FROM recurring_exceptions WHERE rule_id = ?`).run(ruleId);
}

export function getAllRecurringBlockedSlots(guildId) {
  return db.prepare(`
    SELECT * FROM recurring_blocked_slots WHERE guild_id = ? ORDER BY weekday, start_time
  `).all(guildId);
}

export function getRecurringBlockedSlotById(id) {
  return db.prepare(`SELECT * FROM recurring_blocked_slots WHERE id = ?`).get(id);
}

// 只刪樣板本身，不會動到已經產生出來的一次性鎖定（那些要清理由呼叫端另外處理）
export function deleteRecurringBlockedSlot(id) {
  db.prepare(`DELETE FROM recurring_blocked_slots WHERE id = ?`).run(id);
}

// ---- 限定地點時段 ----

export function insertLocationWindow({ guildId, bookingDate, startTime, endTime, locations, notes }) {
  return db
    .prepare(`INSERT INTO location_windows (guild_id, booking_date, start_time, end_time, locations, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(guildId, bookingDate, startTime, endTime, JSON.stringify(locations), notes || null).lastInsertRowid;
}

export function getLocationWindowsByDate(guildId, bookingDate) {
  return db.prepare(`SELECT * FROM location_windows WHERE guild_id = ? AND booking_date = ? ORDER BY start_time`).all(guildId, bookingDate);
}

export function getLocationWindowById(id) {
  return db.prepare(`SELECT * FROM location_windows WHERE id = ?`).get(id);
}

// 從某天（含）起的限定時段，給 list 跟自動完成選單用
export function getUpcomingLocationWindows(guildId, fromDate) {
  return db.prepare(`SELECT * FROM location_windows WHERE guild_id = ? AND booking_date >= ? ORDER BY booking_date, start_time`).all(guildId, fromDate);
}

export function updateLocationWindow(id, { startTime, endTime, locations, notes }) {
  db.prepare(`UPDATE location_windows SET start_time = ?, end_time = ?, locations = ?, notes = ? WHERE id = ?`).run(
    startTime, endTime, JSON.stringify(locations), notes || null, id
  );
}

export function deleteLocationWindow(id) {
  db.prepare(`DELETE FROM location_windows WHERE id = ?`).run(id);
}

// ---- 休假 ----

export function insertVacation({ guildId, startDate, endDate, reason }) {
  return db.prepare(`INSERT INTO vacations (guild_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)`).run(guildId, startDate, endDate, reason || null).lastInsertRowid;
}
export function getVacationById(id) {
  return db.prepare(`SELECT * FROM vacations WHERE id = ?`).get(id);
}
// 某一天是不是在休假期間（回傳那筆休假，沒有就 undefined）
export function getVacationForDate(guildId, date) {
  return db.prepare(`SELECT * FROM vacations WHERE guild_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date LIMIT 1`).get(guildId, date, date);
}
// 結束日還沒過（今天含以後）的休假
export function getUpcomingVacations(guildId, today) {
  return db.prepare(`SELECT * FROM vacations WHERE guild_id = ? AND end_date >= ? ORDER BY start_date`).all(guildId, today);
}
// 已經結束（結束日早於今天）、還沒發「恢復開放」公告的休假
export function getEndedVacations(guildId, today) {
  return db.prepare(`SELECT * FROM vacations WHERE guild_id = ? AND end_date < ? ORDER BY start_date`).all(guildId, today);
}
export function updateVacation(id, { endDate, reason }) {
  db.prepare(`UPDATE vacations SET end_date = ?, reason = ? WHERE id = ?`).run(endDate, reason || null, id);
}
export function deleteVacation(id) {
  db.prepare(`DELETE FROM vacations WHERE id = ?`).run(id);
}

export default db;
