/** 预览页。棋盘画布和样式从数据目录里的上游文件加载，这一页只负责点击和轮询。 */
export function boardsPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>棋盘</title>
<link id="css-chess" rel="stylesheet" href="/dsh-workbench/boards/vendor/chess-app/src/App.css" media="not all">
<link rel="stylesheet" href="/dsh-workbench/boards/vendor/gomoku/src/styles/gmk.css">
<link rel="stylesheet" href="/dsh-workbench/boards/vendor/shudan/css/goban.css">
<style>
  html, body { margin: 0; height: 100%; background: #1b1714; color: #f5f1e6; font: 14px/1.4 sans-serif; color-scheme: dark; }
  body { display: flex; flex-direction: column; min-height: 100%; }
  header { padding: 10px 12px 0; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  p.meta { margin: 4px 0 8px; color: #a79f95; }
  #stage { flex: 1; min-height: 0; padding: 0 12px 12px; }
  #prompt { margin: 8px 12px 12px; padding: 8px 10px; border: 1px solid #c9842a; border-radius: 8px; color: #f0d7b0; }
  #prompt[hidden] { display: none; }
  @media (prefers-color-scheme: light) {
    html, body { background: #f4f1ea; color: #1c1915; color-scheme: light; }
    p.meta { color: #5c564e; }
    #prompt { color: #6b3e08; background: #fff8ee; }
  }
  canvas { width: 100%; height: auto; background: #faebd7; border-radius: 8px; cursor: pointer; }
  .board { width: min(100%, 92vh); margin: 0 auto; }
  .gmk-app { max-width: none; }
  .gmk-app .gmk-board-frame { width: min(100%, 92vh); margin: 0 auto; }
  .gmk-stone-dot { position: absolute; left: 11%; top: 11%; width: 78%; height: 78%; border-radius: 50%; display: block; }
  .gmk-cell-b .gmk-stone-dot { background: radial-gradient(circle at 35% 32%, #5a5a5d, #000); }
  .gmk-cell-w .gmk-stone-dot { background: radial-gradient(circle at 35% 32%, #fff, #c8b890); }
  .go-wrap { width: min(100%, 92vh); margin: 0 auto; }
  .go-grid { position: relative; display: grid; width: 100%; aspect-ratio: 1; background: #e8b15a url("/dsh-workbench/boards/vendor/shudan/css/board.png") center/cover; border: 8px solid #ca933a; }
  .go-grid button { position: relative; z-index: 1; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; appearance: none; border: 0; background: transparent; padding: 0; cursor: pointer; }
  .go-grid img { width: 88%; height: 88%; object-fit: contain; display: block; pointer-events: none; }
  .pick { outline: 2px solid #00b3b8; outline-offset: -2px; }
</style>
</head>
<body>
<header>
  <h1 id="title">棋盘</h1>
  <p class="meta" id="meta"></p>
</header>
<div id="stage"></div>
<p id="prompt" hidden></p>
<script src="/dsh-workbench/boards/vendor/xiangqi/lib/zh-chess.browser.js"></script>
<script>
var API = "/dsh-workbench/api/boards";
var stage = document.getElementById("stage");
var title = document.getElementById("title");
var meta = document.getElementById("meta");
var promptEl = document.getElementById("prompt");
var chessCss = document.getElementById("css-chess");
var current = null;
var token = "";
var picked = null;

function showPrompt(text) {
  promptEl.hidden = !text;
  promptEl.textContent = text || "";
}
function paintHeader(session) {
  if (session.seats && session.seats.length) {
    title.textContent = session.label + " · " + session.seats.map(function (s) {
      return (s.name || s.side) + "（" + (s.side || "") + "）" + (s.status === "pending" ? "待入座" : "");
    }).join(" 对 ");
    if (session.over) meta.textContent = "终局" + (session.over.reason ? " · " + session.over.reason : "");
    else if (session.waiting && session.waiting.length) meta.textContent = "等待入座：" + session.waiting.join("、");
    else meta.textContent = "轮到 " + ((session.turnSeat && session.turnSeat.name) || (session.turn === "human" ? session.playerName : "AI"));
  } else {
    title.textContent = session.label + " · " + session.playerName + "（" + session.humanLabel + "）对 AI（" + session.aiLabel + "）";
    if (session.over) meta.textContent = "终局" + (session.over.reason ? " · " + session.over.reason : "");
    else meta.textContent = session.turn === "human" ? "轮到 " + session.playerName : "轮到 AI";
  }
  chessCss.media = session.game === "chess" ? "all" : "not all";
}
var tableKey = "";
try { tableKey = new URLSearchParams(location.search).get("key") || ""; } catch (e) { tableKey = ""; }
function sessionQuery() {
  return tableKey ? ("?key=" + encodeURIComponent(tableKey)) : "";
}
function submit(move) {
  fetch(API + "/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ move: move, key: tableKey })
  }).then(function (r) { return r.json(); }).then(function (body) {
    if (!body || body.ok === false) {
      showPrompt((body && body.error) || "这步没有落下");
      return;
    }
    var acked = false;
    function onMsg(ev) {
      if (ev.origin !== location.origin) return;
      if (!ev.data || ev.data.source !== "dsh-boards-ack") return;
      acked = true;
      window.removeEventListener("message", onMsg);
      if (ev.data.ok) showPrompt("");
      else showPrompt(body.prompt || "");
    }
    window.addEventListener("message", onMsg);
    try { parent.postMessage({ source: "dsh-boards", prompt: body.prompt, key: tableKey, roomId: (body.session && body.session.roomId) || "" }, location.origin); } catch (e) {}
    setTimeout(function () {
      window.removeEventListener("message", onMsg);
      if (!acked) showPrompt(body.prompt || "");
    }, 1600);
    apply(body.session);
  }).catch(function (e) { showPrompt(String(e && e.message || e)); });
}
function hitXiangqi(game, canvas, ev) {
  var layout = game.getDrawLayout();
  var rect = canvas.getBoundingClientRect();
  var px = (ev.clientX - rect.left) * (canvas.width / rect.width);
  var py = (ev.clientY - rect.top) * (canvas.height / rect.height);
  var x = Math.round((px - layout.startX) / layout.gridWidth);
  var y = Math.round((py - layout.startY) / layout.gridHeight);
  if (x < 0 || y < 0 || x > 8 || y > 9) return null;
  return { x: x, y: y };
}
function drawXiangqi(session) {
  stage.innerHTML = "";
  var canvas = document.createElement("canvas");
  canvas.width = 520;
  canvas.height = 576;
  stage.appendChild(canvas);
  var Ctor = window.ZhChess && (window.ZhChess.default || window.ZhChess);
  if (typeof Ctor !== "function") { stage.textContent = "中国象棋棋盘还没有载入"; return; }
  var game = new Ctor({ gameWidth: 520, gameHeight: 576, duration: 0 });
  game.gameStart("RED");
  if (session.board && session.board.fen) game.setPenCodeList(session.board.fen);
  game.draw(canvas.getContext("2d"));
  canvas.onclick = function (ev) {
    if (!current || current.turn !== "human" || current.over) return;
    var point = hitXiangqi(game, canvas, ev);
    if (!point) return;
    if (!picked) { picked = point; return; }
    var move = picked.x + "," + picked.y + "-" + point.x + "," + point.y;
    picked = null;
    submit(move);
  };
}
function drawChess(session) {
  stage.innerHTML = "";
  var board = document.createElement("div");
  board.className = "board";
  var pieces = (session.board && session.board.pieces) || {};
  var ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
  var files = ["A", "B", "C", "D", "E", "F", "G", "H"];
  ranks.forEach(function (rank) {
    files.forEach(function (file) {
      var sq = file + rank;
      var cell = document.createElement("div");
      var piece = pieces[sq] || pieces[sq.toLowerCase()] || "";
      cell.className = "field" + (piece ? " piece" + piece : "");
      if (picked === sq.toLowerCase()) cell.className += " pick";
      cell.onclick = function () {
        if (!current || current.turn !== "human" || current.over) return;
        var id = sq.toLowerCase();
        if (!picked) { picked = id; drawChess(current); return; }
        var move = picked + id;
        picked = null;
        submit(move);
      };
      board.appendChild(cell);
    });
  });
  stage.appendChild(board);
}
function svgEl(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}
function gomokuBackground() {
  var svg = svgEl("svg");
  svg.setAttribute("class", "gmk-goban-bg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  var cell = 100 / 15;
  var half = cell / 2;
  function addLine(x1, y1, x2, y2) {
    var line = svgEl("line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", "var(--gmk-grid-line)");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }
  var i, y, x;
  for (i = 0; i < 15; i++) {
    y = half + i * cell;
    addLine(half, y, 100 - half, y);
    x = half + i * cell;
    addLine(x, half, x, 100 - half);
  }
  var stars = [[3, 3], [3, 7], [3, 11], [7, 3], [7, 7], [7, 11], [11, 3], [11, 7], [11, 11]];
  for (i = 0; i < stars.length; i++) {
    var circle = svgEl("circle");
    circle.setAttribute("cx", String(half + stars[i][1] * cell));
    circle.setAttribute("cy", String(half + stars[i][0] * cell));
    circle.setAttribute("r", String(cell * 0.12));
    circle.setAttribute("fill", "var(--gmk-star-point)");
    svg.appendChild(circle);
  }
  return svg;
}
function drawGomoku(session) {
  stage.innerHTML = "";
  var app = document.createElement("div");
  app.className = "gmk-app";
  var frame = document.createElement("div");
  frame.className = "gmk-board-frame";
  var board = document.createElement("div");
  board.className = "gmk-board";
  board.style.gridTemplateColumns = "repeat(15, 1fr)";
  board.style.gridTemplateRows = "repeat(15, 1fr)";
  board.appendChild(gomokuBackground());
  var cells = (session.board && session.board.board) || [];
  for (var i = 0; i < 225; i++) {
    var value = cells[i];
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gmk-cell " + (value === "B" ? "gmk-cell-b" : value === "W" ? "gmk-cell-w" : "gmk-cell-empty");
    if (value) {
      var dot = document.createElement("span");
      dot.className = "gmk-stone-dot";
      btn.appendChild(dot);
    }
    (function (index) {
      btn.onclick = function () {
        if (!current || current.turn !== "human" || current.over) return;
        var col = index % 15;
        var row = Math.floor(index / 15);
        submit(String.fromCharCode(65 + col) + String(row + 1));
      };
    })(i);
    board.appendChild(btn);
  }
  frame.appendChild(board);
  app.appendChild(frame);
  stage.appendChild(app);
}
function goBackground(n) {
  var svg = svgEl("svg");
  svg.setAttribute("class", "shudan-grid");
  svg.setAttribute("viewBox", "0 0 " + n + " " + n);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none";
  function addLine(x1, y1, x2, y2) {
    var line = svgEl("line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", "var(--shudan-board-foreground-color, #5E2E0C)");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }
  var i;
  for (i = 0; i < n; i++) {
    addLine(0.5, i + 0.5, n - 0.5, i + 0.5);
    addLine(i + 0.5, 0.5, i + 0.5, n - 0.5);
  }
  var points = n === 19 ? [3, 9, 15] : n === 13 ? [3, 6, 9] : n === 9 ? [2, 4, 6] : [];
  var a, b, circle;
  for (a = 0; a < points.length; a++) {
    for (b = 0; b < points.length; b++) {
      circle = svgEl("circle");
      circle.setAttribute("cx", String(points[b] + 0.5));
      circle.setAttribute("cy", String(points[a] + 0.5));
      circle.setAttribute("r", "0.13");
      circle.setAttribute("fill", "var(--shudan-board-foreground-color, #5E2E0C)");
      svg.appendChild(circle);
    }
  }
  return svg;
}
function drawGo(session) {
  stage.innerHTML = "";
  var map = (session.board && session.board.signMap) || [];
  var n = map.length || 19;
  var wrap = document.createElement("div");
  wrap.className = "go-wrap shudan-goban";
  var grid = document.createElement("div");
  grid.className = "go-grid";
  grid.style.gridTemplateColumns = "repeat(" + n + ", 1fr)";
  grid.style.gridTemplateRows = "repeat(" + n + ", 1fr)";
  grid.appendChild(goBackground(n));
  var cols = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      var btn = document.createElement("button");
      btn.type = "button";
      var sign = map[y] ? map[y][x] : 0;
      if (sign === 1 || sign === -1) {
        var img = document.createElement("img");
        img.alt = "";
        img.src = "/dsh-workbench/boards/vendor/shudan/css/stone_" + sign + ".svg";
        btn.appendChild(img);
      }
      (function (xx, yy) {
        btn.onclick = function () {
          if (!current || current.turn !== "human" || current.over) return;
          submit(cols[xx] + String(n - yy));
        };
      })(x, y);
      grid.appendChild(btn);
    }
  }
  wrap.appendChild(grid);
  stage.appendChild(wrap);
}
function draw(session) {
  if (session.game === "xiangqi") drawXiangqi(session);
  else if (session.game === "chess") drawChess(session);
  else if (session.game === "gomoku") drawGomoku(session);
  else drawGo(session);
}
function signature(session) {
  return JSON.stringify({
    id: session.id,
    turn: session.turn,
    over: session.over,
    board: session.board
  });
}
function apply(session) {
  if (!session) {
    current = null;
    token = "";
    title.textContent = "没有进行中的棋局";
    meta.textContent = "";
    stage.innerHTML = "";
    return;
  }
  var next = signature(session);
  var same = next === token;
  current = session;
  paintHeader(session);
  if (!same) {
    picked = null;
    token = next;
    draw(session);
  }
}
function poll() {
  fetch(API + "/session" + sessionQuery()).then(function (r) { return r.json(); }).then(function (body) {
    if (!body || body.ok === false) return;
    apply(body.open ? body.session : null);
  }).catch(function () {});
}
poll();
setInterval(poll, 700);
</script>
</body>
</html>`
}
