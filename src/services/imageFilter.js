/**
 * imageFilter.js
 *
 * Service lọc danh sách URL ảnh bất động sản bằng Gemini Vision API.
 *
 * Tiêu chí loại bỏ:
 *   1. HAS_TEXT   – Ảnh chứa số nhà, số phòng, tên đường/ngõ
 *   2. USELESS    – Ảnh vô tri: tường trống, tranh treo, đồ vật không liên quan
 *   3. ALLEY_ROAD – Ảnh ngõ, đường dẫn vào nhà (không phải nội/ngoại thất ngôi nhà)
 *   4. DUPLICATE  – Ảnh trùng hoặc rất tương tự ảnh khác trong tập (giữ ảnh đầu tiên)
 *
 * Chiến lược batch:
 *   - ≤ MAX_SINGLE_BATCH ảnh → gửi 1 request duy nhất (duplicate detection hoàn hảo)
 *   - >  MAX_SINGLE_BATCH ảnh → chia batch, mỗi batch overlap BATCH_OVERLAP ảnh cuối
 *     của batch trước làm anchor để Gemini so sánh duplicate cross-batch
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { GeminiPool } = require('./geminiPool');

// ─── Vision-capable models (multimodal) ──────────────────────────────────────
const VISION_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-2.0-flash'
];

const MAX_SINGLE_BATCH = 6;  // Dưới ngưỡng này → 1 request (giữ nhỏ để tránh payload quá lớn)
const BATCH_SIZE = 20;        // Kích thước batch khi phải chia
const BATCH_OVERLAP = 1;     // Số ảnh anchor overlap giữa các batch
const DOWNLOAD_CONCURRENCY = 5;
const VISION_ROTATE_SLEEP_MS = 20_000; // Sleep sau 429 trước khi thử model tiếp
const VISION_RETRY_SLEEP_MS = 30_000;  // Sleep trước khi retry cùng model

// ─── Singleton vision pool ────────────────────────────────────────────────────
let _visionPool = null;

function getVisionPool() {
  if (_visionPool) return _visionPool;

  const rawKeys =
    process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = rawKeys.split(',').map((k) => k.trim()).filter(Boolean);

  const rawModels = process.env.GEMINI_VISION_MODELS || '';
  const models = rawModels
    ? rawModels.split(',').map((m) => m.trim()).filter(Boolean)
    : VISION_MODELS;

  _visionPool = new GeminiPool(keys, models);
  logger.info(
    `[ImageFilter] Vision pool: ${keys.length} key × ${models.length} model`
  );
  return _visionPool;
}

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Bạn là hệ thống phân loại ảnh bất động sản.
Nhiệm vụ: xem từng ảnh được đánh số [1], [2], ... và quyết định GIỮ hoặc LOẠI.

TIÊU CHÍ LOẠI BỎ (loại nếu ảnh thuộc bất kỳ tiêu chí nào):
1. HAS_TEXT   – Ảnh có chứa số nhà, số phòng, tên đường, tên ngõ (dạng text/biển hiệu nhìn thấy trong ảnh)
2. USELESS    – Ảnh vô nghĩa với người mua: chụp mỗi bức tường trống, tranh treo tường, đồ vật lặt vặt không liên quan đến ngôi nhà
3. ALLEY_ROAD – Ảnh chụp ngõ đi vào nhà, đường/hẻm dẫn đến nhà (không phải mặt tiền hay nội thất ngôi nhà)
4. DUPLICATE  – Ảnh rất giống hoặc gần giống ảnh khác trong danh sách (chụp cùng góc, cùng phòng, chỉ lệch nhau chút): chỉ GIỮ ảnh xuất hiện trước, LOẠI các ảnh sau

GIỮ LẠI các ảnh:
- Nội thất: phòng khách, phòng ngủ, bếp, nhà vệ sinh, cầu thang, sân thượng
- Ngoại thất ngôi nhà: mặt tiền nhà, ban công
- Ảnh tổng quan có giá trị thông tin cao cho người mua

YÊU CẦU OUTPUT:
Trả về JSON hợp lệ, KHÔNG có markdown, KHÔNG có giải thích:
{
  "decisions": [
    { "index": 1, "keep": true,  "reason": "living room" },
    { "index": 2, "keep": false, "reason": "HAS_TEXT: has house number" },
    ...
  ]
}

Với các ảnh là anchor (được đánh dấu [ANCHOR]), chỉ dùng để so sánh duplicate, KHÔNG đưa vào decisions output.`;

// ─── Helper: tải ảnh vào memory (Buffer → base64) ────────────────────────────

/**
 * @param {string} url
 * @returns {Promise<{url: string, base64: string, mimeType: string}>}
 */
