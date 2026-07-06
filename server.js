// server.js
// ------------------------------------------------------------
// 「伺服器主導 (Authoritative Server)」架構的多人連線 Demo 後端
// - 使用 Node.js 內建 http 模組建立網頁伺服器（靜態託管 index.html）
// - 使用 ws 套件建立 WebSocket 伺服器，並「共用同一個連接埠」
// - 所有玩家的座標、大小、吃食物與吃玩家的判定，全部由「伺服器」計算與保管，
//   前端只負責「回報按鍵狀態」，這樣可以防止玩家竄改座標或體積來作弊
// ------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ------------------------------------------------------------
// 遊戲世界設定
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;   // 伺服器監聽的連接埠
const TICK_RATE = 30;                    // 每秒更新 / 廣播幾次（30 次/秒）
const TICK_INTERVAL_MS = 1000 / TICK_RATE;

const WORLD_WIDTH = 800;                 // 遊戲世界（畫布）寬度，需與前端 canvas 一致
const WORLD_HEIGHT = 600;                // 遊戲世界（畫布）高度，需與前端 canvas 一致

// ---- 質量（mass）與半徑（radius）的換算 ----
// 仿照 agar.io：用「質量」代表玩家的體積，半徑則用 sqrt(質量) 換算，
// 這樣質量倍增時，半徑不會倍增（面積跟質量成正比，符合直覺的「變大」感覺）。
const RADIUS_SCALE = 4;                  // 半徑 = RADIUS_SCALE * sqrt(質量)
function massToRadius(mass) {
  return RADIUS_SCALE * Math.sqrt(mass);
}

const STARTING_MASS = 25;                // 玩家一出生的質量
const STARTING_RADIUS = massToRadius(STARTING_MASS);

const BASE_SPEED = 200;                  // 出生大小時的移動速度（每秒像素數）
const MIN_SPEED_FACTOR = 0.4;            // 體型變大後，速度最低也不會低於基礎速度的 40%

// ---- 食物設定 ----
const FOOD_COUNT = 120;                  // 場上固定維持的食物數量
const FOOD_RADIUS = 4;                   // 食物的半徑
const FOOD_MASS = 1;                     // 吃一顆食物增加的質量

// ---- 吃玩家設定 ----
const EAT_RADIUS_RATIO = 1.15;           // 攻擊方半徑至少要是對方的 1.15 倍，才吃得掉對方

