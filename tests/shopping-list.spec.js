const { test, expect } = require("@playwright/test");
const path = require("path");
const { randomUUID } = require("crypto");
const { pathToFileURL } = require("url");

const APP_URL = pathToFileURL(path.join(__dirname, "..", "index.html")).href;
const REST_URL = "https://ayzcqgmszkwjzkltbyxu.supabase.co/rest/v1/shopping_item**";
const LEGACY_STORAGE_KEY = "shopping-list-items";

/**
 * 실제 DB를 건드리지 않도록 Supabase REST(PostgREST) 요청을 가로채
 * 메모리 안의 가짜 테이블로 응답한다. 페이지를 새로고침해도 rows는 유지된다.
 */
async function mockSupabase(page) {
  const db = { rows: [], failNext: null, clock: Date.now() };

  const matchIds = (url) => {
    const filter = url.searchParams.get("id") || "";
    if (filter.startsWith("eq.")) return [filter.slice(3)];
    if (filter.startsWith("in.(")) {
      return filter.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
    }
    return [];
  };

  await page.route(REST_URL, async (route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());

    if (db.failNext === method) {
      db.failNext = null;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
    }

    if (method === "GET") {
      const sorted = [...db.rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sorted) });
    }

    if (method === "POST") {
      const body = req.postDataJSON();
      const inserted = (Array.isArray(body) ? body : [body]).map((row) => ({
        id: randomUUID(),
        done: false,
        created_at: new Date(db.clock++).toISOString(),
        ...row,
      }));
      db.rows.push(...inserted);
      const wantsSingle = (req.headers()["accept"] || "").includes("vnd.pgrst.object");
      const wantsRows = (req.headers()["prefer"] || "").includes("return=representation");
      if (!wantsRows) return route.fulfill({ status: 201, body: "" });
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(wantsSingle ? inserted[0] : inserted),
      });
    }

    if (method === "PATCH") {
      const ids = matchIds(url);
      const patch = req.postDataJSON();
      db.rows = db.rows.map((row) => (ids.includes(row.id) ? { ...row, ...patch } : row));
      return route.fulfill({ status: 204, body: "" });
    }

    if (method === "DELETE") {
      const ids = matchIds(url);
      db.rows = db.rows.filter((row) => !ids.includes(row.id));
      return route.fulfill({ status: 204, body: "" });
    }

    return route.fulfill({ status: 405, body: "" });
  });

  return db;
}

async function addItems(page, ...names) {
  const input = page.getByPlaceholder("살 물건을 입력하세요");
  for (const name of names) {
    await input.fill(name);
    await input.press("Enter");
    if (name.trim()) await expect(page.locator("#list li .name").last()).toHaveText(name.trim());
  }
}

const itemNames = (page) => page.locator("#list li .name");

let db;

test.beforeEach(async ({ page }) => {
  db = await mockSupabase(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("#status")).toBeHidden();
});

test.describe("추가", () => {
  test("빈 목록이면 안내 문구가 보인다", async ({ page }) => {
    await expect(page.locator("#empty")).toBeVisible();
    await expect(page.locator("#list")).toBeHidden();
    await expect(page.locator("#summary")).toHaveText("");
  });

  test("Enter로 추가하면 순서대로 목록에 나오고 DB에 저장된다", async ({ page }) => {
    await addItems(page, "우유", "계란", "사과");

    await expect(itemNames(page)).toHaveText(["우유", "계란", "사과"]);
    await expect(page.locator("#summary")).toHaveText("3개 중 0개 담음");
    expect(db.rows.map((r) => r.name)).toEqual(["우유", "계란", "사과"]);
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
    expect(db.rows.map((r) => r.name)).toEqual(["바나나"]);
  });

  test("HTML을 입력해도 코드로 실행되지 않고 글자 그대로 보인다", async ({ page }) => {
    await addItems(page, "<img src=x onerror=alert(1)>");

    await expect(itemNames(page)).toHaveText(["<img src=x onerror=alert(1)>"]);
    await expect(page.locator("#list img")).toHaveCount(0);
  });

  test("저장에 실패하면 오류를 보여주고 입력한 글자를 남겨 둔다", async ({ page }) => {
    db.failNext = "POST";
    const input = page.getByPlaceholder("살 물건을 입력하세요");
    await input.fill("우유");
    await input.press("Enter");

    await expect(page.locator("#status")).toHaveText(/추가에 실패했어요/);
    await expect(input).toHaveValue("우유");
    await expect(itemNames(page)).toHaveCount(0);
  });
});

