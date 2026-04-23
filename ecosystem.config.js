/**
 * PM2 配置 · 用法：
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [{
    name: 'cbti-sleep-diary',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // 强烈建议在生产环境通过外部配置覆盖 JWT_SECRET（如下）
      // JWT_SECRET: '请改成你自己的长随机串',
      // ALLOW_REGISTER: 'false',  // 注册完所有人后可关闭
      // DATA_DIR: '/var/lib/cbti-data',
    },
  }],
};
