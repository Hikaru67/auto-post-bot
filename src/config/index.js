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
    crawlCron: process.env.CRAWL_CRON || '0 */8 * * *',
    // Số bài tối đa được đăng mỗi lần trigger (0 = không giới hạn)
    postLimitPerTrigger: parseInt(process.env.POST_LIMIT_PER_TRIGGER || '3', 10),
  },
  thienKhoi: {
    baseUrl: 'https://backend.thienkhoi.com',
    // access_token ban đầu (có thể hết hạn sau vài phút)
    accessToken: process.env.THIENKHOI_ACCESS_TOKEN || '',
    // refresh_token (hạn dài hơn ~12h) dùng để lấy access_token mới
    refreshToken: process.env.THIENKHOI_REFRESH_TOKEN || '',
  },
};
