const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const config = require('../config');
const logger = require('../utils/logger');

// Google Sheets hard limit: 50,000 ký tự mỗi ô
const CELL_MAX_CHARS = 50_000;

/** Truncate chuỗi về giới hạn ký tự của ô Google Sheets */
function truncateCell(value, max = CELL_MAX_CHARS) {
  if (!value) return value;
  const str = String(value);
  if (str.length <= max) return str;
  logger.warn(`[GoogleSheets] Nội dung bị cắt bớt: ${str.length} → ${max} ký tự`);
  return str.substring(0, max);
}

/** Sleep helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async getUnpostedPosts() {
    if (!this.doc) await this.init();

    try {
      const sheet = this.doc.sheetsByIndex[0]; // Lấy sheet đầu tiên
      const rows = await sheet.getRows();

      // Tìm tất cả bài viết chưa đăng (cột Status rỗng hoặc != 'POSTED')
      const unpostedRows = rows.filter(row => row.get('Status') !== 'POSTED' && row.get('Status') !== '');

      if (unpostedRows.length === 0) {
        logger.info('Không còn bài viết nào chưa đăng trong Google Sheets.');
        return [];
      }

      return unpostedRows.map(row => {
        const postData = {
          rowNumber: row.rowNumber,
          region: row.get('Region') || '',
          title: row.get('Title') || '',
          content: row.get('Content') || '',
          price: row.get('Price') || '',
          address: row.get('Address') || '',
          area: row.get('Area') || '',
          images: row.get('Images') ? row.get('Images').split(',').map(i => i.trim()) : [],
        };
        return { row, data: postData };
      });
    } catch (error) {
      logger.error('Lỗi khi lấy danh sách bài viết chưa đăng', error);
      return [];
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

  /**
   * Lấy toàn bộ giá trị cột 'Id' trong sheet để kiểm tra duplicate.
   * @returns {Promise<Set<string>>}
   */
  async getExistingIds() {
    if (!this.doc) await this.init();
    try {
      const sheet = this.doc.sheetsByIndex[0];
      const rows = await sheet.getRows();
      const ids = new Set(rows.map(row => row.get('Id')).filter(Boolean));
      logger.info(`[GoogleSheets] Tìm thấy ${ids.size} Id đã có trong sheet.`);
      return ids;
    } catch (error) {
      logger.error('[GoogleSheets] Lỗi khi lấy danh sách Id hiện có', error);
      return new Set();
    }
  }

  /**
   * Append nhiều BĐS vào sheet theo batch để tránh rate limit 429.
   *
   * Google Sheets API giới hạn:
   *   - 60 write requests/phút/user
   *   - 50,000 ký tự tối đa mỗi ô
   *
   * Chiến lược:
   *   - Gom nhiều row vào 1 lần gọi addRows() (1 request = N rows)
   *   - Sleep giữa các batch để tránh vượt quota
   *
   * @param {Array<{ Id, Title, Content, Region, Images, Price, Address, Area }>} propertiesArray
   * @param {{ chunkSize?: number, delayMs?: number }} options
   *   - chunkSize: số row mỗi batch (mặc định 5)
   *   - delayMs: delay giữa các batch ms (mặc định 12000 = 12s, an toàn với limit 60req/min)
   * @returns {Promise<{ added: number, failed: number }>}
   */
  async appendCrawledProperties(propertiesArray, { chunkSize = 5, delayMs = 12_000 } = {}) {
    if (!this.doc) await this.init();
    const sheet = this.doc.sheetsByIndex[0];

    let added = 0;
    let failed = 0;
    const chunks = [];

    // Chia thành các batch
    for (let i = 0; i < propertiesArray.length; i += chunkSize) {
      chunks.push(propertiesArray.slice(i, i + chunkSize));
    }

    logger.info(
      `[GoogleSheets] Sẽ ghi ${propertiesArray.length} row ` +
      `theo ${chunks.length} batch (chunkSize=${chunkSize}, delay=${delayMs}ms)`
    );

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      logger.info(`[GoogleSheets] Batch ${ci + 1}/${chunks.length}: ghi ${chunk.length} row...`);

      // Transform sang object row, truncate content dài
      const rowObjects = chunk.map((p) => ({
        Id:      p.Id,
        Title:   truncateCell(p.Title),
        Content: truncateCell(p.Content),
        Region:  p.Region,
        Images:  truncateCell(p.Images),
        Price:   p.Price,
        Address: p.Address,
        Area:    p.Area,
        Status:  '',
      }));

      try {
        await sheet.addRows(rowObjects);
        added += chunk.length;
        chunk.forEach((p) =>
          logger.info(`[GoogleSheets] ✅ ${p.Id} | ${p.Title?.substring(0, 50)}`)
        );
      } catch (error) {
        failed += chunk.length;
        logger.error(
          `[GoogleSheets] ❌ Batch ${ci + 1} thất bại: ${error.message}`
        );
        // Nếu vẫn bị 429 → tăng delay gấp đôi rồi retry 1 lần
        if (error.message?.includes('429') || error.status === 429) {
          const retryDelay = delayMs * 2;
          logger.warn(`[GoogleSheets] Rate limited. Retry sau ${retryDelay}ms...`);
          await sleep(retryDelay);
          try {
            await sheet.addRows(rowObjects);
            added += chunk.length;
            failed -= chunk.length;
            logger.info(`[GoogleSheets] ✅ Batch ${ci + 1} retry thành công.`);
          } catch (retryErr) {
            logger.error(`[GoogleSheets] ❌ Batch ${ci + 1} retry vẫn thất bại: ${retryErr.message}`);
          }
        }
      }

      // Sleep giữa các batch (trừ batch cuối)
      if (ci < chunks.length - 1) {
        logger.info(`[GoogleSheets] Chờ ${delayMs}ms trước batch tiếp theo...`);
        await sleep(delayMs);
      }
    }

    logger.info(`[GoogleSheets] Hoàn thành batch write: added=${added}, failed=${failed}`);
    return { added, failed };
  }
}

module.exports = new GoogleSheetsService();
