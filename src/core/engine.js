const googleSheets = require('../data/googleSheets');
const facebookPublisher = require('../publishers/FacebookPublisher');
const bannha888Publisher = require('../publishers/Bannha888Publisher');
const logger = require('../utils/logger');

// Danh sách các nền tảng đăng bài
// Tương lai (Phase 2) có thể require BatDongSanPublisher và thêm vào mảng này
const publishers = [
  facebookPublisher,
  // bannha888Publisher,
];

class Engine {
  async run() {
    logger.info('Bắt đầu chu kỳ đăng bài mới...');
    try {
      // 1. Lấy dữ liệu tất cả bài đăng chưa đăng
      const postsToPublish = await googleSheets.getUnpostedPosts();
      if (!postsToPublish || postsToPublish.length === 0) {
        logger.info('Kết thúc chu kỳ: Không có bài đăng nào cần đăng hoặc chưa có cấu hình.');
        return;
      }

      logger.info(`Tìm thấy ${postsToPublish.length} bài đăng cần xử lý trong chu kỳ này.`);

      for (const postInfo of postsToPublish) {
        const { row, data } = postInfo;
        logger.info(`Đang xử lý bài đăng từ dòng ${data.rowNumber}`);

        // 2. Gửi cho các publisher xử lý
        let allSuccess = true;
        let hasTried = false;

        for (const publisher of publishers) {
          try {
            hasTried = true;
            const success = await publisher.publish(data);
            if (!success) {
              allSuccess = false;
              logger.warn(`[Engine] Đăng bài thất bại (hoặc không thành công hoàn toàn) trên nền tảng ${publisher.name}`);
            }
          } catch (pubErr) {
            allSuccess = false;
            logger.error(`[Engine] Lỗi khi chạy publisher ${publisher.name}`, pubErr);
          }
        }

        // 3. Cập nhật trạng thái
        if (hasTried && allSuccess) {
          // Nếu tất cả publisher đều đăng thành công
          await googleSheets.markAsPosted(row);
          logger.info(`Hoàn thành: Bài đăng dòng ${data.rowNumber} đã đăng xong.`);
        } else {
          logger.warn(`Bài đăng dòng ${data.rowNumber} chưa được đăng thành công hoàn toàn. Sẽ thử lại ở chu kỳ sau.`);
        }
      }
      logger.info('Hoàn thành chu kỳ đăng tất cả các bài.');

    } catch (error) {
      logger.error('Lỗi nghiêm trọng trong chu kỳ đăng bài:', error);
    }
  }
}

module.exports = new Engine();
