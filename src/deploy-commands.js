import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("預約")
    .setDescription("預約《出租迴響群》的施法時段")
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log("開始註冊 slash command...");
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("註冊完成！（Guild 指令會立即生效）");
} catch (err) {
  console.error("註冊失敗：", err);
}
