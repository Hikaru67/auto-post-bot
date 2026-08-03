/**
 * geminiPool.js
 *
 * Quản lý rotation API key + model cho Gemini API.
 *
 * Chiến lược:
 *   1. Thử model hiện tại với key hiện tại.
 *   2. Nếu 429 → xoay sang model tiếp theo (cùng key).
 *   3. Hết model của key hiện tại → chuyển sang key tiếp theo (reset model list).
 *   4. Hết tất cả key → throw lỗi.
 *
 * Proactive throttle:
 *   - Sau mỗi REQUESTS_BEFORE_SLEEP request trong 1 phút → sleep để tránh chạm RPM.
 *
 * Config qua env:
 *   GEMINI_API_KEYS  = "key1,key2,key3"   (hoặc dùng GEMINI_API_KEY đơn)
 *   GEMINI_MODELS    = "model1,model2,..." (tuỳ chọn, mặc định dùng danh sách miễn phí)
 */

const axios = require('axios');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Default: các model miễn phí (Text-out), sắp xếp theo RPD cao trước ─────
const DEFAULT_MODELS = [
  'gemini-3.1-flash-lite', // RPM 15, RPD 500 ← ưu tiên đầu
  'gemini-3.5-flash-lite', // RPM 15, RPD 500
  'gemini-2.5-flash-lite', // RPM 10, RPD 20
  'gemini-2.5-flash',      // RPM 5,  RPD 20
  'gemini-3.0-flash',        // RPM 5,  RPD 20
  'gemini-3.5-flash',      // RPM 5,  RPD 20
  'gemini-3.6-flash',      // RPM 5,  RPD 20
];

// Số request liên tiếp trước khi sleep (proactive throttle)
const REQUESTS_BEFORE_SLEEP = 3;
const SLEEP_MS = 30_000; // 30s — đủ để reset cửa sổ 1 phút của Gemini
const ROTATE_SLEEP_MS = 5_000; // sleep ngắn khi xoay model sau 429

class GeminiPool {
  /**
   * @param {string[]} apiKeys  - Mảng API key
   * @param {string[]} models   - Mảng tên model (mỗi key đều thử toàn bộ)
   */
  constructor(apiKeys, models = DEFAULT_MODELS) {
    if (!apiKeys || apiKeys.length === 0) {
      throw new Error('[GeminiPool] Cần ít nhất 1 API key.');
    }
    if (!models || models.length === 0) {
      throw new Error('[GeminiPool] Cần ít nhất 1 model.');
    }

    this._originalModels = [...models];

    // Mỗi slot: { key, remainingModels[] }
    // remainingModels là bản copy riêng cho mỗi key → xoay model độc lập
    this.slots = apiKeys.map((key) => ({
      key,
      remainingModels: [...models],
    }));

    this.currentSlotIndex = 0;

    // Proactive throttle state
    this._reqCount = 0;
    this._windowStart = Date.now();
  }

  // ─── Internal: lấy slot hiện tại còn model ──────────────────────────────