test.describe("체크", () => {
  test("체크하면 완료 표시가 되고 DB에도 반영된다", async ({ page }) => {
    await addItems(page, "우유", "계란");
    await page.getByLabel("계란 체크").check();

    await expect(page.locator("#list li").nth(1)).toHaveClass("done");
    await expect(page.locator("#list li").nth(0)).not.toHaveClass("done");
    await expect(page.locator("#summary")).toHaveText("2개 중 1개 담음");
    await expect(page.getByRole("button", { name: "체크한 항목 모두 삭제" })).toBeVisible();
    expect(db.rows.find((r) => r.name === "계란").done).toBe(true);
  });

  test("다시 누르면 체크가 풀린다", async ({ page }) => {
    await addItems(page, "우유");
    const checkbox = page.getByLabel("우유 체크");
    await checkbox.check();
    await expect(page.locator("#summary")).toHaveText("1개 중 1개 담음");
    await checkbox.uncheck();

    await expect(checkbox).not.toBeChecked();
    await expect(page.locator("#summary")).toHaveText("1개 중 0개 담음");
    await expect(page.getByRole("button", { name: "체크한 항목 모두 삭제" })).toBeHidden();
    expect(db.rows[0].done).toBe(false);
  });

  test("체크 저장에 실패하면 체크 상태가 원래대로 돌아간다", async ({ page }) => {
    await addItems(page, "우유");
    db.failNext = "PATCH";
    await page.getByLabel("우유 체크").click();

    await expect(page.locator("#status")).toHaveText(/체크 변경에 실패했어요/);
    await expect(page.getByLabel("우유 체크")).not.toBeChecked();
    expect(db.rows[0].done).toBe(false);
  });
});

test.describe("삭제", () => {
  test("✕ 버튼을 누르면 그 아이템만 지워진다", async ({ page }) => {
    await addItems(page, "우유", "계란", "사과");
    await page.getByLabel("계란 삭제").click();

    await expect(itemNames(page)).toHaveText(["우유", "사과"]);
    await expect(page.locator("#summary")).toHaveText("2개 중 0개 담음");
    expect(db.rows.map((r) => r.name)).toEqual(["우유", "사과"]);
  });

  test("이름이 같은 아이템이 있어도 누른 것 하나만 지워진다", async ({ page }) => {
    await addItems(page, "우유", "우유");
    await page.getByLabel("우유 삭제").first().click();

    await expect(itemNames(page)).toHaveText(["우유"]);
    expect(db.rows).toHaveLength(1);
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
    await expect(page.locator("#summary")).toHaveText("3개 중 1개 담음");
    await page.getByLabel("사과 체크").check();
    await expect(page.locator("#summary")).toHaveText("3개 중 2개 담음");
    await page.getByRole("button", { name: "체크한 항목 모두 삭제" }).click();

    await expect(itemNames(page)).toHaveText(["계란"]);
    await expect(page.getByRole("button", { name: "체크한 항목 모두 삭제" })).toBeHidden();
    expect(db.rows.map((r) => r.name)).toEqual(["계란"]);
  });
});

test.describe("저장", () => {
  test("새로고침해도 DB에서 아이템과 체크 상태를 다시 불러온다", async ({ page }) => {
    await addItems(page, "우유", "계란");
    await page.getByLabel("계란 체크").check();
    await expect(page.locator("#summary")).toHaveText("2개 중 1개 담음");
    await page.getByLabel("우유 삭제").click();
    await expect(itemNames(page)).toHaveText(["계란"]);
    await page.reload();

    await expect(itemNames(page)).toHaveText(["계란"]);
    await expect(page.getByLabel("계란 체크")).toBeChecked();
    await expect(page.locator("#summary")).toHaveText("1개 중 1개 담음");
  });

  test("localStorage에 있던 기존 목록을 순서·체크 그대로 DB로 옮기고 지운다", async ({ page }) => {
    await page.evaluate((key) => {
      localStorage.setItem(key, JSON.stringify([
        { id: "a", name: "우유", done: false },
        { id: "b", name: "계란", done: true },
        { id: "c", name: "   ", done: false },
      ]));
    }, LEGACY_STORAGE_KEY);
    await page.reload();

    await expect(itemNames(page)).toHaveText(["우유", "계란"]);
    await expect(page.getByLabel("계란 체크")).toBeChecked();
    expect(db.rows.map((r) => [r.name, r.done])).toEqual([["우유", false], ["계란", true]]);
    expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_STORAGE_KEY)).toBeNull();
  });

  test("옮기기에 실패하면 localStorage를 지우지 않아 다음에 다시 시도한다", async ({ page }) => {
    await page.evaluate((key) => {
      localStorage.setItem(key, JSON.stringify([{ id: "a", name: "우유", done: false }]));
    }, LEGACY_STORAGE_KEY);
    db.failNext = "POST";
    await page.reload();

    await expect(page.locator("#empty")).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  test("깨진 localStorage 데이터는 무시하고 정상 시작한다", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, "{깨진 데이터"), LEGACY_STORAGE_KEY);
    await page.reload();

    await expect(page.locator("#empty")).toBeVisible();
    expect(db.rows).toHaveLength(0);
    await addItems(page, "우유");
    await expect(itemNames(page)).toHaveText(["우유"]);
  });

  test("목록을 불러오지 못하면 오류 안내를 보여준다", async ({ page }) => {
    db.failNext = "GET";
    await page.reload();

    await expect(page.locator("#status")).toHaveText(/목록 불러오기에 실패했어요/);
    await expect(page.locator("#empty")).toBeHidden();
  });
});
