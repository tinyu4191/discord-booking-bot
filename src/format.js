// 依你原本的格式渲染整份【預約統計】
// > 蝴蝶（女王藏身處） / 21:00 / 115　預約人: <@1462607027141611633>
// > 龍王 / 23:00 / 當日決定　預約人: <@861286139272757349> 代約
export function formatSummary(bookings) {
  const header = "【預約統計】";
  if (!bookings.length) {
    return `${header}\n目前尚無預約`;
  }
  const lines = bookings.map((b) => {
    const proxyTag = b.proxy_for ? " 代約" : "";
    return `> ${b.location} / ${b.scheduled_time} / ${b.channel || "當日決定"}　預約人: <@${b.booker_id}>${proxyTag}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

// 依 Asia/Ho_Chi_Minh 時區取得今天日期字串 YYYY-MM-DD
export function getBookingDateToday() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA 輸出格式剛好是 YYYY-MM-DD
}
