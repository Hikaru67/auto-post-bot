'use strict';

const googleSheets = require('../data/googleSheets');
const { crawlProperties } = require('../data/thienKhoiCrawler');
const logger = require('../utils/logger');

/**
 * Engine điều phối toàn bộ pipeline crawl:
 * 1. Crawl danh sách BĐS từ API Thiên Khôi (có auto refresh token)
 * 2. Kiểm tra dedup theo cột Id trong Google Sheet
 * 3. Append các BĐS mới vào sheet (Status trống → chờ đăng FB)
 */
class CrawlEngine {
  /**
   * @param {{ maxPages?: number, limit?: number, dryRun?: boolean }} options
   *  - maxPages: số trang tối đa sẽ crawl (mỗi trang = limit property)
   *  - limit: số property mỗi trang (mặc định 20)
   *  - dryRun: nếu true → chỉ log, không ghi Google Sheet
   */
  async run({ maxPages = 5, limit = 20, dryRun = false } = {}) {
    logger.info('════════════════════════════════════════');
    logger.info(' BẮT ĐẦU CRAWL ENGINE – THIÊN KHÔI BĐS');
    logger.info(` maxPages=${maxPages} | limit=${limit} | dryRun=${dryRun}`);
    logger.info('════════════════════════════════════════');

    try {
      // ── Step 1: Lấy danh sách Id đã tồn tại trong sheet ─────────────────────
      // Luôn load (cả dry-run) để skip detail API với các Id đã có
      logger.info('[CrawlEngine] Đang tải danh sách Id hiện có từ Google Sheet...');
      const existingIds = await googleSheets.getExistingIds();

      // ── Step 2: Crawl data từ API (truyền existingIds để skip detail API) ───
      // Crawler sẽ tự bỏ qua các item có id trong existingIds trước khi gọi detail
      const newProperties = await crawlProperties({ maxPages, limit, dryRun, existingIds });
      const skipped = 0; // đã được log bên trong crawlProperties

      if (newProperties.length === 0) {
        logger.info('[CrawlEngine] Không có BĐS mới nào cần thêm. Kết thúc.');
        return { crawled: 0, added: 0, skipped };
      }

      // ── Step 3: Batch ghi vào Google Sheet ─────────────────────────────────
      let added = 0;
      if (!dryRun) {
        logger.info(`[CrawlEngine] Ghi ${newProperties.length} BĐS mới vào sheet (batch mode)...`);
        const result = await googleSheets.appendCrawledProperties(newProperties);
        added = result.added;
      } else {
        added = newProperties.length; // dry-run: count as "would add"
      }

      // ── Summary ──────────────────────────────────────────────────
      logger.info('════════════════════════════════════════');
      logger.info(`[CrawlEngine] HOÀN THÀNH`);
      logger.info(`  • BĐS mới crawl : ${newProperties.length}`);
      logger.info(`  • Đã ghi sheet  : ${added}`);
      logger.info(`  • Sheet hiện có : ${existingIds.size} Id (trước lần này)`);
      logger.info('════════════════════════════════════════');

      return { crawled: newProperties.length, added, skipped };
    } catch (error) {
      logger.error('[CrawlEngine] Lỗi nghiêm trọng:', error);
      throw error;
    }
  }
}

module.exports = new CrawlEngine();

// ── Chạy trực tiếp: node src/core/crawlEngine.js [--dry-run] [--pages=N] ─────
if (require.main === module) {
  require('dotenv').config();

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pagesArg = args.find((a) => a.startsWith('--pages='));
  const maxPages = pagesArg ? parseInt(pagesArg.split('=')[1], 10) : 5;

  module.exports
    .run({ maxPages, limit: 20, dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
