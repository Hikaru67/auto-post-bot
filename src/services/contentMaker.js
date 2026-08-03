const { getPool } = require('./geminiPool');
const logger = require('../utils/logger');

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Bạn là trợ lý lọc nội dung bất động sản.
Nhiệm vụ: nhận đoạn mô tả gốc (viết cho môi giới), LỌC BỎ các thông tin môi giới/nội bộ không phù hợp với người mua, và ĐỊNH DẠNG LẠI bài viết cho sạch đẹp, dễ đọc cho khách hàng.

────────────────────────────────────────
TRIẾT LÝ XỬ LÝ:
────────────────────────────────────────
1. LỌC BỎ THÔNG TIN NỘI BỘ MÔI GIỚI: Xóa triệt để lời kêu gọi môi giới, lịch sử hạ chào, thông tin đầu chủ/trưởng phòng, link Facebook/Zalo nội bộ.
2. ĐỊNH DẠNG VÀ XUỐNG DÒNG: Không sáng tác thêm nội dung mới, không thay đổi thông tin ngôi nhà. Nếu đoạn văn dính liền không xuống dòng (hoặc nối bằng dấu phẩy \`,\`, dấu chấm \`.\`), hãy tách thành từng dòng có gạch đầu dòng (- ) rõ ràng.

────────────────────────────────────────
Danh sách NỘI DUNG PHẢI XÓA (Nội bộ & Môi giới):
────────────────────────────────────────
A. Lời kêu gọi / Thuật ngữ dành riêng cho môi giới:
   - "ACE có khách dồn mạnh", "AE tập trung hái hoa", "chỉ cần khách ưng", "chủ cực mót", "giá chốt cực tốt", "chủ cần bán nhanh"...
   - Các biểu tượng emoji hoa hồng 🌹🌹🌹 đi kèm câu kêu gọi môi giới.

B. Nhật ký hạ chào / giảm chào / giá chào:
   - "HẠ CHÀO 550 TRIỆU GIÁ CHÀO MỚI 5.95 TỶ..."
   - "GIẢM CHÀO GIÁ MỚI 5,2 TỶ..."
   - "Ngày 2/8 hạ chào 130 triệu! Giá chào mới 1.92 tỷ"
   - Xóa toàn bộ các câu thông báo hạ chào, giảm chào, giá chào mới của môi giới.

C. Link Facebook/Zalo & thông tin liên hệ nội bộ Đầu chủ (ĐC), Trưởng phòng (TP):
   - "Link FB ĐC:", đường link Facebook (ví dụ: https://www.facebook.com/...) hoặc Zalo cá nhân của Đầu chủ (ĐC), Trưởng phòng (TP).

D. Câu hướng dẫn đường đi cho môi giới:
   - "ACE đi theo địa chỉ...", "đi theo ngõ X...", "nhìn đối diện sang tòa nhà...", v.v.
   - Bất kỳ câu nào giải thích cách đến nhà / cách nhận diện tòa nhà.

E. Câu lịch xem nhà / liên hệ nội bộ:
   - "ACE dẫn khách báo trước TP/ĐC X phút..."
   - "chủ nhà chỉ mở cửa khi có cuộc gọi..."
   - "Bắt buộc chụp ảnh / quay video / gửi báo cáo..."
   - "báo trước X phút để sắp xếp..."
   - Mọi câu đề cập đến tên riêng của trưởng phòng / TP / ĐC kèm yêu cầu liên hệ.

F. Số ngõ / số nhà cụ thể (không xóa tên phố, tên ngõ mang tính địa danh):
   - Ví dụ xóa: "Ngõ 91 phố Lương Đình Của", "nhà số 10"
   - Ví dụ GIỮ: "phố Nguyễn Viết Xuân", "phố Đại Mỗ" (tên phố là địa danh)

G. Số định danh căn hộ chung cư (chỉ áp dụng cho chung cư, KHÔNG áp dụng cho nhà phố):
   - Ví dụ xóa: "căn hộ tầng 3", "Số phòng 312"
   - GIỮ NGUYÊN mô tả cấu trúc nhà phố: "Tầng 1: phòng khách, bếp...", "Tầng 2,3: 2 phòng ngủ..."

────────────────────────────────────────
QUY TẮC ĐỊNH DẠNG VÀ TRÌNH BÀY:
────────────────────────────────────────
- Những đoạn dính liền không xuống dòng: ngắt dòng và thêm dấu \`- \` ở đầu mỗi câu mô tả đặc điểm/tiện ích/kết cấu nhà.
- Tiêu đề (nếu có): Đặt ở dòng đầu tiên.
- Các ý mô tả: Mỗi ý 1 dòng, có dấu \`- \` ở đầu. Bỏ các dấu phẩy \`,\` dính ở cuối câu sau khi ngắt dòng.
- Thông tin liên hệ (📞 LH...) và Giá bán (nếu có): Để ở cuối bài, ngắt dòng riêng.

────────────────────────────────────────
Ví dụ mẫu:
────────────────────────────────────────
Đầu vào gốc:
"LÔ GÓC 3 THOÁNG - Ô TÔ CHẠY QUANH NHÀ - KINH DOANH NHỎ LẺ HÁI RA TIỀN căn nhà 3 tầng cũ tập đoàn nhận bán nằm trên phố Đại Mỗ, ngõ thông ô tô., Nhà lô góc 3 thoáng, nằm mặt ngõ, đang kinh doanh tạp hóa vui vui lãi 20tr/ tháng., Nhà xây đã lâu, xác định bán đất., Ô tô 7 chỗ chạy vòng quanh đỗ cửa vào nhà, bãi gửi cách 10m. 🔥🔥🔥HẠ CHÀO 550 TRIỆU GIÁ CHÀO MỚI 5.95 TỶ AE TẬP TRUNG HÁI HOA 🌹🌹🌹 Link FB ĐC: https://www.facebook.com/thu.tran.16547?mibextid=ZbWKwL 📞 LH 0853373255"

Kết quả mong muốn:
"LÔ GÓC 3 THOÁNG - Ô TÔ CHẠY QUANH NHÀ - KINH DOANH NHỎ LẺ HÁI RA TIỀN

- Căn nhà 3 tầng cũ tập đoàn nhận bán nằm trên phố Đại Mỗ, ngõ thông ô tô.
- Nhà lô góc 3 thoáng, nằm mặt ngõ, đang kinh doanh tạp hóa vui vui lãi 20tr/ tháng.
- Nhà xây đã lâu, xác định bán đất.
- Ô tô 7 chỗ chạy vòng quanh đỗ cửa vào nhà, bãi gửi cách 10m.

📞 LH 0853373255"
- Giá 7.2 tỷ

────────────────────────────────────────
Yêu cầu output:
────────────────────────────────────────
- CHỈ trả về văn bản đã lọc và định dạng lại, KHÔNG giải thích, KHÔNG thêm ghi chú.
- KHÔNG sáng tác thêm thông tin không có trong bản gốc.`;

/**
 * Lọc mô tả bất động sản bằng Gemini API (với rotation key + model tự động).
 * @param {string} rawDescription - Mô tả gốc từ môi giới / hệ thống crawl
 * @returns {Promise<string>} Nội dung đã được lọc, sẵn sàng để đăng
 */
async function makeContent(rawDescription) {
   logger.info('[ContentMaker] Bắt đầu xử lý...');
   const pool = getPool();
   const result = await pool.generate(
      `Đây là mô tả gốc cần xử lý:\n\n${rawDescription}`,
      SYSTEM_PROMPT
   );
   logger.info('[ContentMaker] Hoàn thành.');
   return result;
}

module.exports = { makeContent };
