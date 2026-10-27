"use strict";

/**
 * 联机内核的碰撞规则测试。
 *
 * 跑法：npm run test:game   （等价于 node --test server/game.test.js）
 *
 * 这些用例把「尾巴让位」「头对头」「尸体不害人」这些
 * 光靠肉眼很难验证的规则钉死，改内核时先跑一遍再提交。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { CONFIG } = require("./config.js");
const {
  createPlayerState,
  createRoomShell,
  stepRoom,
  buildRanking,
  enqueueDirection,
  effectiveStepMs,
  refillFood,
  initMatch,
  finishMatch,
} = require("./game.js");

/** 造一条指定形状的蛇，并且让它下一帧一定会走一格。 */
function makePlayer(id, snake, dir, extra = {}) {
  const player = createPlayerState({
    id,
    name: id,
    slot: extra.slot ?? 0,
  });

  player.snake = snake.map(([x, y]) => ({ x, y }));
  player.dir = dir;
  player.stepMs = 1;
  player.elapsedMs = 999;

  Object.assign(player, extra);
  return player;
}

function makeRoom(players, options = {}) {
  return createRoomShell(players, options);
}

/* ----------------------------- 撞墙 / 障碍 ----------------------------- */

test("撞墙判死", () => {
  const a = makePlayer("a", [[0, 5], [1, 5], [2, 5]], "left");
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.alive, false);
  assert.equal(a.deathReason, "wall");
});

test("撞障碍判死（障碍和墙同罪）", () => {
  // (9,12) 是地图上真实存在的障碍格
  const a = makePlayer("a", [[8, 12], [7, 12], [6, 12]], "right");
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.alive, false);
  assert.equal(a.deathReason, "wall");
});

/* ------------------------------- 撞自己 ------------------------------- */

test("撞到自己身体中段判死", () => {
  // 头 (5,5) 向左，正好撞上身体第 4 节 (4,5)
  const a = makePlayer("a", [[5, 5], [5, 4], [4, 4], [4, 5], [4, 6]], "left");
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.alive, false);
  assert.equal(a.deathReason, "self");
});

test("撞到自己正在让位的尾格不算死", () => {
  // 一个 2×2 的圈，头往下正好踩到尾格 (5,6)
  const a = makePlayer("a", [[5, 5], [6, 5], [6, 6], [5, 6]], "down");
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.alive, true);
  assert.deepEqual(a.snake[0], { x: 5, y: 6 });
  assert.equal(a.snake.length, 4);
});

/* ------------------------------- 撞别人 ------------------------------- */

test("A 进入 B 正在让位的尾格，A 存活", () => {
  // B 向右走，尾巴 (8,10) 会让出来；A 从下方顶进这一格
  const a = makePlayer("a", [[8, 11], [9, 11], [10, 11]], "up");
  const b = makePlayer("b", [[10, 10], [9, 10], [8, 10]], "right", { slot: 1 });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 0);

  assert.equal(a.alive, true, "A 应该踩进让位的尾格并活下来");
  assert.equal(b.alive, true);
});

test("B 本帧吃豆时尾巴不让位，A 撞上去就死", () => {
  const a = makePlayer("a", [[8, 11], [9, 11], [10, 11]], "up");
  const b = makePlayer("b", [[10, 10], [9, 10], [8, 10]], "right", { slot: 1 });
  const room = makeRoom([a, b]);

  // B 的下一格 (11,10) 有豆 → B 会变长 → 尾巴留在 (8,10)
  room.foodSet.add("11,10");

  stepRoom(room, 20, 0);

  assert.equal(a.alive, false);
  assert.equal(a.deathReason, "body");
  assert.equal(b.alive, true);
  assert.equal(b.score, 1);
});

test("两个蛇头抢同一格，双双阵亡，豆子保留", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right");
  const b = makePlayer("b", [[7, 5], [8, 5], [9, 5]], "left", { slot: 1 });
  const room = makeRoom([a, b]);

  room.foodSet.add("6,5");

  stepRoom(room, 20, 0);

  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.deathReason, "head_on");
  assert.equal(b.deathReason, "head_on");
  assert.equal(room.foodSet.has("6,5"), true, "谁都没吃到，豆子应该还在");
});

test("迎面互换蛇头，双双阵亡", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right");
  const b = makePlayer("b", [[6, 5], [7, 5], [8, 5]], "left", { slot: 1 });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 0);

  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.deathReason, "body");
  assert.equal(b.deathReason, "body");
});

