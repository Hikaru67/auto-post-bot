class BasePublisher {
  constructor(name) {
    this.name = name;
  }

  /**
   * Phương thức publish để đăng bài
   * @param {Object} postData { content: string, images: string[] }
   */
  async publish(postData) {
    throw new Error(`Publisher ${this.name} phải implement hàm publish()`);
  }
}

module.exports = BasePublisher;
