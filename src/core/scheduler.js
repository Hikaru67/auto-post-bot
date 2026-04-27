const cron = require('node-cron');
const config = require('../config');
const engine = require('./engine');
const logger = require('../utils/logger');

class Scheduler {
  start() {
    logger.info(`Bắt đầu lập lịch với cấu hình cron: ${config.schedule.cron}`);
    
    if (!cron.validate(config.schedule.cron)) {
      logger.error('Cấu hình cron không hợp lệ!');
      return;
    }

    // Lên lịch task
    cron.schedule(config.schedule.cron, async () => {
      logger.info('Đã đến giờ đăng bài (Cron triggered)');
      await engine.run();
    });

    logger.info('Hệ thống lập lịch đã hoạt động. Đang chờ đến giờ đăng bài...');
  }
}

module.exports = new Scheduler();
