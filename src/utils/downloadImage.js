const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

/**
 * Tải ảnh từ URL về máy ảo / máy tính để Puppeteer có thể upload
 * @param {string} url - Đường dẫn ảnh (http/https)
 * @param {string} destFolder - Thư mục lưu trữ tạm
 * @returns {Promise<string>} - Đường dẫn file local sau khi tải xong
 */
async function downloadImage(url, destFolder) {
  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  // Tạo tên file ngẫu nhiên dựa trên timestamp
  const fileName = `img_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
  const destPath = path.join(destFolder, fileName);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Không thể tải ảnh từ URL: ${url}. Status: ${response.status}`);
  }

  const fileStream = fs.createWriteStream(destPath);
  await finished(Readable.fromWeb(response.body).pipe(fileStream));

  return destPath;
}

module.exports = {
  downloadImage
};