function clamp(value, min, max) {
  // 當 min > max（例如玩家半徑已經比世界還大）時，直接回傳中點，避免座標算出 NaN 或跑版
  if (min > max) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

// ------------------------------------------------------------
// 玩家狀態儲存
// players = {
//   [playerId]: { id, x, y, color, mass, input: { up, down, left, right } }
// }
// ------------------------------------------------------------
const players = {};
const clientsById = {}; // playerId -> WebSocket 連線，方便對「特定玩家」單獨送訊息

let nextPlayerId = 1; // 簡單遞增的玩家流水號，用來當作 playerId

// ------------------------------------------------------------
// 食物狀態儲存
// food = { [foodId]: { id, x, y, color } }
// ------------------------------------------------------------
const food = {};
let nextFoodId = 1;

// 隨機產生一個顏色（HSL 色彩空間，飽和度與亮度固定，只隨機色相，顏色會比較好看且不會太暗或太淺）
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 55%)`;
}

// 隨機產生一個出生點座標（用目前半徑計算，避免一出生就卡在邊界外）
function randomSpawnPosition(radius) {
  return {
    x: clamp(Math.random() * WORLD_WIDTH, radius, WORLD_WIDTH - radius),
    y: clamp(Math.random() * WORLD_HEIGHT, radius, WORLD_HEIGHT - radius),
  };
}

// 產生一顆新食物，補進 food 這個物件裡
function spawnFood() {
  const id = nextFoodId++;
  food[id] = {
    id,
    x: Math.random() * (WORLD_WIDTH - FOOD_RADIUS * 2) + FOOD_RADIUS,
    y: Math.random() * (WORLD_HEIGHT - FOOD_RADIUS * 2) + FOOD_RADIUS,
    color: randomColor(),
  };
}

// 伺服器啟動時，先把食物數量補滿
for (let i = 0; i < FOOD_COUNT; i++) {
  spawnFood();
}

// ------------------------------------------------------------
// HTTP 伺服器：負責靜態託管 index.html
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  // 這個 Demo 很單純，不管請求什麼路徑，一律回傳 index.html
  // （正式專案建議改用 express.static 或依副檔名判斷 MIME type）
  const indexPath = path.join(__dirname, 'index.html');

  fs.readFile(indexPath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('無法讀取 index.html：' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ------------------------------------------------------------
// WebSocket 伺服器：與 HTTP 伺服器「共用同一個 port」
// 作法：把現成的 http.Server 實例傳給 ws.Server 的 server 選項，
// ws 會自動監聽該 http 伺服器的 'upgrade' 事件，處理 WebSocket 交握。
// ------------------------------------------------------------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  // ---- 新玩家加入 ----
  const id = nextPlayerId++;
  const spawn = randomSpawnPosition(STARTING_RADIUS);

  const player = {
    id,
    x: spawn.x,
    y: spawn.y,
    color: randomColor(),
    mass: STARTING_MASS,
    // input 記錄「目前」四個方向鍵是否被按著，由前端持續回報、伺服器持續使用
    input: { up: false, down: false, left: false, right: false },
  };

  players[id] = player;
  clientsById[id] = ws;
  ws.playerId = id; // 把 id 掛在這個 connection 上，方便斷線時知道要刪除誰

  console.log(`[連線] 玩家 ${id} 加入，目前在線人數：${Object.keys(players).length}`);

  // 告訴這位新玩家：你的 id 是多少、世界大小是多少（讓前端可以設定 canvas 尺寸）
  ws.send(JSON.stringify({
    type: 'init',
    id,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
  }));

  // ---- 接收前端傳來的訊息 ----
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return; // 收到不合法的 JSON，直接忽略（防禦性寫法）
    }

    if (msg.type === 'input') {
      // 前端只會回報「目前按鍵狀態」（哪些方向鍵正被按著），
      // 實際座標與體型計算完全交給伺服器的遊戲迴圈（tick）處理，
      // 前端無法直接指定自己的座標或質量 -> 防止作弊。
      const p = players[id];
      if (!p) return;

      p.input.up = !!msg.up;
      p.input.down = !!msg.down;
      p.input.left = !!msg.left;
      p.input.right = !!msg.right;
    }
  });

  // ---- 玩家斷線 ----
  ws.on('close', () => {
    delete players[id];
    delete clientsById[id];
    console.log(`[斷線] 玩家 ${id} 離開，目前在線人數：${Object.keys(players).length}`);
  });

  ws.on('error', (err) => {
    console.error(`[錯誤] 玩家 ${id} 的連線發生錯誤：`, err.message);
  });
});

// 讓某個玩家「重生」：質量歸零、換一個隨機出生點（被吃掉之後呼叫）
function respawnPlayer(p) {
  p.mass = STARTING_MASS;
  const spawn = randomSpawnPosition(massToRadius(p.mass));
  p.x = spawn.x;
  p.y = spawn.y;
}

// ------------------------------------------------------------
// 遊戲主迴圈（Game Loop / Tick）
// 這是「伺服器主導」架構的核心：
// 1. 依照每個玩家目前的按鍵狀態(input)與體型，計算新座標
// 2. 判定「玩家吃食物」與「大玩家吃小玩家」，更新質量
// 3. 將座標限制在世界邊界內
// 4. 把所有玩家/食物的最新狀態廣播給每一個連線中的客戶端
// ------------------------------------------------------------
let lastTickTime = Date.now();

function gameTick() {
  const now = Date.now();
  const deltaSeconds = (now - lastTickTime) / 1000; // 這次 tick 距離上次經過幾秒
  lastTickTime = now;

  // 1. 依照 input 與目前體型更新每個玩家座標（伺服器權威計算）
  for (const id in players) {
    const p = players[id];
    const radius = massToRadius(p.mass);

    let dx = 0;
    let dy = 0;

    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;

    // 斜向移動時（例如同時按 W 和 D）做正規化，避免斜向移動速度變成 sqrt(2) 倍
    if (dx !== 0 && dy !== 0) {
      const length = Math.sqrt(dx * dx + dy * dy);
      dx /= length;
      dy /= length;
    }

    // 體型越大，移動速度越慢（但有下限，避免大到完全不能動）
    const speedFactor = clamp(STARTING_RADIUS / radius, MIN_SPEED_FACTOR, 1);
    const speed = BASE_SPEED * speedFactor;

    p.x += dx * speed * deltaSeconds;
    p.y += dy * speed * deltaSeconds;

    // 邊界限制，避免玩家跑出畫布（用目前半徑計算邊界，而不是固定方塊大小）
    p.x = clamp(p.x, radius, WORLD_WIDTH - radius);
    p.y = clamp(p.y, radius, WORLD_HEIGHT - radius);
  }

  // 2a. 判定「玩家吃食物」：距離小於玩家半徑即視為吃到
  for (const pid in players) {
    const p = players[pid];
    const radius = massToRadius(p.mass);

    for (const fid in food) {
      const f = food[fid];
      const dx = p.x - f.x;
      const dy = p.y - f.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < radius) {
        p.mass += FOOD_MASS;
        delete food[fid];
        spawnFood(); // 維持場上食物總數固定，吃一顆立刻補一顆到別的地方
      }
    }
  }

  // 2b. 判定「大玩家吃小玩家」：攻擊方半徑要夠大，且對方中心點要完全落在攻擊方範圍內
  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;

      const a = players[ids[i]]; // 攻擊方
      const b = players[ids[j]]; // 可能被吃掉的一方
      if (!a || !b) continue; // 有可能在同一個 tick 內已經被別人吃掉了

      const radiusA = massToRadius(a.mass);
      const radiusB = massToRadius(b.mass);
      if (radiusA <= radiusB * EAT_RADIUS_RATIO) continue; // 沒有大到吃得掉對方

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // 對方的圓要「整個」落在攻擊方的圓裡面，才算被吃掉（而不是擦身而過）
      if (distance < radiusA - radiusB) {
        a.mass += b.mass;

        const eatenSocket = clientsById[b.id];
        if (eatenSocket && eatenSocket.readyState === WebSocket.OPEN) {
          eatenSocket.send(JSON.stringify({ type: 'eaten', by: a.id }));
        }

        respawnPlayer(b);
      }
    }
  }

  // 3. 計算排行榜（依質量排序，取前 5 名）
  const leaderboard = Object.values(players)
    .sort((x, y) => y.mass - x.mass)
    .slice(0, 5)
    .map((p) => ({ id: p.id, mass: Math.round(p.mass) }));

  // 4. 廣播目前所有玩家與食物的狀態給每個連線中的 client
  const snapshot = {
    type: 'state',
    players: Object.values(players).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      color: p.color,
      radius: massToRadius(p.mass),
      mass: Math.round(p.mass),
    })),
    food: Object.values(food).map((f) => ({
      id: f.id,
      x: f.x,
      y: f.y,
      color: f.color,
      radius: FOOD_RADIUS,
    })),
    leaderboard,
  };
  const payload = JSON.stringify(snapshot);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

setInterval(gameTick, TICK_INTERVAL_MS);

// ------------------------------------------------------------
// 啟動伺服器
// ------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`伺服器已啟動：http://localhost:${PORT}`);
  console.log(`Tick Rate: ${TICK_RATE} 次/秒`);
});