async function fetchImageAsBase64(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const mimeType =
    resp.headers['content-type']?.split(';')[0]?.trim() || 'image/jpeg';
  const base64 = Buffer.from(resp.data).toString('base64');
  return { url, base64, mimeType };
}

/**
 * Tải nhiều ảnh song song với giới hạn concurrency.
 * @param {string[]} urls
 * @returns {Promise<Array<{url, base64, mimeType}|null>>} null nếu download lỗi
 */
async function fetchBatch(urls) {
  const results = new Array(urls.length).fill(null);
  const queue = urls.map((url, i) => ({ url, i }));

  async function worker() {
    while (queue.length > 0) {
      const { url, i } = queue.shift();
      try {
        results[i] = await fetchImageAsBase64(url);
      } catch (err) {
        logger.warn(`[ImageFilter] Không tải được ảnh: ${url} – ${err.message}`);
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Helper: gọi Gemini Vision với N ảnh ─────────────────────────────────────

/**
 * @param {Array<{url, base64, mimeType}>} images  - ảnh cần phân loại
 * @param {Array<{url, base64, mimeType}>} anchors - ảnh anchor (không xuất hiện trong decisions)
 * @returns {Promise<Map<string, boolean>>} url → keep
 */
async function classifyImages(images, anchors = []) {
  const pool = getVisionPool();

  // Build multimodal parts
  const parts = [];

  // Thêm anchor trước (nếu có)
  if (anchors.length > 0) {
    parts.push({ text: 'Các ảnh sau là ANCHOR để so sánh duplicate (không cần phân loại):' });
    anchors.forEach((img, i) => {
      parts.push({ text: `[ANCHOR ${i + 1}]` });
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    });
    parts.push({ text: '\nCác ảnh cần phân loại:' });
  }

  // Thêm ảnh cần phân loại
  images.forEach((img, i) => {
    parts.push({ text: `[${i + 1}]` });
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  });

  parts.push({
    text: `\nPhân loại ${images.length} ảnh trên theo hướng dẫn. Trả về JSON.`,
  });

  // Gọi Gemini Vision trực tiếp (không qua generate() text-only)
  const result = await callVisionGemini(pool, parts);

  // Parse JSON response
  const decisions = parseDecisions(result);

  // Map index → url
  const map = new Map();
  images.forEach((img, i) => {
    const decision = decisions.find((d) => d.index === i + 1);
    if (!decision) {
      logger.warn(`[ImageFilter] Không có decision cho ảnh ${i + 1}, mặc định GIỮ`);
      map.set(img.url, true);
    } else {
      map.set(img.url, decision.keep);
      if (!decision.keep) {
        logger.info(`[ImageFilter] LOẠI [${i + 1}] ${img.url.split('/').pop()} – ${decision.reason}`);
      }
    }
  });

  return map;
}

/**
 * Gọi Gemini với multimodal parts, xử lý rotation 429/404.
 * Tương tự generate() nhưng nhận parts thay vì text đơn.
 */
async function callVisionGemini(pool, parts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  while (true) {
    const slot = pool._getActiveSlot();
    if (!slot) {
      throw new Error('[ImageFilter] Hết tất cả vision key và model.');
    }

    const model = slot.remainingModels[0];
    const { key } = slot;
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
      `:generateContent?key=${key}`;

    const body = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 },
    };

    try {
      logger.info(`[ImageFilter] → Vision model="${model}", key=...${key.slice(-6)}`);
      const resp = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120_000,
      });

      const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const reason = resp.data?.candidates?.[0]?.finishReason;
        throw new Error(`Gemini Vision trả về text rỗng (finishReason=${reason})`);
      }

      logger.info(`[ImageFilter] ✅ Vision OK – model="${model}"`);
      return text.trim();
    } catch (err) {
      const status = err.response?.status;
      const isRateLimit =
        status === 429 ||
        err.response?.data?.error?.code === 429 ||
        err.response?.data?.error?.status === 'RESOURCE_EXHAUSTED';
      const isNotFound = status === 404;

      if (isRateLimit) {
        // Thử retry cùng model 1 lần sau khi sleep dài trước khi rotate
        logger.warn(
          `[ImageFilter] 429 – model="${model}" – sleep ${VISION_RETRY_SLEEP_MS / 1000}s rồi retry cùng model...`
        );
        await sleep(VISION_RETRY_SLEEP_MS);

        // Retry cùng model
        try {
          logger.info(`[ImageFilter] Retry → Vision model="${model}"`);
          const resp2 = await axios.post(url, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120_000,
          });
          const text2 = resp2.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text2) {
            logger.info(`[ImageFilter] ✅ Retry OK – model="${model}"`);
            return text2.trim();
          }
        } catch (retryErr) {
          const retryStatus = retryErr.response?.status;
          const stillRateLimit =
            retryStatus === 429 ||
            retryErr.response?.data?.error?.code === 429 ||
            retryErr.response?.data?.error?.status === 'RESOURCE_EXHAUSTED';
          if (!stillRateLimit) throw retryErr;
          // Vẫn 429 → rotate sang model tiếp
        }

        pool._rotateModel('429 Rate limit (sau retry)');
        logger.info(`[ImageFilter] Chờ ${VISION_ROTATE_SLEEP_MS / 1000}s trước khi thử model tiếp...`);
        await sleep(VISION_ROTATE_SLEEP_MS);
        continue;
      }

      if (isNotFound) {
        pool._rotateModel('404 Model not found');
        continue;
      }

      if (err.response) {
        const detail =
          err.response.data?.error?.message || JSON.stringify(err.response.data);
        throw new Error(`Gemini Vision HTTP ${status}: ${detail}`);
      }
      throw err;
    }
  }
}

