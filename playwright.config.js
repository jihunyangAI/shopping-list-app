const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  reporter: "list",
  use: {
    // 설치된 Chrome을 사용해 별도 브라우저 다운로드 없이 실행
    channel: "chrome",
    headless: true,
  },
});
