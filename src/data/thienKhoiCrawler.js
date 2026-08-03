'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_URL = 'https://backend.thienkhoi.com';
const TOKEN_STORE_PATH = path.resolve(__dirname, '../../tmp/thienkhoi-tokens.json');
const ENV_PATH = path.resolve(__dirname, '../../.env');
const REGION_FIXED = 'Thanh Xuân';

// ─── Token Management ─────────────────────────────────────────────────────────

/**
 * Đọc tokens từ file lưu trữ (bao gồm access_token và refresh_token)
 * @returns {{ access_token: string, refresh_token: string } | null}
 */
function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_STORE_PATH)) return null;
    const raw = fs.readFileSync(TOKEN_STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Cập nhật một biến trong file .env (dùng string replace đơn giản).
 * Chỉ thay thế giá trị của dòng KEY="...", giữ nguyên phần còn lại.
 * @param {string} key  - Tên biến (ví dụ: THIENKHOI_REFRESH_TOKEN)
 * @param {string} value - Giá trị mới
 */
function updateEnvToken(key, value) {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    let content = fs.readFileSync(ENV_PATH, 'utf8');

    // Match dòng: KEY="giá trị" hoặc KEY=giá trị (có hoặc không có ngoặc kép)
    const regex = new RegExp(`^(${key}=)["']?[^"'\\n]*["']?`, 'm');
    const newLine = `${key}="${value}"`;

    if (regex.test(content)) {
      content = content.replace(regex, newLine);
    } else {
      // Nếu chưa có key → append cuối file
      content += `\n${newLine}\n`;
    }

    fs.writeFileSync(ENV_PATH, content, 'utf8');
    logger.info(`[ThienKhoi] Đã cập nhật ${key} trong .env`);
  } catch (err) {
    logger.warn(`[ThienKhoi] Không thể cập nhật .env: ${err.message}`);
  }
}

/**
 * Lưu tokens xuống file tmp và đồng thời cập nhật lại .env
 * để refresh_token luôn mới ngay cả khi file tmp bị xóa.
 * @param {{ access_token: string, refresh_token: string }} tokens
 */
function saveTokens(tokens) {
  try {
    const dir = path.dirname(TOKEN_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    logger.info('[ThienKhoi] Đã lưu tokens mới vào tmp.');
  } catch (err) {
    logger.error('[ThienKhoi] Lỗi khi lưu tokens:', err);
  }

  // Đồng bộ refresh_token mới vào .env (seed dự phòng)
  if (tokens.refresh_token) {
    updateEnvToken('THIENKHOI_REFRESH_TOKEN', tokens.refresh_token);
  }
  // Cũng update access_token trong .env
  if (tokens.access_token) {
    updateEnvToken('THIENKHOI_ACCESS_TOKEN', tokens.access_token);
  }
}

/**
 * Gọi API refresh-token để lấy access_token mới.
 * Nếu thành công → lưu tokens mới và trả về access_token.
 * @param {string} refreshToken
 * @returns {Promise<string>} access_token mới
 */
async function refreshAccessToken(refreshToken) {
  logger.info('[ThienKhoi] Đang làm mới access token...');
  try {
    const resp = await axios.post(
      `${BASE_URL}/auth/v1/auth/refresh-token`,
      {
        refresh_token: refreshToken,
        appLogin: 'nguonhang',
        platform: 'web',
      },
      {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: 'https://proptech.thienkhoi.com',
          referer: 'https://proptech.thienkhoi.com/',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        },
      }
    );
    const { access_token, refresh_token: newRefreshToken } = resp.data.data;
    console.log(resp.data)
    saveTokens({ access_token, refresh_token: newRefreshToken });
    logger.info('[ThienKhoi] Làm mới token thành công.');

    return access_token;
  } catch (error) {
    console.log(error.response.data.message);
    process.exit(1);
  }
}

/**
 * Trả về access_token hợp lệ.
 * Ưu tiên: file lưu → env → throw error.
 * Nếu access_token trong env đã hết hạn, dùng refresh_token để lấy mới.
 * @returns {Promise<string>}
 */
