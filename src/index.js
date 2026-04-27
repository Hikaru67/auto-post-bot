const scheduler = require('./core/scheduler');
const logger = require('./utils/logger');
const config = require('./config');

logger.info('=============================');
logger.info('=== BẮT ĐẦU AUTO POST BOT ===');
logger.info('=============================');

// Khởi chạy lập lịch
scheduler.start();

// Ghi chú: Nếu muốn chạy thử một lần ngay khi bật bot (không cần chờ lịch),
// hãy bỏ comment các dòng dưới đây:

// const engine = require('./core/engine');
// logger.info('Đang chạy thử nghiệm luồng đăng bài một lần...');
// engine.run();
