import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import {
  insertBooking,
  getBooking,
  updateBookingStatus,
  getConfirmedBookingsByDate,
  getSummaryMessage,
  setSummaryMessage,
} from "./db.js";
import { formatSummary, getBookingDateToday } from "./format.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`已登入：${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "預約") {
      await handleSlashCommand(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === "booking_modal") {
      await handleModalSubmit(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith("confirm_")) {
      await handleDecision(interaction, "confirmed");
    } else if (interaction.isButton() && interaction.customId.startsWith("reject_")) {
      await handleDecision(interaction, "rejected");
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "發生錯誤，請稍後再試或聯絡管理員。", ephemeral: true });
    }
  }
});

// 1. 跳出 Modal 表單
async function handleSlashCommand(interaction) {
  const modal = new ModalBuilder().setCustomId("booking_modal").setTitle("預約《出租迴響群》");

  const locationInput = new TextInputBuilder()
    .setCustomId("location")
    .setLabel("地點")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const timeInput = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("時間（例如 21:00）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const channelInput = new TextInputBuilder()
    .setCustomId("channel")
    .setLabel("頻道（不確定可留空，會顯示「當日決定」）")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const proxyInput = new TextInputBuilder()
    .setCustomId("proxy_for")
    .setLabel("代約對象（若非代約請留空）")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(locationInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(channelInput),
    new ActionRowBuilder().addComponents(proxyInput)
  );

  await interaction.showModal(modal);
}

// 2. 表單送出 -> 存 DB(pending) -> 推播確認卡片到管理頻道
async function handleModalSubmit(interaction) {
  const location = interaction.fields.getTextInputValue("location").trim();
  const time = interaction.fields.getTextInputValue("time").trim();
  const channel = interaction.fields.getTextInputValue("channel").trim();
  const proxyFor = interaction.fields.getTextInputValue("proxy_for").trim();

  const bookingDate = getBookingDateToday();
  const bookingId = insertBooking({
    guildId: interaction.guildId,
    bookingDate,
    location,
    time,
    channel,
    bookerId: interaction.user.id,
    proxyFor,
  });

  await interaction.reply({ content: "已收到你的預約，等待管理員確認～", ephemeral: true });

  const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setTitle("新預約待確認")
    .addFields(
      { name: "地點", value: location, inline: true },
      { name: "時間", value: time, inline: true },
      { name: "頻道", value: channel || "當日決定", inline: true },
      { name: "預約人", value: `<@${interaction.user.id}>`, inline: true },
      { name: "代約對象", value: proxyFor || "（無）", inline: true }
    )
    .setFooter({ text: `Booking ID: ${bookingId}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_${bookingId}`).setLabel("✅ 確認").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject_${bookingId}`).setLabel("❌ 退回").setStyle(ButtonStyle.Danger)
  );

  await adminChannel.send({ embeds: [embed], components: [row] });
}

// 3. 管理員按下確認/退回
async function handleDecision(interaction, status) {
  const bookingId = interaction.customId.split("_")[1];
  const booking = getBooking(bookingId);

  if (!booking) {
    await interaction.reply({ content: "找不到這筆預約，可能已被處理過。", ephemeral: true });
    return;
  }

  updateBookingStatus(bookingId, status);

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("noop_confirm").setLabel("✅ 確認").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId("noop_reject").setLabel("❌ 退回").setStyle(ButtonStyle.Danger).setDisabled(true)
  );

  const resultText = status === "confirmed" ? `已由 <@${interaction.user.id}> 確認 ✅` : `已由 <@${interaction.user.id}> 退回 ❌`;
  await interaction.update({ components: [disabledRow] });
  await interaction.followUp({ content: resultText, ephemeral: false });

  if (status === "confirmed") {
    await refreshSummaryMessage(booking.booking_date);
  }
}

// 4. 重新渲染 & 編輯【預約統計】訊息
async function refreshSummaryMessage(bookingDate) {
  const bookings = getConfirmedBookingsByDate(bookingDate);
  const text = formatSummary(bookings);

  const summaryChannel = await client.channels.fetch(process.env.SUMMARY_CHANNEL_ID);
  const existing = getSummaryMessage(bookingDate);

  if (existing) {
    try {
      const msg = await summaryChannel.messages.fetch(existing.message_id);
      await msg.edit(text);
      return;
    } catch (err) {
      console.warn("原本的統計訊息抓不到，改成重新發一則：", err.message);
    }
  }

  const newMsg = await summaryChannel.send(text);
  setSummaryMessage(bookingDate, summaryChannel.id, newMsg.id);
}

client.login(process.env.DISCORD_TOKEN);
