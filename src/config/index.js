require('dotenv').config();

module.exports = {
  googleSheets: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  },
  facebook: {
    cookiePath: process.env.FB_COOKIE_PATH || './cookies.json',
    // Mảng groups cũ được thay thế bằng cấu trúc map trong groups.json
    groupsMapPath: './groups.json',
  },
  bannha888: {
    cookie: process.env.BANNHA888_COOKIE || '',
  },
  schedule: {
    cron: process.env.CRON_SCHEDULE || '0 6,12,20 * * *',
  }
};