  _getActiveSlot() {
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.currentSlotIndex + i) % this.slots.length;
      if (this.slots[idx].remainingModels.length > 0) {
        this.currentSlotIndex = idx;
        return this.slots[idx];
      }
    }
    return null; // Hết tất cả
  }

  // ─── Internal: xoay sau khi gặp 429 ─────────────────────────────────────

  _rotateModel(reason) {
    const slot = this.slots[this.currentSlotIndex];
    const failed = slot.remainingModels.shift(); // loại model đang dùng

    if (slot.remainingModels.length > 0) {
      logger.warn(
        `[GeminiPool] ${reason} – key=...${slot.key.slice(-6)}, model="${failed}"` +
        ` → thử model tiếp: "${slot.remainingModels[0]}"`
      );
    } else {
      logger.warn(
        `[GeminiPool] ${reason} – key=...${slot.key.slice(-6)}, model="${failed}"` +
        ` → hết model cho key này, chuyển key tiếp theo`
      );
      this.currentSlotIndex = (this.currentSlotIndex + 1) % this.slots.length;
    }
  }

  // ─── Internal: proactive throttle ───────────────────────────────────────

  async _throttle() {
    const now = Date.now();
    if (now - this._windowStart >= 60_000) {
      this._reqCount = 0;
      this._windowStart = now;
    }
    this._reqCount++;

    if (this._reqCount > 1 && (this._reqCount - 1) % REQUESTS_BEFORE_SLEEP === 0) {
      logger.info(
        `[GeminiPool] Đã ${this._reqCount - 1} request – sleep ${SLEEP_MS / 1000}s để tránh RPM limit...`
      );
      await sleep(SLEEP_MS);
      // Reset window sau sleep
      this._reqCount = 1;
      this._windowStart = Date.now();
    }
  }

  // ─── Public: gọi Gemini với rotation tự động ────────────────────────────

  /**
   * @param {string} userPrompt       - Nội dung user gửi
   * @param {string} [systemPrompt]   - System instruction (tuỳ chọn)
   * @param {object} [genConfig]      - Override generationConfig
   * @returns {Promise<string>}
   */
  async generate(userPrompt, systemPrompt = null, genConfig = {}) {
    await this._throttle();

    while (true) {
      const slot = this._getActiveSlot();
      if (!slot) {
        throw new Error(
          '[GeminiPool] Đã hết tất cả API key và model. Không thể gọi Gemini.'
        );
      }

      const model = slot.remainingModels[0];
      const { key } = slot;
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
        `:generateContent?key=${key}`;

      const body = {
        ...(systemPrompt
          ? { system_instruction: { parts: [{ text: systemPrompt }] } }
          : {}),
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          ...genConfig,
        },
      };

      try {
        logger.info(`[GeminiPool] → model="${model}", key=...${key.slice(-6)}`);
        const resp = await axios.post(url, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60_000,
        });

        const text =
          resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          const reason = resp.data?.candidates?.[0]?.finishReason;
          throw new Error(`Gemini trả về text rỗng (finishReason=${reason})`);
        }

        logger.info(
          `[GeminiPool] ✅ OK – model="${model}", ${text.length} ký tự`
        );
        return text.trim();
      } catch (err) {
        const status = err.response?.status;
        const isRateLimit =
          status === 429 ||
          err.response?.data?.error?.code === 429 ||
          err.response?.data?.error?.status === 'RESOURCE_EXHAUSTED';
        const isNotFound = status === 404;

        if (isRateLimit) {
          this._rotateModel('429 Rate limit');
          logger.info(`[GeminiPool] Chờ ${ROTATE_SLEEP_MS / 1000}s trước khi thử lại...`);
          await sleep(ROTATE_SLEEP_MS);
          continue;
        }

        if (isNotFound) {
          // Model không tồn tại / không hỗ trợ → bỏ qua, thử model khác ngay
          this._rotateModel('404 Model not found');
          continue;
        }

        // Lỗi khác → ném ra ngoài
        if (err.response) {
          const detail =
            err.response.data?.error?.message ||
            JSON.stringify(err.response.data);
          throw new Error(`Gemini HTTP ${status}: ${detail}`);
        }
        throw err;
      }
    }
  }

  /** Thông tin trạng thái pool (dùng để debug) */
  getStatus() {
    return this.slots.map((s, i) => ({
      index: i,
      active: i === this.currentSlotIndex,
      key: `...${s.key.slice(-6)}`,
      remainingModels: s.remainingModels,
    }));
  }
}

// ─── Singleton factory từ env ─────────────────────────────────────────────────

let _pool = null;

function getPool() {
  if (_pool) return _pool;

  // Hỗ trợ cả GEMINI_API_KEYS (danh sách) lẫn GEMINI_API_KEY (đơn)
  const rawKeys =
    process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = rawKeys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const rawModels = process.env.GEMINI_MODELS || '';
  const models = rawModels
    ? rawModels.split(',').map((m) => m.trim()).filter(Boolean)
    : DEFAULT_MODELS;

  _pool = new GeminiPool(keys, models);

  logger.info(
    `[GeminiPool] Khởi tạo: ${keys.length} key × ${models.length} model` +
    ` = ${keys.length * models.length} slot(s) có thể dùng.`
  );

  return _pool;
}

/** Reset pool (dùng trong test) */
function resetPool() {
  _pool = null;
}

module.exports = { GeminiPool, getPool, resetPool, DEFAULT_MODELS };