test("撞到别人时记下是谁撞的", () => {
  const a = makePlayer("a", [[8, 11], [9, 11], [10, 11]], "up");
  const b = makePlayer("b", [[10, 10], [9, 10], [8, 10]], "right", { slot: 1 });
  const room = makeRoom([a, b]);

  // B 的下一格有豆 → 尾巴不让位 → A 撞死
  room.foodSet.add("11,10");

  const result = stepRoom(room, 20, 0);
  const death = result.events.find(
    (event) => event.type === "death" && event.playerId === "a",
  );

  assert.equal(a.deathReason, "body");
  assert.equal(a.deathBy, "b");
  assert.equal(death.killerId, "b");
});

test("同归于尽时也记下对手", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right");
  const b = makePlayer("b", [[7, 5], [8, 5], [9, 5]], "left", { slot: 1 });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 0);

  assert.equal(a.deathReason, "head_on");
  assert.equal(a.deathBy, "b");
  assert.equal(b.deathBy, "a");
});

test("撞墙时没有凶手", () => {
  const a = makePlayer("a", [[0, 5], [1, 5], [2, 5]], "left");
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.deathReason, "wall");
  assert.equal(a.deathBy, null);
});

/* ------------------------------- 排名 ------------------------------- */

test("全员阵亡时按分数排名", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right", { score: 3 });
  const b = makePlayer("b", [[6, 5], [7, 5], [8, 5]], "left", {
    slot: 1,
    score: 1,
  });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 0);

  const ranking = buildRanking(room);
  assert.equal(ranking.length, 2);
  assert.equal(ranking[0].id, "a");
  assert.equal(ranking[0].rank, 1);
  assert.equal(ranking[1].id, "b");
});

test("只剩一人时立即结算并判定胜者", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right");
  const b = makePlayer("b", [[0, 0], [1, 0], [2, 0]], "left", { slot: 1 });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 0);

  assert.equal(b.alive, false);
  assert.equal(room.phase, "finished");
  assert.equal(room.result.winnerId, "a");
  assert.equal(room.result.reason, "last_alive");
});

/* ------------------------------- 断线 ------------------------------- */

test("断线冻结的蛇仍然是实体，撞上去要死", () => {
  const a = makePlayer("a", [[10, 11], [9, 11], [8, 11]], "up");
  const b = makePlayer("b", [[10, 10], [11, 10], [12, 10]], "right", {
    slot: 1,
    connected: false,
    disconnectedAt: 1000,
  });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 1000);

  assert.equal(a.alive, false);
  assert.equal(a.deathReason, "body");
  assert.equal(b.alive, true, "断线者只是冻结，不该跟着死");
});

test("断线超过 30 秒判死，且尸体立刻清空不再挡路", () => {
  const a = makePlayer("a", [[10, 11], [9, 11], [8, 11]], "up");
  const b = makePlayer("b", [[10, 10], [11, 10], [12, 10]], "right", {
    slot: 1,
    connected: false,
    disconnectedAt: 0,
  });
  const room = makeRoom([a, b]);

  stepRoom(room, 20, 31_000);

  assert.equal(b.alive, false);
  assert.equal(b.deathReason, "disconnect");
  assert.equal(a.alive, true, "尸体清空后 A 应该能平安穿过");
});

/* ------------------------------- 吃豆 ------------------------------- */

test("吃豆加分、变长、每 5 个提速一档", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right", {
    stepMs: 150,
    elapsedMs: 1000,
    score: 4,
  });
  const room = makeRoom([a]);

  room.foodSet.add("6,5");

  stepRoom(room, 20, 0);

  assert.equal(a.alive, true);
  assert.equal(a.score, 5);
  assert.equal(a.snake.length, 4, "吃豆后应该长一节");
  assert.equal(a.stepMs, 142, "每 5 分提速 8ms");
  assert.equal(room.foodSet.has("6,5"), false);
});

test("食物会补到目标数量，且不与蛇身、障碍重叠", () => {
  const a = makePlayer("a", [[4, 7], [3, 7], [2, 7]], "right");
  const room = makeRoom([a], { config: { foodCount: 6 } });

  refillFood(room, { avoidSpawnArea: true });

  assert.equal(room.foodSet.size, 6);

  const snakeCells = new Set(a.snake.map((s) => `${s.x},${s.y}`));
  for (const id of room.foodSet) {
    assert.equal(snakeCells.has(id), false, "食物不能长在蛇身上");
    assert.equal(room.obstacleSet.has(id), false, "食物不能长在障碍上");
  }
});

/* ------------------------------ 输入 / 手感 ------------------------------ */

test("方向队列过滤 180 度掉头和重复方向，最多存 2 个", () => {
  const a = createPlayerState({ id: "a", name: "a", slot: 0 });
  a.dir = "right";

  assert.equal(enqueueDirection(a, "left"), false, "不能原地掉头");
  assert.equal(enqueueDirection(a, "up"), true);
  assert.equal(enqueueDirection(a, "up"), false, "同方向不重复入队");
  assert.equal(enqueueDirection(a, "down"), false, "up 的 180 度");
  assert.equal(enqueueDirection(a, "right"), true);
  assert.equal(enqueueDirection(a, "left"), false, "队列已满");
  assert.deepEqual(a.queue, ["up", "right"]);
});

