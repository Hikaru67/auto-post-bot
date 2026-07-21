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

    if (!config.facebook.groupsMapPath) {
      logger.warn('Chưa cấu hình đường dẫn file groups.json');
      return false;
    }

    logger.info(`[Facebook] Bắt đầu đăng bài...`);
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true, // Mở UI trình duyệt để dễ quan sát/debug, chạy thật có thể đổi sang 'new'
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

      // Load danh sách nhóm theo Khu vực (Region) từ groups.json
      let targetGroups = [];
      try {
        const groupsMap = JSON.parse(await fs.readFile(config.facebook.groupsMapPath, 'utf8'));
        const region = postData.region && postData.region.trim() !== '' ? postData.region.trim() : 'Mặc định';

        if (groupsMap[region] && Array.isArray(groupsMap[region])) {
          targetGroups = groupsMap[region];
        } else if (groupsMap['Mặc định']) {
          logger.warn(`[Facebook] Không tìm thấy mapping cho khu vực '${region}'. Sử dụng danh sách 'Mặc định'.`);
          targetGroups = groupsMap['Mặc định'];
        }
      } catch (err) {
        logger.error(`[Facebook] Lỗi khi đọc file cấu hình nhóm ${config.facebook.groupsMapPath}`, err.message);
        return false;
      }

      if (targetGroups.length === 0) {
        logger.warn('[Facebook] Không có group Facebook nào được cấu hình cho bài đăng này.');
        return false;
      }

      // Tải ảnh về 1 lần để dùng chung cho tất cả các group
      let sharedLocalImagePaths = [];
      const tmpFolder = path.join(process.cwd(), 'tmp');
      if (postData.images && postData.images.length > 0) {
        logger.info(`[Facebook] Đang tải ${postData.images.length} ảnh về để upload chung cho các nhóm...`);
        for (const imgUrl of postData.images) {
          if (imgUrl.trim() !== '') {
            try {
              const localPath = await downloadImage(imgUrl.trim(), tmpFolder);
              sharedLocalImagePaths.push(localPath);
            } catch (err) {
              logger.warn(`[Facebook] Lỗi khi tải ảnh ${imgUrl}:`, err.message);
            }
          }
        }
      }

      let successCount = 0;
      const CONCURRENCY_LIMIT = 3; // Số lượng tab chạy song song

      const processGroup = async (groupUrl) => {
        const groupPage = await browser.newPage();
        try {
          logger.info(`[Facebook] Truy cập group: ${groupUrl}`);
          await groupPage.goto(groupUrl, { waitUntil: 'networkidle2' });

          // Lưu ý: Các Selector của Facebook thay đổi liên tục và bị obfuscate (mã hóa tên class).
          // Đoạn mã dưới đây là bộ khung skeleton mô phỏng lại các bước đăng bài:
          // Bạn sẽ cần inspect element thực tế trên máy để trỏ chính xác selector hoặc dùng xpath.

          // 1. Quét tìm nút "Tạo bài viết" bằng text hiển thị thay vì dùng Class (bền vững hơn)
          await new Promise(r => setTimeout(r, 3000)); // Đợi giao diện render xong

          const clicked = await groupPage.evaluate(() => {
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
          // Sinh mã chống Spam (Token ngẫu nhiên cho từng group)
          const antiSpamToken = Math.random().toString(36).substring(2, 8).toUpperCase();
          const regionCode = postData.region ? postData.region.replace(/\\s+/g, '').substring(0, 4) : 'BDS';
          const antiSpamText = `\n\n(ID: ${regionCode}-${antiSpamToken})`;

          // Kết hợp Title và Content (nếu có Title)
          let textToPost = postData.content;
          textToPost += antiSpamText; // Gắn anti-spam vào cuối

          // Gõ nội dung vào ô textbox
          await groupPage.keyboard.type(textToPost, { delay: 20 });

          // 3. Đăng ảnh (nếu có)
          if (sharedLocalImagePaths.length > 0) {
            try {
              // 3.1. Tìm thẻ input type="file" để upload ảnh lên Facebook
              const fileInputSelector = 'input[type="file"][accept^="image"]';

              // Chờ thẻ input xuất hiện. Nếu không thấy, Facebook có thể bắt click nút "Ảnh/Video" trước
              await groupPage.waitForSelector(fileInputSelector, { timeout: 5000 }).catch(() => null);
              const fileInput = await groupPage.$(fileInputSelector);

              if (fileInput) {
                // Đẩy đường dẫn ảnh vào thẻ input
                await fileInput.uploadFile(...sharedLocalImagePaths);
                logger.info(`[Facebook] Đã đẩy ${sharedLocalImagePaths.length} ảnh vào form trên group ${groupUrl}`);

                // Đợi Facebook tải ảnh lên giao diện (tuỳ mạng, thường mất vài giây)
                await new Promise(r => setTimeout(r, 8000));
              } else {
                logger.warn(`[Facebook] Không tìm thấy thẻ input tải ảnh trên group ${groupUrl}. (Có thể giao diện cần click nút thêm Ảnh/Video trước).`);
              }
            } catch (imgError) {
              logger.error(`[Facebook] Lỗi trong quá trình xử lý ảnh trên group ${groupUrl}:`, imgError.message);
            }
          }

          // 4. Bấm nút đăng
          // await groupPage.click('div[aria-label="Post"], div[aria-label="Đăng"]');
          const isPosted = await groupPage.evaluate(() => {
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
            logger.warn(`[Facebook] Cảnh báo: Không thể tìm thấy nút Đăng bài (có chữ 'Đăng' hoặc 'Post') trên group ${groupUrl}.`);
          }

          await new Promise(r => setTimeout(r, 5000)); // Chờ bài viết đăng xong

          logger.info(`[Facebook] Đã post bài lên group ${groupUrl} (Skeleton)`);
          successCount++;
        } catch (postError) {
          logger.error(`[Facebook] Lỗi khi đăng bài lên group ${groupUrl}`, postError.message);
        } finally {
          await groupPage.close().catch(() => { });
        }
      };

      // Xử lý song song theo batch (chunk)
      for (let i = 0; i < targetGroups.length; i += CONCURRENCY_LIMIT) {
        const chunk = targetGroups.slice(i, i + CONCURRENCY_LIMIT);
        logger.info(`[Facebook] Đang xử lý batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}: Đăng lên ${chunk.length} groups cùng lúc...`);

        const promises = chunk.map(groupUrl => processGroup(groupUrl));
        await Promise.all(promises);

        // Nghỉ một chút giữa các batch để tránh Facebook khóa tài khoản
        if (i + CONCURRENCY_LIMIT < targetGroups.length) {
          logger.info(`[Facebook] Đã xong batch, nghỉ một chút trước khi sang batch tiếp theo...`);
          await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
        }
      }

      // Dọn dẹp rác: Xoá ảnh ở thư mục tmp sau khi đăng xong tất cả các group
      if (sharedLocalImagePaths && sharedLocalImagePaths.length > 0) {
        for (const localPath of sharedLocalImagePaths) {
          await fs.unlink(localPath).catch(e => logger.warn(`Không thể xoá file tạm ${localPath}`));
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
