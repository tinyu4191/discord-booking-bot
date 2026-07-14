// pm2 設定檔。用 .cjs 副檔名是因為 package.json 設定了 "type": "module"，
// 這裡強制用 CommonJS 語法（module.exports），避免跟 pm2 的載入方式衝突。
module.exports = {
  apps: [
    {
      name: "booking-bot",
      script: "src/index.js",
      cwd: __dirname,
      autorestart: true,      // 當機自動重啟
      max_restarts: 10,       // 短時間內重啟太多次就停止，避免無限重啟洗 log
      min_uptime: "30s",      // 跑超過 30 秒才算「成功啟動」，避免壞掉的版本一直重啟
      restart_delay: 5000,    // 重啟前等 5 秒
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