test("加速把步长压到 60%，但不低于下限", () => {
  const a = createPlayerState({ id: "a", name: "a", slot: 0 });
  a.stepMs = 150;

  a.boostActive = false;
  assert.equal(effectiveStepMs(a, CONFIG), 150);

  a.boostActive = true;
  assert.equal(effectiveStepMs(a, CONFIG), 90);

  a.stepMs = 70;
  assert.equal(effectiveStepMs(a, CONFIG), 55, "70×0.6=42，被下限 55 兜住");
});

/* ------------------------------- 体力 ------------------------------- */

test("加速会消耗体力", () => {
  const a = makePlayer("a", [[15, 15], [14, 15], [13, 15]], "right", {
    stepMs: 1000,
    elapsedMs: 0,
    boosting: true,
    stamina: 100,
  });
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.boostActive, true);
  assert.ok(a.stamina < 100, "加速应该掉体力");
  assert.ok(a.stamina > 95, "20ms 只掉一点点");
});

test("体力耗尽后加速自动失效，并且开始回血", () => {
  const a = makePlayer("a", [[15, 15], [14, 15], [13, 15]], "right", {
    stepMs: 1000,
    elapsedMs: 0,
    boosting: true,
    boostActive: true,
    stamina: 0,
  });
  const room = makeRoom([a]);

  stepRoom(room, 20, 0);

  assert.equal(a.boostActive, false, "没体力就不能再加速");
  assert.ok(a.stamina > 0, "松开后体力应该回升");
});

test("不加速时体力会回满，但不会超过上限", () => {
  // stepMs 给一个巨大的值，让蛇原地不动，
  // 否则它会撞墙身亡，死人是不回体力的
  const a = makePlayer("a", [[15, 15], [14, 15], [13, 15]], "right", {
    stepMs: 100_000,
    elapsedMs: 0,
    stamina: 50,
  });
  const room = makeRoom([a]);

  // 跑 10 秒，足够回满
  for (let i = 0; i < 500; i += 1) stepRoom(room, 20, i * 20);

  assert.equal(a.alive, true);
  assert.equal(a.stamina, 100);
});

/* ------------------------------- 时间到 ------------------------------- */

test("时间到按分数排名收尾", () => {
  const a = makePlayer("a", [[15, 15], [14, 15], [13, 15]], "right", { score: 7 });
  const b = makePlayer("b", [[10, 10], [11, 10], [12, 10]], "left", {
    slot: 1,
    score: 2,
  });
  const room = makeRoom([a, b]);

  finishMatch(room, "time_up");

  assert.equal(room.phase, "finished");
  assert.equal(room.result.reason, "time_up");
  assert.equal(room.result.winnerId, "a");
  assert.equal(room.result.ranking[0].id, "a");
});

test("胜场在同一个房间里累加，重开一局不清零", () => {
  const a = makePlayer("a", [[5, 5], [4, 5], [3, 5]], "right");
  const b = makePlayer("b", [[0, 0], [1, 0], [2, 0]], "left", { slot: 1 });
  const room = makeRoom([a, b]);

  // b 撞墙 → a 获胜
  stepRoom(room, 20, 0);

  assert.equal(room.result.winnerId, "a");
  assert.equal(a.wins, 1);
  assert.equal(b.wins, 0);
  assert.equal(room.result.ranking[0].wins, 1);

  // 重开一局，胜场必须保留
  initMatch(room);

  assert.equal(a.wins, 1, "重开不该把胜场清零");
  assert.equal(b.wins, 0);
});

test("开局按座位摆到四个对称出生点", () => {
  const players = [0, 1, 2, 3].map((slot) =>
    createPlayerState({ id: `p${slot}`, name: `p${slot}`, slot }),
  );
  const room = makeRoom(players, { config: { foodCount: 6 } });

  initMatch(room);

  assert.deepEqual(
    players.map((p) => p.snake[0]),
    [
      { x: 4, y: 7 },
      { x: 22, y: 4 },
      { x: 25, y: 22 },
      { x: 7, y: 25 },
    ],
  );

  for (const player of players) {
    assert.equal(player.snake.length, 3);
    assert.equal(player.alive, true);
    assert.equal(player.score, 0);
    assert.equal(player.stamina, 100);
  }

  // 四个人应该撒 8 颗豆（min(10, 4×2)）
  assert.equal(room.foodSet.size, 8);
});
