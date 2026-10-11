const { test, expect } = require("@playwright/test");
const path = require("path");
const { pathToFileURL } = require("url");

const APP_URL = pathToFileURL(path.join(__dirname, "..", "index.html")).href;

async function addItems(page, ...names) {
  const input = page.getByPlaceholder("살 물건을 입력하세요");
  for (const name of names) {
    await input.fill(name);
    await input.press("Enter");
  }
}

const itemNames = (page) => page.locator("#list li .name");

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test.describe("추가", () => {
  test("빈 목록이면 안내 문구가 보인다", async ({ page }) => {
    await expect(page.locator("#empty")).toBeVisible();
    await expect(page.locator("#list")).toBeHidden();
    await expect(page.locator("#summary")).toHaveText("");
  });

  test("Enter로 아이템을 추가하면 입력한 순서대로 목록에 나온다", async ({ page }) => {
    await addItems(page, "우유", "계란", "사과");

    await expect(itemNames(page)).toHaveText(["우유", "계란", "사과"]);
    await expect(page.locator("#summary")).toHaveText("3개 중 0개 담음");
    await expect(page.locator("#empty")).toBeHidden();
  });

  test("추가 버튼으로도 추가되고, 추가 후 입력창이 비워진다", async ({ page }) => {
    const input = page.getByPlaceholder("살 물건을 입력하세요");
    await input.fill("휴지");
    await page.getByRole("button", { name: "추가" }).click();

    await expect(itemNames(page)).toHaveText(["휴지"]);
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
  });

  test("앞뒤 공백은 잘라내고, 공백만 입력하면 추가하지 않는다", async ({ page }) => {
    await addItems(page, "   ", "  바나나  ");

    await expect(itemNames(page)).toHaveText(["바나나"]);
  });

  test("HTML을 입력해도 코드로 실행되지 않고 글자 그대로 보인다", async ({ page }) => {
    await addItems(page, "<img src=x onerror=alert(1)>");

    await expect(itemNames(page)).toHaveText(["<img src=x onerror=alert(1)>"]);
    await expect(page.locator("#list img")).toHaveCount(0);
  });
});

test.describe("체크", () => {
  test("체크하면 완료 표시가 되고 진행 상황이 바뀐다", async ({ page }) => {
    await addItems(page, "우유", "계란");
    await page.getByLabel("계란 체크").check();

    await expect(page.locator("#list li").nth(1)).toHaveClass("done");
    await expect(page.locator("#list li").nth(0)).not.toHaveClass("done");
    await expect(page.locator("#summary")).toHaveText("2개 중 1개 담음");
    await expect(page.getByRole("button", { name: "체크한 항목 모두 삭제" })).toBeVisible();
  });

  test("다시 누르면 체크가 풀린다", async ({ page }) => {
    await addItems(page, "우유");
    const checkbox = page.getByLabel("우유 체크");
    await checkbox.check();
    await checkbox.uncheck();

    await expect(checkbox).not.toBeChecked();
    await expect(page.locator("#list li").first()).not.toHaveClass("done");
    await expect(page.locator("#summary")).toHaveText("1개 중 0개 담음");
    await expect(page.getByRole("button", { name: "체크한 항목 모두 삭제" })).toBeHidden();
  });
});

test.describe("삭제", () => {
  test("✕ 버튼을 누르면 그 아이템만 지워진다", async ({ page }) => {
    await addItems(page, "우유", "계란", "사과");
    await page.getByLabel("계란 삭제").click();

    await expect(itemNames(page)).toHaveText(["우유", "사과"]);
    await expect(page.locator("#summary")).toHaveText("2개 중 0개 담음");
  });

  test("이름이 같은 아이템이 있어도 누른 것 하나만 지워진다", async ({ page }) => {
    await addItems(page, "우유", "우유");
    await page.getByLabel("우유 삭제").first().click();

    await expect(itemNames(page)).toHaveText(["우유"]);
  });

  test("마지막 아이템을 지우면 빈 목록 안내가 다시 보인다", async ({ page }) => {
    await addItems(page, "우유");
    await page.getByLabel("우유 삭제").click();

    await expect(page.locator("#empty")).toBeVisible();
    await expect(page.locator("#list")).toBeHidden();
  });

  test("'체크한 항목 모두 삭제'는 체크한 것만 지운다", async ({ page }) => {
    await addItems(page, "우유", "계란", "사과");
    await page.getByLabel("우유 체크").check();
    await page.getByLabel("사과 체크").check();
    await page.getByRole("button", { name: "체크한 항목 모두 삭제" }).click();

    await expect(itemNames(page)).toHaveText(["계란"]);
    await expect(page.getByRole("button", { name: "체크한 항목 모두 삭제" })).toBeHidden();
  });
});

test.describe("저장", () => {
  test("새로고침해도 아이템과 체크 상태가 유지된다", async ({ page }) => {
    await addItems(page, "우유", "계란");
    await page.getByLabel("계란 체크").check();
    await page.getByLabel("우유 삭제").click();
    await page.reload();

    await expect(itemNames(page)).toHaveText(["계란"]);
    await expect(page.getByLabel("계란 체크")).toBeChecked();
    await expect(page.locator("#summary")).toHaveText("1개 중 1개 담음");
  });

  test("저장된 데이터가 깨져 있어도 빈 목록으로 정상 시작한다", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("shopping-list-items", "{깨진 데이터"));
    await page.reload();

    await expect(page.locator("#empty")).toBeVisible();
    await addItems(page, "우유");
    await expect(itemNames(page)).toHaveText(["우유"]);
  });
});
