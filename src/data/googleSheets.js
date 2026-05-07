const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const config = require('../config');
const logger = require('../utils/logger');

class GoogleSheetsService {
  constructor() {
    this.doc = null;
  }

  async init() {
    if (!config.googleSheets.spreadsheetId) {
      logger.warn('Google Sheets config is missing.');
      return;
    }

    try {
      const auth = new JWT({
        email: config.googleSheets.serviceAccountEmail,
        key: config.googleSheets.privateKey ? config.googleSheets.privateKey.replace(/\\n/g, '\n') : '',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.doc = new GoogleSpreadsheet(config.googleSheets.spreadsheetId, auth);
      await this.doc.loadInfo();
      logger.info(`Đã kết nối Google Sheet: ${this.doc.title}`);
    } catch (error) {
      logger.error('Lỗi khi khởi tạo Google Sheets', error);
      throw error;
    }
  }

  async getNextPost() {
    if (!this.doc) await this.init();
    
    try {
      const sheet = this.doc.sheetsByIndex[0]; // Lấy sheet đầu tiên
      const rows = await sheet.getRows();

      // Tìm bài viết chưa đăng (cột Status rỗng hoặc != 'POSTED')
      const nextRow = rows.find(row => row.get('Status') !== 'POSTED');

      if (!nextRow) {
        logger.info('Không còn bài viết nào chưa đăng trong Google Sheets.');
        return null;
      }

      const postData = {
        rowNumber: nextRow.rowNumber,
        region: nextRow.get('Region') || '',
        title: nextRow.get('Title') || '',
        content: nextRow.get('Content') || '',
        images: nextRow.get('Images') ? nextRow.get('Images').split(',').map(i => i.trim()) : [],
      };

      return { row: nextRow, data: postData };
    } catch (error) {
      logger.error('Lỗi khi lấy bài viết tiếp theo', error);
      return null;
    }
  }

  async markAsPosted(row) {
    try {
      row.assign({ Status: 'POSTED' });
      await row.save();
      logger.info(`Đã đánh dấu bài viết ở dòng ${row.rowNumber} là POSTED`);
    } catch (error) {
      logger.error(`Lỗi khi cập nhật trạng thái dòng ${row.rowNumber}`, error);
    }
  }
}

module.exports = new GoogleSheetsService();