/**
 * Parse JSON từ response của Gemini (có thể có markdown code fence).
 */
function parseDecisions(raw) {
  // Strip markdown code fences nếu có
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed.decisions || [];
  } catch {
    logger.error(`[ImageFilter] Không parse được JSON:\n${raw}`);
    return [];
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Lọc danh sách URL ảnh bất động sản.
 *
 * @param {string[]} urls - Danh sách URL ảnh đầu vào
 * @returns {Promise<string[]>} Danh sách URL hợp lệ (đã lọc)
 */
async function filterImages(urls) {
  if (!urls || urls.length === 0) return [];

  logger.info(`[ImageFilter] Bắt đầu lọc ${urls.length} ảnh...`);

  // ── Bước 1: Tải tất cả ảnh về memory ───────────────────────────────────
  logger.info(`[ImageFilter] Tải ${urls.length} ảnh (concurrency=${DOWNLOAD_CONCURRENCY})...`);
  const downloaded = await fetchBatch(urls);

  // Lọc bỏ ảnh không download được
  const valid = downloaded
    .map((img, i) => (img ? img : null))
    .filter(Boolean);

  const failedUrls = urls.filter((_, i) => !downloaded[i]);
  if (failedUrls.length > 0) {
    logger.warn(`[ImageFilter] ${failedUrls.length} ảnh không tải được, bỏ qua.`);
  }

  if (valid.length === 0) return [];

  // ── Bước 2: Phân loại theo chiến lược batch ─────────────────────────────
  const resultMap = new Map(); // url → keep

  if (valid.length <= MAX_SINGLE_BATCH) {
    // Tất cả trong 1 request → duplicate detection hoàn hảo
    logger.info(`[ImageFilter] ${valid.length} ảnh ≤ ${MAX_SINGLE_BATCH} → 1 request`);
    const map = await classifyImages(valid);
    map.forEach((keep, url) => resultMap.set(url, keep));
  } else {
    // Chia batch với overlap để cross-batch duplicate detection
    logger.info(`[ImageFilter] ${valid.length} ảnh > ${MAX_SINGLE_BATCH} → chia batch (size=${BATCH_SIZE}, overlap=${BATCH_OVERLAP})`);
    let i = 0;
    let anchors = [];

    while (i < valid.length) {
      const batchImgs = valid.slice(i, i + BATCH_SIZE);
      logger.info(`[ImageFilter] Batch ${Math.ceil((i + 1) / BATCH_SIZE)}: ảnh [${i + 1}..${i + batchImgs.length}]`);

      const map = await classifyImages(batchImgs, anchors);
      map.forEach((keep, url) => resultMap.set(url, keep));

      // Lấy ảnh cuối của batch làm anchor cho batch tiếp
      anchors = batchImgs.slice(-BATCH_OVERLAP);
      i += BATCH_SIZE;
    }
  }

  // ── Bước 3: Tổng hợp kết quả ─────────────────────────────────────────
  const kept = urls.filter((url) => {
    // Ảnh không download được → loại
    if (!downloaded[urls.indexOf(url)]) return false;
    // Ảnh được giữ
    return resultMap.get(url) !== false;
  });

  logger.info(
    `[ImageFilter] Kết quả: ${kept.length}/${urls.length} ảnh hợp lệ ` +
    `(loại ${urls.length - kept.length} ảnh)`
  );

  return kept;
}

module.exports = { filterImages, getVisionPool, VISION_MODELS };
