const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const BasePublisher = require('./BasePublisher');
const config = require('../config');
const logger = require('../utils/logger');
const { downloadImage } = require('../utils/downloadImage');
const path = require('path');

class FacebookPublisher extends BasePublisher {
  constructor() {
    super('Facebook');
  }

  async publish(postData) {
    if (!config.facebook.cookiePath) {
      logger.error('Thiếu cấu hình đường dẫn file cookie Facebook');
      return false;
    }

    if (config.facebook.groups.length === 0) {
      logger.warn('Chưa cấu hình group Facebook nào để đăng');
      return false;
    }

    logger.info(`[Facebook] Bắt đầu đăng bài...`);
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: false, // Mở UI trình duyệt để dễ quan sát/debug, chạy thật có thể đổi sang 'new'
        args: ['--disable-notifications', '--no-sandbox']
      });

      const page = await browser.newPage();

      logger.info(`[Facebook] Đang nạp cookie từ file: ${config.facebook.cookiePath}...`);
      try {
        const cookiesString = await fs.readFile(config.facebook.cookiePath, 'utf8');
        let cookies = JSON.parse(cookiesString);

        // Chuẩn hoá định dạng Cookie từ các Extension sang chuẩn mà Puppeteer hỗ trợ
        const puppeteerCookies = cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expirationDate || c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          // Puppeteer chỉ nhận 'Strict', 'Lax', 'None' (viết hoa chữ đầu)
          sameSite: c.sameSite === 'no_restriction' ? 'None'
            : (c.sameSite ? c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1) : undefined)
        }));

        await page.setCookie(...puppeteerCookies);
        logger.info('[Facebook] Nạp cookie thành công!');
      } catch (cookieErr) {
        logger.error(`[Facebook] Lỗi khi đọc file cookie tại ${config.facebook.cookiePath}. Bạn đã export cookie đúng định dạng JSON chưa?`, cookieErr.message);
        return false;
      }

      // Chuyển hướng tới Facebook để kiểm tra trạng thái đăng nhập
      await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
      // Kiểm tra xem đã login thành công chưa bằng cách check url hoặc 1 element (ví dụ không có form login)
      if (page.url().includes('login')) {
        logger.error('[Facebook] Cookie dường như đã hết hạn, bị văng ra trang login. Vui lòng cập nhật cookie mới.');
        return false;
      }
      logger.info('[Facebook] Đã xác nhận trạng thái đăng nhập với Cookie!');

      let successCount = 0;
      for (const groupUrl of config.facebook.groups) {
        logger.info(`[Facebook] Truy cập group: ${groupUrl}`);
        await page.goto(groupUrl, { waitUntil: 'networkidle2' });

        try {
          // Lưu ý: Các Selector của Facebook thay đổi liên tục và bị obfuscate (mã hóa tên class).
          // Đoạn mã dưới đây là bộ khung skeleton mô phỏng lại các bước đăng bài:
          // Bạn sẽ cần inspect element thực tế trên máy để trỏ chính xác selector hoặc dùng xpath.

          // 1. Quét tìm nút "Tạo bài viết" bằng text hiển thị thay vì dùng Class (bền vững hơn)
          await new Promise(r => setTimeout(r, 3000)); // Đợi giao diện render xong

          const clicked = await page.evaluate(() => {
            // Danh sách các từ khoá phổ biến của ô nhập bài viết trên Facebook Group (Cả tiếng Việt & Anh)
            const keywords = ['viết gì đó', 'write something', 'bạn viết gì đi', 'tạo bài viết công khai', 'create a public post'];

            const elements = Array.from(document.querySelectorAll('*'));
            for (const el of elements) {
              const text = (el.innerText || '').trim().toLowerCase();
              // Nếu text thẻ đó hoàn toàn trùng với các từ khoá (để tránh click nhầm)
              if (keywords.some(kw => text.includes(kw)) && el.getAttribute('role') === 'button') {
                el.click();
                return true;
              }
            }

            // Fallback: Tìm span có text tương tự và bấm vào nó (hoặc thẻ cha của nó)
            for (const el of elements) {
              const text = (el.innerText || '').trim().toLowerCase();
              if (keywords.some(kw => text === kw || text === kw + '...')) {
                el.click();
                return true;
              }
            }

            return false;
          });

          if (!clicked) {
            throw new Error("Không tìm thấy nút 'Viết gì đó' hoặc 'Write something' trên trang! Vui lòng kiểm tra lại ngôn ngữ hoặc giao diện.");
          }

          await new Promise(r => setTimeout(r, 3000)); // Chờ popup nhập text hiện ra

          // 2. Điền nội dung
          // Kết hợp Title và Content (nếu có Title)
          const textToPost = postData.title ? `[${postData.title}]\n\n${postData.content}` : postData.content;
          
          // Cần tìm đến thẻ div role="textbox" đang focus
          await page.keyboard.type(textToPost, { delay: 20 });

          // 3. Đăng ảnh (nếu có)
          if (postData.images && postData.images.length > 0) {
            logger.info(`[Facebook] Đang tải ${postData.images.length} ảnh về để upload...`);
            const localImagePaths = [];
            const tmpFolder = path.join(process.cwd(), 'tmp');

            try {
              // 3.1. Tải toàn bộ ảnh từ link về thư mục tmp/
              for (const imgUrl of postData.images) {
                if (imgUrl.trim() !== '') {
                  const localPath = await downloadImage(imgUrl.trim(), tmpFolder);
                  localImagePaths.push(localPath);
                }
              }

              // 3.2. Tìm thẻ input type="file" để upload ảnh lên Facebook
              const fileInputSelector = 'input[type="file"][accept^="image"]';
              
              // Chờ thẻ input xuất hiện. Nếu không thấy, Facebook có thể bắt click nút "Ảnh/Video" trước
              await page.waitForSelector(fileInputSelector, { timeout: 5000 }).catch(() => null);
              const fileInput = await page.$(fileInputSelector);
              
              if (fileInput && localImagePaths.length > 0) {
                // Đẩy đường dẫn ảnh vào thẻ input
                await fileInput.uploadFile(...localImagePaths);
                logger.info(`[Facebook] Đã đẩy ${localImagePaths.length} ảnh vào form. Đang chờ ảnh upload...`);
                
                // Đợi Facebook tải ảnh lên giao diện (tuỳ mạng, thường mất vài giây)
                await new Promise(r => setTimeout(r, 8000));
              } else {
                logger.warn('[Facebook] Không tìm thấy thẻ input tải ảnh. (Có thể giao diện cần click nút thêm Ảnh/Video trước).');
              }
            } catch (imgError) {
               logger.error('[Facebook] Lỗi trong quá trình xử lý ảnh:', imgError.message);
            } finally {
              // 3.3 Dọn dẹp rác: Xoá ảnh ở thư mục tmp đi
              for (const localPath of localImagePaths) {
                await fs.unlink(localPath).catch(e => logger.warn(`Không thể xoá file tạm ${localPath}`));
              }
            }
          }

          // 4. Bấm nút đăng
          // await page.click('div[aria-label="Post"], div[aria-label="Đăng"]');
          const isPosted = await page.evaluate(() => {
            // Thay vì dùng chuỗi class rất dài và dễ đổi, ta quét qua tất cả các phần tử đóng vai trò là nút bấm
            const buttons = Array.from(document.querySelectorAll('div[role="button"], span'));
            
            const target = buttons.find(el => {
              const text = (el.innerText || '').trim().toLowerCase();
              return text === 'đăng' || text === 'post';
            });

            if (target) {
              target.click();
              return true;
            }

            return false;
          });
          
          if (!isPosted) {
            logger.warn(`[Facebook] Cảnh báo: Không thể tìm thấy nút Đăng bài (có chữ 'Đăng' hoặc 'Post').`);
          }

          await new Promise(r => setTimeout(r, 5000)); // Chờ bài viết đăng xong

          logger.info(`[Facebook] Đã post bài lên group ${groupUrl} (Skeleton)`);
          successCount++;

          // Nghỉ một chút giữa các group để tránh Facebook khóa tài khoản (checkpoint)
          await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
        } catch (postError) {
          logger.error(`[Facebook] Lỗi khi đăng bài lên group ${groupUrl}`, postError);
        }
      }

      return successCount > 0;
    } catch (error) {
      logger.error('[Facebook] Lỗi quá trình đăng bài:', error);
      return false;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}

module.exports = new FacebookPublisher();
