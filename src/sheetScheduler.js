// Suppress DEP0040: `punycode` deprecation từ dependency google-spreadsheet
const _stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && chunk.includes('DEP0040')) return true;
  return _stderrWrite(chunk, ...args);
};

const cron = require('node-cron');
const logger = require('./utils/logger');
const { run: runMakeContent } = require('../tests/test-make-content-sheet');
const { run: runImageFilter } = require('../tests/test-image-filter-sheet');
const { run: runFixPrice } = require('../tests/test-fix-price-sheet');

// Cấu hình cron mặc định: mỗi 12 tiếng một lần (vào 00:00 và 12:00)
const SHEET_CRON = process.env.SHEET_PROCESSING_CRON || '0 */12 * * *';

let isRunning = false;

async function executeSheetTasks() {
  if (isRunning) {
    logger.warn('[SheetScheduler] Tiến trình xử lý Sheet trước đó chưa hoàn thành. Bỏ qua lần trigger này.');
    return;
  }

  isRunning = true;
  logger.info('\n======================================================');
  logger.info('🚀 [SheetScheduler] BẮT ĐẦU CHẠY TIẾN TRÌNH XỬ LÝ SHEET');
  logger.info('======================================================');

  try {
    logger.info('\n[Task 1/3] Chạy tạo nội dung (make-content-sheet)...');
    await runMakeContent();
  } catch (err) {
    logger.error(`[SheetScheduler] Task 1 (make-content-sheet) bị lỗi: ${err.message}`);
  }

  try {
    logger.info('\n[Task 2/3] Chạy lọc hình ảnh (image-filter-sheet)...');
    await runImageFilter();
  } catch (err) {
    logger.error(`[SheetScheduler] Task 2 (image-filter-sheet) bị lỗi: ${err.message}`);
  }

  try {
    logger.info('\n[Task 3/3] Chạy kiểm tra & bổ sung giá BDS (fix-price-sheet)...');
    await runFixPrice();
  } catch (err) {
    logger.error(`[SheetScheduler] Task 3 (fix-price-sheet) bị lỗi: ${err.message}`);
  }

  isRunning = false;
  logger.info('\n======================================================');
  logger.info('✅ [SheetScheduler] HOÀN THÀNH TIẾN TRÌNH XỬ LÝ SHEET');
  logger.info('======================================================\n');
}

function start() {
  logger.info('======================================================');
  logger.info('=== BẮT ĐẦU SHEET PROCESSING SCHEDULER ===');
  logger.info('======================================================');
  logger.info(`Lập lịch xử lý Sheet với cron: ${SHEET_CRON} (Mỗi 12 tiếng)`);

  if (!cron.validate(SHEET_CRON)) {
    logger.error('Cấu hình cron SHEET_PROCESSING_CRON không hợp lệ!');
    process.exit(1);
  }

  // Chạy ngay lần đầu nếu có cờ --run-now
  if (process.argv.includes('--run-now')) {
    logger.info('Phát hiện cờ --run-now: Thực thi task ngay lập tức...');
    executeSheetTasks();
  }

  cron.schedule(SHEET_CRON, async () => {
    logger.info('Đã đến giờ xử lý Sheet (Cron triggered)');
    await executeSheetTasks();
  });

  logger.info('Hệ thống lập lịch Sheet đã hoạt động. Đang chờ trigger...');
}

start();
