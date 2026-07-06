// server.js
// ------------------------------------------------------------
// 「伺服器主導 (Authoritative Server)」架構的多人連線 Demo 後端
// - 使用 Node.js 內建 http 模組建立網頁伺服器（靜態託管 index.html）
// - 使用 ws 套件建立 WebSocket 伺服器，並「共用同一個連接埠」
// - 所有玩家的座標都由「伺服器」計算與保管，前端只負責「回報按鍵狀態」
//   這樣可以防止玩家直接竄改自己座標來作弊（Client-side cheating）
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
const PLAYER_SIZE = 20;                  // 玩家方塊邊長
const PLAYER_SPEED = 200;                // 玩家移動速度（每秒移動的像素數）

// ------------------------------------------------------------
// 玩家狀態儲存
// players = {
//   [playerId]: { id, x, y, color, input: { up, down, left, right } }
// }
// ------------------------------------------------------------
const players = {};

let nextPlayerId = 1; // 簡單遞增的玩家流水號，用來當作 playerId

// 隨機產生一個顏色（HSL 色彩空間，飽和度與亮度固定，只隨機色相，顏色會比較好看且不會太暗或太淺）
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 55%)`;
}

// 隨機產生一個出生點座標（扣掉方塊大小，避免一出生就卡在邊界外）
function randomSpawnPosition() {
  return {
    x: Math.random() * (WORLD_WIDTH - PLAYER_SIZE),
    y: Math.random() * (WORLD_HEIGHT - PLAYER_SIZE),
  };
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
  const spawn = randomSpawnPosition();

  const player = {
    id,
    x: spawn.x,
    y: spawn.y,
    color: randomColor(),
    // input 記錄「目前」四個方向鍵是否被按著，由前端持續回報、伺服器持續使用
    input: { up: false, down: false, left: false, right: false },
  };

  players[id] = player;
  ws.playerId = id; // 把 id 掛在這個 connection 上，方便斷線時知道要刪除誰

  console.log(`[連線] 玩家 ${id} 加入，目前在線人數：${Object.keys(players).length}`);

  // 告訴這位新玩家：你的 id 是多少、世界大小是多少（讓前端可以設定 canvas 尺寸）
  ws.send(JSON.stringify({
    type: 'init',
    id,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerSize: PLAYER_SIZE },
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
      // 實際座標計算完全交給伺服器的遊戲迴圈（tick）處理，
      // 前端無法直接指定自己的座標 -> 防止作弊。
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
    console.log(`[斷線] 玩家 ${id} 離開，目前在線人數：${Object.keys(players).length}`);
  });

  ws.on('error', (err) => {
    console.error(`[錯誤] 玩家 ${id} 的連線發生錯誤：`, err.message);
  });
});

// ------------------------------------------------------------
// 遊戲主迴圈（Game Loop / Tick）
// 這是「伺服器主導」架構的核心：
// 1. 依照每個玩家目前的按鍵狀態(input)，計算新座標
// 2. 將座標限制在世界邊界內
// 3. 把所有玩家的最新狀態廣播給每一個連線中的客戶端
// ------------------------------------------------------------
let lastTickTime = Date.now();

function gameTick() {
  const now = Date.now();
  const deltaSeconds = (now - lastTickTime) / 1000; // 這次 tick 距離上次經過幾秒
  lastTickTime = now;

  // 1. 依照 input 更新每個玩家座標（伺服器權威計算）
  for (const id in players) {
    const p = players[id];
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

    p.x += dx * PLAYER_SPEED * deltaSeconds;
    p.y += dy * PLAYER_SPEED * deltaSeconds;

    // 2. 邊界限制，避免玩家跑出畫布
    p.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_SIZE, p.x));
    p.y = Math.max(0, Math.min(WORLD_HEIGHT - PLAYER_SIZE, p.y));
  }

  // 3. 廣播目前所有玩家的狀態給每個連線中的 client
  const snapshot = {
    type: 'state',
    players: Object.values(players).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      color: p.color,
    })),
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