async function getValidAccessToken() {
  // 1. Thử load từ file (token đã refresh trước đó)
  const stored = loadTokens();
  if (stored && stored.access_token) {
    return stored.access_token;
  }

  // 2. Nếu chưa có file, thử dùng THIENKHOI_REFRESH_TOKEN từ .env để refresh
  const envRefreshToken = process.env.THIENKHOI_REFRESH_TOKEN;
  if (envRefreshToken) {
    return await refreshAccessToken(envRefreshToken);
  }

  // 3. Fallback: dùng thẳng THIENKHOI_ACCESS_TOKEN từ .env (token ban đầu)
  const envAccessToken = process.env.THIENKHOI_ACCESS_TOKEN;
  if (envAccessToken) {
    logger.warn('[ThienKhoi] Dùng access token từ .env — có thể đã hết hạn.');
    return envAccessToken;
  }

  throw new Error(
    '[ThienKhoi] Không tìm thấy token. Hãy set THIENKHOI_REFRESH_TOKEN hoặc THIENKHOI_ACCESS_TOKEN trong .env'
  );
}

// ─── HTTP Client (with auto-retry on 401) ────────────────────────────────────

/**
 * Tạo Axios headers chuẩn cho API Thiên Khôi
 * @param {string} accessToken
 */
function buildHeaders(accessToken) {
  return {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9,vi;q=0.8',
    authorization: `Bearer ${accessToken}`,
    origin: 'https://proptech.thienkhoi.com',
    referer: 'https://proptech.thienkhoi.com/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  };
}

/**
 * Gọi API với auto refresh token khi gặp lỗi 401.
 * @param {() => Promise<any>} requestFn - hàm trả về promise axios
 * @returns {Promise<any>}
 */
async function callWithAutoRefresh(requestFn) {
  try {
    return await requestFn();
  } catch (err) {
    // 401 Unauthorized → token hết hạn → thử refresh
    if (err.response && err.response.status === 401) {
      logger.warn('[ThienKhoi] Token hết hạn (401). Đang thử refresh...');
      const stored = loadTokens();
      const refreshToken =
        (stored && stored.refresh_token) || process.env.THIENKHOI_REFRESH_TOKEN;

      if (!refreshToken) {
        throw new Error('[ThienKhoi] Không có refresh_token để làm mới. Vui lòng cập nhật .env.');
      }

      const newAccessToken = await refreshAccessToken(refreshToken);
      // Retry request với token mới
      return await requestFn(newAccessToken);
    }
    throw err;
  }
}

// ─── API Calls ────────────────────────────────────────────────────────────────

/**
 * Lấy danh sách bất động sản (phân trang).
 * @param {number} page
 * @param {number} limit
 * @param {string} accessToken
 * @returns {Promise<{ data: Array, total: number, totalPages: number }>}
 */
async function fetchPropertyList(page = 1, limit = 20, accessToken) {
  const token = accessToken || (await getValidAccessToken());

  const doRequest = async (tkn = token) => {
    const resp = await axios.get(`${BASE_URL}/product/v1/property`, {
      params: { page, limit, searchBy: 'address' },
      headers: buildHeaders(tkn),
    });
    return resp.data.data;
  };

  return callWithAutoRefresh(doRequest);
}

/**
 * Lấy chi tiết một bất động sản theo id.
 * @param {string} propertyId
 * @param {string} accessToken
 * @returns {Promise<Object>} raw detail data
 */
async function fetchPropertyDetail(propertyId, accessToken) {
  const token = accessToken || (await getValidAccessToken());

  const doRequest = async (tkn = token) => {
    const resp = await axios.get(`${BASE_URL}/product/v1/property/${propertyId}`, {
      headers: buildHeaders(tkn),
    });
    return resp.data.data;
  };

  return callWithAutoRefresh(doRequest);
}

// ─── Data Transform ──────────────────────────────────────────────────────────

/**
 * Lọc và làm sạch danh sách media:
 * - Chỉ lấy type === 'property_image'
 * - Bỏ phần tử đầu và cuối
 * - Strip query string (bỏ phần từ '?' trở đi)
 * @param {Array} media
 * @returns {string[]} mảng URL sạch
 */
function parseMediaUrls(media) {
  if (!Array.isArray(media) || media.length === 0) return [];

  const propertyImages = media.filter((item) => item.type === 'property_image');

  // Bỏ phần tử đầu và cuối nếu có đủ ít nhất 3 ảnh
  const sliced = propertyImages.length > 2 ? propertyImages.slice(1, -1) : propertyImages;

  return sliced.map((item) => item.url.split('?')[0]);
}

/**
 * Transform dữ liệu từ API sang format Google Sheet.
 * @param {Object} listItem - item từ API danh sách (có media, offeringPrice, street, area, id)
 * @param {Object} detailData - item từ API detail (có description)
 * @returns {Object} propertyRow
 */
function parsePropertyData(listItem, detailData) {
  const description = detailData?.description || '';
  const title = description.split('\n')[0].trim(); // Dòng đầu tiên

  const mediaUrls = parseMediaUrls(listItem.media);

  return {
    Id: listItem.id,
    Title: title,
    Content: description + '\n' + `Giá: ${Math.round((listItem.offeringPrice || 0) * 1_000_000_000)}` + '\n' + `LH 0853373255`,
    Region: REGION_FIXED,
    Images: mediaUrls.join(',\n'),
    Price: Math.round((listItem.offeringPrice || 0) * 1_000_000_000),
    Address: listItem.street?.name || '',
    Area: listItem.area || '',
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * Crawl nhiều trang và transform về mảng dữ liệu.
 * @param {{
 *   maxPages?: number,
 *   limit?: number,
 *   dryRun?: boolean,
 *   existingIds?: Set<string>  — các Id đã có trong sheet, sẽ bỏ qua detail API
 * }} options
 * @returns {Promise<Array>} mảng property rows đã transform
 */
async function crawlProperties({ maxPages = 1, limit = 20, dryRun = false, existingIds = new Set() } = {}) {
  const accessToken = await getValidAccessToken();
  const results = [];

  logger.info(`[ThienKhoi] Bắt đầu crawl tối đa ${maxPages} trang (limit=${limit}/trang)`);

  for (let page = 1; page <= maxPages; page++) {
    logger.info(`[ThienKhoi] Đang crawl trang ${page}/${maxPages}...`);

    let listData;
    try {
      listData = await fetchPropertyList(page, limit, accessToken);
    } catch (err) {
      logger.error(`[ThienKhoi] Lỗi khi lấy trang ${page}:`, err.response.data.message);
      break;
    }

    const items = listData?.data || [];
    if (items.length === 0) {
      logger.info(`[ThienKhoi] Trang ${page} không có dữ liệu. Dừng.`);
      break;
    }

    logger.info(`[ThienKhoi] Trang ${page}: tìm thấy ${items.length} bất động sản.`);

    for (const item of items) {
      // ✔ Kiểm tra duplicate trước — skip detail API nếu đã có trong sheet
      if (existingIds.has(item.id)) {
        logger.info(`[ThienKhoi] Bỏ qua (đã tồn tại) id=${item.id}`);
        continue;
      }

      let detailData = {};
      try {
        // Lấy detail để có description
        detailData = await fetchPropertyDetail(item.id, accessToken);
      } catch (err) {
        logger.warn(`[ThienKhoi] Không lấy được detail cho id=${item.id}: ${err.message}`);
      }

      const row = parsePropertyData(item, detailData);
      results.push(row);

      if (dryRun) {
        logger.info(`[ThienKhoi][DRY-RUN] ${row.Id} | ${row.Title?.substring(0, 60)}`);
      }
    }

    // Dừng sớm nếu đây là trang cuối
    if (page >= listData.totalPages) {
      logger.info(`[ThienKhoi] Đã crawl hết tất cả ${listData.totalPages} trang.`);
      break;
    }

    // Delay nhỏ tránh spam API
    await new Promise((r) => setTimeout(r, 500));
  }

  logger.info(`[ThienKhoi] Hoàn thành crawl: tổng ${results.length} bất động sản mới.`);
  return results;
}

module.exports = {
  crawlProperties,
  fetchPropertyList,
  fetchPropertyDetail,
  parsePropertyData,
  parseMediaUrls,
  loadTokens,
  saveTokens,
  refreshAccessToken,
  getValidAccessToken,
};
