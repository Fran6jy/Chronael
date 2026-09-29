import { expect, test, type Page } from "@playwright/test";

/** Click the centre of a square on the (white-oriented) board. */
async function clickSquare(page: Page, sq: string): Promise<void> {
  await page.locator("#board").scrollIntoViewIfNeeded();
  const box = (await page.locator("#board cg-board").boundingBox())!;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]);
  const size = box.width / 8;
  await page.mouse.click(box.x + (file + 0.5) * size, box.y + (8 - rank + 0.5) * size);
}

async function move(page: Page, from: string, to: string): Promise<void> {
  await clickSquare(page, from);
  await clickSquare(page, to);
}

test("home → tutorial → game → promotion", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Learn chess/ })).toBeVisible();

  // Tutorial: first lesson is the pawn; moving it is praised.
  await page.locator("#card-learn").click();
  await expect(page.locator("#lessons")).toBeVisible();
  await page.getByRole("button", { name: "Learn the pieces" }).click();
  await expect(page.locator("#tut-title")).toHaveText("The Pawn");
  await clickSquare(page, "e3"); // the pawn starts selected with its dots showing
  await expect(page.locator("#tut-hint")).toContainText("that's how the pawn moves");

  // Test yourself: no dots. An illegal idea is explained; the right capture passes.
  await expect(page.locator("#tut-progress")).toContainText("Test yourself");
  await expect(page.locator("#board square.move-dest")).toHaveCount(0);
  await move(page, "e4", "e5");
  await expect(page.locator("#tut-hint")).toContainText("capture one square diagonally");
  await move(page, "e4", "d5");
  await expect(page.locator("#tut-progress")).toContainText("Test passed");
  await page.locator("#tut-exit").click();

  // A real game against the engine: our move is played, the bot answers.
  await expect(page.locator("#play-panel")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("Your move.");
  await move(page, "e2", "e4");
  await expect(page.locator("#moves li").first()).toHaveText(/^e4\s+\S+/, { timeout: 30_000 });
  await expect(page.locator("#rating")).not.toBeEmpty({ timeout: 30_000 });

  // Promotion: set up a pawn on the 7th and pick a knight.
  await page.evaluate(() =>
    (window as unknown as { __chronael: { loadFen: (f: string) => void } }).__chronael.loadFen(
      "7k/1P6/8/8/8/8/8/K7 w - - 0 1",
    ),
  );
  await move(page, "b7", "b8");
  await expect(page.locator("#promotion")).toBeVisible();
  await page.getByRole("button", { name: "Promote to Knight" }).click();
  await expect(page.locator("#promotion")).toBeHidden();
  await expect(page.locator("#moves")).toContainText("b8=N");
});

test("daily puzzle opens with a goal and a streak line", async ({ page }) => {
  await page.goto("/?play=puzzle");
  await expect(page.locator("#puzzle-panel")).toBeVisible();
  await expect(page.locator("#puzzle-meta")).toContainText("Daily puzzle");
  await expect(page.locator("#puzzle-streak")).not.toBeEmpty();
  await page.locator("#puzzle-reveal").click();
  await expect(page.locator("#status")).toHaveText("Here's the solution.");
});

test("PWA assets and version endpoint are served", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).short_name).toBe("Chronael");
  const version = await request.get("/version.json");
  expect((await version.json()).build).toBeTruthy();
  expect((await request.get("/sw.js")).ok()).toBeTruthy();
  expect((await request.get("/og.png")).ok()).toBeTruthy();
});

test("lesson drill: solve, earn stars, move on", async ({ page }) => {
  await page.goto("/");
  await page.locator("#nav-lessons").click();
  await page.getByRole("button", { name: "Back-rank mate" }).click();
  await expect(page.locator("#puzzle-goal")).toContainText("Back-rank mate");
  await move(page, "a1", "a8");
  await expect(page.locator("#ex-stars span:not(.off)")).toHaveCount(3);
  await page.locator("#puzzle-next").click();
  await expect(page.locator("#puzzle-goal")).toContainText("Queen and king");
  await page.locator("#nav-progress").click();
  await expect(page.locator("#dash")).toContainText("Lessons");
});

test("rated puzzles load and show the rating", async ({ page }) => {
  await page.goto("/");
  await page.locator("#card-rated").click();
  await expect(page.locator("#puzzle-meta")).toContainText("Rated puzzle");
  await expect(page.locator("#ex-rating")).toHaveText("800");
});

test("no sideways scrolling, and About is its own page", async ({ page }) => {
  for (const path of ["/", "/#about"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await expect(page.locator("#about")).toBeVisible();
  await expect(page.locator("#home")).toBeHidden();
  await page.locator("#nav-lessons").click();
  await expect(page.locator("#lessons")).toBeVisible();
});

test("every piece sits fully inside the board", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.getElementById("install")!.hidden = false; // as when the browser offers an install
  });
  await page.locator("#start-bot").click();
  await expect(page.locator("#board piece.king.white")).toBeVisible();
  const r = await page.evaluate(() => {
    const board = document.querySelector("#board")!.getBoundingClientRect();
    // Skip the drag ghost Chessground keeps hidden in the board.
    const pieces = [...document.querySelectorAll("#board piece:not(.ghost)")].map((p) => p.getBoundingClientRect());
    return {
      inside: pieces.every((p) => p.left >= board.left - 1 && p.right <= board.right + 1),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(r.inside).toBe(true);
  expect(r.overflow).toBeLessThanOrEqual(0);
});

test("first screen: Play now is visible without scrolling and starts a game", async ({ page }) => {
  await page.goto("/");
  const play = page.locator("#hero-play");
  await expect(play).toBeInViewport();
  await play.click();
  await expect(page.locator("#status")).toHaveText("Your move.");
});

test("during a game, the coach and Hint are on screen without scrolling", async ({ page }) => {
  await page.goto("/");
  await page.locator("#hero-play").click();
  await expect(page.locator("#status")).toHaveText("Your move.");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator("#hint")).toBeInViewport();
  await expect(page.locator("#coach")).toBeInViewport();
});

test("ways to play a person are visible on the first screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero-quick")).toBeInViewport();
  await expect(page.locator("#hero-friend")).toBeInViewport();
});

test("home demo pieces sit inside the demo board", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero-board piece").first()).toBeVisible();
  const inside = await page.evaluate(() => {
    const b = document.querySelector("#hero-board")!.getBoundingClientRect();
    return [...document.querySelectorAll("#hero-board piece")]
      .map((p) => p.getBoundingClientRect())
      .every((p) => p.left >= b.left - 1 && p.right <= b.right + 1 && p.bottom <= b.bottom + 1);
  });
  expect(inside).toBe(true);
});

test("game fits the window: your player row is visible without scrolling", async ({ page }) => {
  await page.goto("/");
  await page.locator("#hero-play").click();
  await expect(page.locator("#status")).toHaveText("Your move.");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator("#row-bottom")).toBeInViewport({ ratio: 1 });
});
