const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const BasePublisher = require('./BasePublisher');
const logger = require('../utils/logger');
const config = require('../config');
const { downloadImage } = require('../utils/downloadImage');

class Bannha888Publisher extends BasePublisher {
  constructor() {
    super('Bannha888');
    this.tmpDir = path.join(__dirname, '../../tmp');
  }

  getDefaultHeaders() {
    return {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9,vi;q=0.8',
      'origin': 'https://bannha888.com',
      'priority': 'u=1, i',
      'referer': 'https://bannha888.com/',
      'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Cookie': config.bannha888.cookie || ''
    };
  }

  /**
   * Tải ảnh lên server Bannha888
   * @param {string} imagePath Đường dẫn file ảnh local
   * @returns {Promise<string>} URL ảnh trên CDN của Bannha888
   */
  async uploadImageToBannha888(imagePath) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(imagePath));

      const response = await axios.post('https://cms.bannha888.com/api/v1/ucp/other/upload', form, {
        headers: {
          ...this.getDefaultHeaders(),
          ...form.getHeaders()
        }
      });

      if (response.data && response.data.data && response.data.data.url) {
        return response.data.data.url;
      }
      throw new Error('Upload ảnh không thành công, format response không khớp');
    } catch (error) {
      logger.error(`Lỗi upload ảnh ${imagePath} lên Bannha888:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Phương thức publish để đăng bài
   * @param {Object} postData { title, content, price, address, images }
   */
  async publish(postData) {
    if (!config.bannha888.cookie) {
      logger.warn('[Bannha888] Không có cookie, bỏ qua nền tảng này.');
      return false;
    }

    logger.info(`[Bannha888] Bắt đầu đăng bài: ${postData.title}`);

    let uploadedImageUrls = [];
    let localImages = [];

    try {
      // 1. Tải ảnh từ URL về local
      logger.info(`[Bannha888] Đang tải ${postData.images.length} ảnh về local...`);
      for (const imageUrl of postData.images) {
        if (!imageUrl) continue;
        try {
          const localPath = await downloadImage(imageUrl, this.tmpDir);
          localImages.push(localPath);
        } catch (downloadErr) {
          logger.error(`[Bannha888] Lỗi khi tải ảnh ${imageUrl}:`, downloadErr.message);
        }
      }

      // 2. Upload ảnh local lên Bannha888
      logger.info(`[Bannha888] Đang upload ${localImages.length} ảnh lên Bannha888...`);
      for (const localImage of localImages) {
        try {
          const cdnUrl = await this.uploadImageToBannha888(localImage);
          uploadedImageUrls.push(cdnUrl);
        } catch (uploadErr) {
          // Bỏ qua ảnh lỗi, tiếp tục upload ảnh khác
        }
      }

      if (uploadedImageUrls.length === 0 && postData.images.length > 0) {
        logger.warn(`[Bannha888] Không có ảnh nào được upload thành công.`);
        // Vẫn tiếp tục đăng bài không có ảnh nếu cần, hoặc throw error tùy yêu cầu
      }

      // Xóa các ảnh local đã tải
      localImages.forEach(imgPath => {
        try {
          if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        } catch (e) { }
      });

      // 3. Chuẩn bị payload đăng tin
      // Chuẩn hóa Price (bỏ các ký tự không phải số nếu cần)
      let priceValue = String(postData.price).replace(/[^0-9]/g, '');
      if (!priceValue) priceValue = 0;

      // Chuẩn hóa Area
      let areaValue = parseFloat(String(postData.area).replace(/[^0-9.]/g, ''));
      if (isNaN(areaValue)) areaValue = 0;

      const payload = {
        "province": "01", // Tạm thời fixed Hà Nội
        "ward": "00367", // Tạm thời fixed Thanh Xuân
        "address": postData.address || "Hà Nội",
        "title": postData.title,
        "sapo": "",
        "description": postData.content,
        "category_id": 4, // Tạm thời fixed Bán nhà riêng
        "area": areaValue,
        "price": parseInt(priceValue, 10),
        "price_area": 0,
        "price_unit": "VND",
        "bedrooms": 0,
        "bathrooms": 0,
        "floors": 0,
        "road_width": 0,
        "frontage": 0,
        "lat": 0,
        "long": 0,
        "images": uploadedImageUrls,
        "vip_package_id": 0,
        "vip_duration_days": 0,
        "is_complete": true
      };

      // 4. Gửi request tạo bài đăng
      logger.info(`[Bannha888] Gửi request tạo bài đăng...`);
      const response = await axios.post('https://cms.bannha888.com/api/v1/ucp/property/post', payload, {
        headers: {
          ...this.getDefaultHeaders(),
          'content-type': 'application/json'
        }
      });

      if (response.data && response.data.status === 'success') {
        logger.info(`[Bannha888] Đăng bài thành công. ID bài viết: ${response.data.data.id}`);
        return true;
      } else {
        logger.error(`[Bannha888] Đăng bài thất bại:`, response.data);
        return false;
      }

    } catch (error) {
      logger.error(`[Bannha888] Lỗi nghiêm trọng khi đăng bài:`, error.response?.data || error.message);

      // Cleanup local images on error
      localImages.forEach(imgPath => {
        try {
          if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        } catch (e) { }
      });

      return false;
    }
  }
}

module.exports = new Bannha888Publisher();
