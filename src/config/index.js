require('dotenv').config();

module.exports = {
  googleSheets: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  },
  facebook: {
    cookiePath: process.env.FB_COOKIE_PATH || './cookies.json',
    groups: process.env.TARGET_FB_GROUPS ? process.env.TARGET_FB_GROUPS.split(',').map(g => g.trim()) : [],
  },
  schedule: {
    cron: process.env.CRON_SCHEDULE || '0 6,12,20 * * *',
  }
};
