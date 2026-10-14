const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  adminPassword: env.ADMIN_PASSWORD || '',
  igAccessToken: env.IG_ACCESS_TOKEN || '',
  igUserId: env.IG_USER_ID || '',
  metaAppSecret: env.META_APP_SECRET || '',
  webhookVerifyToken: env.WEBHOOK_VERIFY_TOKEN || '',
  igApiVersion: env.IG_API_VERSION || 'v21.0',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'domus.db'),
};
