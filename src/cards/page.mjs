import { cardTableLayout, fanLayout } from './layout.mjs'

/**
 * 右侧牌桌。只画接口返回的公开局面，不加载上游界面。
 * 座位：玩家在下方，对手顺时针（左 → 上 → 右）均匀排布；对手暗牌为小牌背扇形。
 * 手牌在最下方呈扇形，悬停（或键盘聚焦）时该牌升起放大并置顶，相邻两张轻微升起。
 */
export function cardsPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>牌桌</title>
<style>
  :root {
    --room: #0b1d15; --felt: #0c5a38; --felt-edge: #3b2a1a; --ink: #f7f1e4; --muted: #d7ecdf;
    --face: #f7f1e4; --face-ink: #1c1915; --red: #b42318; --back: #0e3a32; --gold: #d4b483;
    --tag: rgba(8, 24, 16, .78); --btn: #f4efe4; --btn-ink: #1c1915; --note: #f0d7b0;
    --shadow: 0 1px 3px rgba(0, 0, 0, .45);
    color-scheme: dark;
  }
  html[data-theme="light"] {
    --room: #eef2ee; --felt: #2f7d55; --felt-edge: #8a6a48; --ink: #1d2a22; --muted: #3d5246;
    --tag: rgba(255, 255, 255, .88); --btn: #1f5c3f; --btn-ink: #ffffff; --note: #8a4b0f;
    --shadow: 0 1px 3px rgba(0, 0, 0, .25);
    color-scheme: light;
  }
  html, body { margin: 0; height: 100%; background: var(--room); color: var(--ink); font: 14px/1.4 system-ui, "Microsoft YaHei", sans-serif; }
  body { display: flex; flex-direction: column; min-height: 100%; overflow-x: hidden; }
  header { padding: 10px 14px 0; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  p.meta { margin: 4px 0 6px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  #table { flex: 1; position: relative; min-height: 300px; margin: 0 8px; overflow: hidden; }
  .felt { position: absolute; left: 4px; right: 4px; top: 8px; border-radius: 50%; background: radial-gradient(ellipse at center, #13784b 0%, #0c5a38 70%); border: 6px solid var(--felt-edge); box-sizing: border-box; box-shadow: inset 0 0 24px rgba(0, 0, 0, .35); }
  html[data-theme="light"] .felt { background: radial-gradient(ellipse at center, #3b9a69 0%, #2f7d55 72%); }
  .center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; padding: 22% 18%; box-sizing: border-box; pointer-events: none; }
  .pile { text-align: center; }
  .pile-title { font-size: 11px; color: #e7f3ea; margin-bottom: 2px; }
  .pile-cards { display: flex; gap: 3px; justify-content: center; }
  .card { width: 32px; height: 45px; border-radius: 4px; background: var(--face); color: var(--face-ink); display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; line-height: 1; box-sizing: border-box; border: 1px solid rgba(0, 0, 0, .35); box-shadow: var(--shadow); user-select: none; overflow: hidden; }
  .card.red { color: var(--red); }
  .card.back { background: repeating-linear-gradient(45deg, var(--back) 0 3px, #15524a 3px 6px); border: 1.5px solid var(--gold); color: var(--gold); }
  .card.mini { width: 16px; height: 23px; border-radius: 2px; font-size: 8px; }
  .card.mini.back { border-width: 1px; }
  .seat { position: absolute; width: 96px; margin-left: -48px; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
  .mini-fan { position: relative; width: 96px; height: 32px; }
  .mini-fan.faces { height: 50px; }
  .mini-fan .card { position: absolute; left: 0; top: 0; transform-origin: 50% 100%; }
  .seat-name { display: flex; gap: 4px; align-items: center; max-width: 100%; padding: 1px 6px; border-radius: 9px; background: var(--tag); color: var(--ink); font-size: 11px; white-space: nowrap; }
  .seat-name span { overflow: hidden; text-overflow: ellipsis; }
  .seat-name b { font-weight: 600; color: var(--muted); }
  .hand { position: absolute; left: 0; right: 0; bottom: 0; height: 118px; display: flex; flex-direction: column; align-items: center; }
  .hand .seat-name.me { margin-top: 2px; z-index: 1; }
  .team-tag { flex: none; font-style: normal; padding: 0 5px; border-radius: 7px; font-size: 10px; font-weight: 700; line-height: 15px; color: #fff; background: var(--team-0); }
  .team-tag.t1 { background: var(--team-1); }
  .team-tag.t2 { background: var(--team-2); }
  html { --team-0: #3b7be0; --team-1: #e08a32; --team-2: #9a66dc; }
  html[data-theme="light"] { --team-0: #1f5fc4; --team-1: #b8641a; --team-2: #7442b8; }
  .fan { position: relative; flex: 1; width: 100%; }
  .fan .card {
    position: absolute; left: 0; bottom: 14px; transform-origin: 50% 120%;
    --lift: 0px; --scale: 1;
    transform: translate(var(--x, 0px), calc(var(--y, 0px) - var(--lift))) rotate(var(--rot, 0deg)) scale(var(--scale));
    cursor: default; outline: none;
  }
  .fan.ready .card { transition: transform .16s ease-out, box-shadow .16s ease-out; }
  .fan .card.near { --lift: 7px; --scale: 1.12; }
  .fan .card.lift, .fan .card:focus-visible { --lift: 26px; --scale: 1.9; z-index: 100 !important; box-shadow: 0 6px 14px rgba(0, 0, 0, .5); }
  .fan .card:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  .fan .card.playable { cursor: pointer; }
  .fan .card.dim { filter: brightness(.55) saturate(.6); }
  .fan .card.sel { --sel: 16px; box-shadow: 0 0 0 2px var(--gold), 0 4px 10px rgba(0, 0, 0, .5); }
  .fan .card { transform: translate(var(--x, 0px), calc(var(--y, 0px) - var(--lift) - var(--sel, 0px))) rotate(var(--rot, 0deg)) scale(var(--scale)); }
  .draw-pile { position: absolute; left: 10px; bottom: 22px; z-index: 120; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 0; background: none; color: var(--ink); cursor: pointer; font-size: 11px; }
  .draw-pile .card { width: 36px; height: 50px; position: relative; }
  .draw-pile .card::after { content: ""; position: absolute; left: 3px; top: -3px; width: 100%; height: 100%; border-radius: 4px; border: 1.5px solid var(--gold); background: inherit; z-index: -1; }
  .draw-pile:hover .card, .draw-pile:focus-visible .card { transform: translateY(-4px); box-shadow: 0 0 0 2px var(--gold); }
  .draw-pile.keep .card { opacity: .6; }
  .fan .card.drawn { box-shadow: 0 0 0 2px #f0d7b0, 0 4px 10px rgba(0, 0, 0, .5); }
  .draw-pile span { padding: 1px 6px; border-radius: 9px; background: var(--tag); }
  .chooser { position: absolute; left: 50%; bottom: 128px; transform: translateX(-50%); z-index: 200; display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-radius: 10px; background: var(--tag); box-shadow: 0 4px 14px rgba(0, 0, 0, .5); }
  .chooser button.card { width: 34px; height: 48px; padding: 0; cursor: pointer; font-size: 11px; }
  .chooser button.card:hover, .chooser button.card:focus-visible { transform: translateY(-4px); outline: 2px solid var(--gold); }
  .chooser .x { padding: 4px 8px; font-size: 12px; }
  .turn-note { color: var(--note); font-size: 12px; align-self: center; }
  @media (prefers-reduced-motion: reduce) { .fan .card { transition: none; } }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 6px 14px 12px; }
  button, select { font: inherit; padding: 7px 14px; border-radius: 8px; border: 0; background: var(--btn); color: var(--btn-ink); }
  button:disabled { opacity: 0.45; }
  #prompt { margin: 0 14px 12px; color: var(--note); }
  #prompt:empty { display: none; }
</style>
</head>
<body>
<header>
  <h1 id="title">牌桌</h1>
  <p class="meta" id="meta"></p>
</header>
<div id="table"></div>
<div class="actions" id="actions"></div>
<p id="prompt"></p>
<script>
var API = "/dsh-workbench/api/cards";
var tableKey = "";
try { tableKey = new URLSearchParams(location.search).get("key") || ""; } catch (e) { tableKey = ""; }
function sessionQuery() { return tableKey ? ("?key=" + encodeURIComponent(tableKey)) : ""; }
var title = document.getElementById("title");
var meta = document.getElementById("meta");
var table = document.getElementById("table");
var actions = document.getElementById("actions");
var promptEl = document.getElementById("prompt");
var seen = "";
var last = null;
var lastJson = "";
var TONE = { r: "#b42318", g: "#1f7a4d", b: "#1d4e89", y: "#c4a035" };
var UNO_WHEEL = "conic-gradient(#b42318 0 25%, #1d4e89 0 50%, #c4a035 0 75%, #1f7a4d 0)";
var PIP_SYMBOL = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
var LABELS = { hit: "要牌", stand: "停牌", call: "跟注", raise: "加注", fold: "弃牌", check: "过牌", draw: "摸牌", pass: "过" };
var cardTableLayout = ${cardTableLayout.toString()};
var fanLayout = ${fanLayout.toString()};

/** 跟随宿主明暗主题（同源时读宿主 body[data-ds-dark-theme]），否则跟随系统。 */
function syncTheme() {
  var dark = null;
  try {
    var b = parent && parent !== window && parent.document && parent.document.body;
    if (b) dark = b.hasAttribute("data-ds-dark-theme");
  } catch (e) {}
  if (dark === null) dark = !(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  var want = dark ? "dark" : "light";
  if (document.documentElement.getAttribute("data-theme") !== want) document.documentElement.setAttribute("data-theme", want);
}
function teamTagEl(team) {
  if (typeof team !== "number") return null;
  var tag = document.createElement("i");
  tag.className = "team-tag t" + (team % 3);
  tag.textContent = "第 " + (team + 1) + " 队";
  tag.title = "第 " + (team + 1) + " 队";
  return tag;
}

function cardEl(card, mini) {
  var node = document.createElement("div");
  if (!card || card.hidden) {
    node.className = "card back";
    return node;
  }
  var face = card.text != null && card.text !== "" ? String(card.text) : String(card.code || "");
  if (card.wild && !(card.tone && TONE[card.tone])) {
    node.className = "card uno wild";
    node.style.background = UNO_WHEEL;
    node.style.color = "#f7f1e4";
    node.style.textShadow = "0 0 2px #000, 0 0 2px #000";
    node.textContent = face;
    return node;
  }
  if (card.tone && TONE[card.tone]) {
    node.className = card.wild ? "card uno played-wild" : "card uno";
    node.style.background = TONE[card.tone];
    node.style.color = card.tone === "y" ? "#1c1915" : "#f7f1e4";
    if (card.wild) {
      node.style.backgroundImage = UNO_WHEEL;
      node.style.backgroundSize = "9px 9px";
      node.style.backgroundRepeat = "no-repeat";
      node.style.backgroundPosition = "2px 2px";
    }
    node.textContent = face;
    return node;
  }
  if (card.pip && card.color) {
    node.className = card.color === "red" ? "card red ddz" : "card ddz";
    if (card.pip === "J") {
      node.className += " joker";
      node.style.fontSize = mini ? "4px" : "7px";
      node.textContent = face;
      return node;
    }
    var rank = document.createElement("span");
    rank.textContent = face;
    var sym = document.createElement("span");
    sym.textContent = PIP_SYMBOL[card.pip] || "";
    node.append(rank, sym);
    return node;
  }
  var red = card.suit === "H" || card.suit === "D";
  node.className = red ? "card red" : "card";
  node.textContent = card.text || card.code || "";
  return node;
}
/** 悬停 / 聚焦：当前牌 lift，左右相邻 near。 */
function wireHover(fan) {
  function clear() {
    Array.prototype.forEach.call(fan.children, function (c) { c.classList.remove("lift", "near"); });
  }
  function mark(target) {
    clear();
    if (!target || target.parentNode !== fan) return;
    target.classList.add("lift");
    if (target.previousElementSibling) target.previousElementSibling.classList.add("near");
    if (target.nextElementSibling) target.nextElementSibling.classList.add("near");
  }
  fan.addEventListener("mouseover", function (ev) { mark(ev.target.closest ? ev.target.closest(".card") : null); });
  fan.addEventListener("mouseleave", clear);
  fan.addEventListener("focusin", function (ev) { mark(ev.target); });
  fan.addEventListener("focusout", function () { if (!fan.contains(document.activeElement)) clear(); });
}
/** 按当前尺寸摆放：桌面椭圆、对手座位、手牌与小扇形。 */
function placeAll() {
  var W = table.clientWidth;
  var H = table.clientHeight;
  var hand = table.querySelector(".hand");
  var handH = hand ? hand.offsetHeight : 0;
  var felt = table.querySelector(".felt");
  var feltH = Math.max(120, H - handH - 4);
  if (felt) felt.style.height = feltH + "px";
  var cx = W / 2;
  var cy = 8 + feltH / 2;
  var rx = Math.max(40, W / 2 - 4 - 50);
  var ry = Math.max(30, feltH / 2 - 34);
  Array.prototype.forEach.call(table.querySelectorAll(".seat"), function (node) {
    var seat = node._seat;
    var x = Math.max(50, Math.min(W - 50, cx + seat.x * rx));
    var y = Math.max(4, cy + seat.y * ry - 26);
    node.style.left = x + "px";
    node.style.top = y + "px";
    var mini = node.querySelectorAll(".mini-fan .card");
    var faces = node.querySelector(".mini-fan.faces") !== null;
    var pos = faces ? fanLayout(mini.length, 92, 32, 22, 20, 4) : fanLayout(mini.length, 92, 16, 7, 60, 5);
    Array.prototype.forEach.call(mini, function (c, i) {
      c.style.transform = "translate(" + (pos[i].x + 2) + "px," + (pos[i].y + 4) + "px) rotate(" + pos[i].rot + "deg)";
      c.style.zIndex = String(i + 1);
    });
  });
  var fan = table.querySelector(".fan");
  if (fan) {
    var cards = fan.querySelectorAll(".card");
    // 两侧留出放大后的余量，避免悬停时溢出
    var pad = 22;
    var width = Math.max(40, fan.clientWidth - pad * 2);
    var pos = fanLayout(cards.length, width, 32, 26, 44, 12);
    Array.prototype.forEach.call(cards, function (c, i) {
      c.style.setProperty("--x", (pos[i].x + pad) + "px");
      c.style.setProperty("--y", pos[i].y + "px");
      c.style.setProperty("--rot", pos[i].rot + "deg");
      c.style.zIndex = String(i + 1);
    });
    // 首次摆放不做过渡，之后悬停才有动画
    if (!fan.classList.contains("ready")) requestAnimationFrame(function () { fan.classList.add("ready"); });
  }
}
function winnerText(over) {
  if (over.winner === "player") return "玩家胜";
  if (over.winner === "dealer") return "庄家胜";
  if (over.winner === "ai") return "对手胜";
  return "平局";
}
var selected = {};
/** 点牌出牌：UNO 单击即出（万能牌再选颜色），斗地主点选多张后按「出牌」。不可出的牌变暗。 */
function wirePlay(node, card, index, session) {
  if (!session.canAct || !session.handMode || card.playable === undefined) return;
  if (!card.playable) { node.classList.add("dim"); node.setAttribute("aria-disabled", "true"); return; }
  node.classList.add("playable");
  if (session.passAction) node.classList.add("drawn");
  if (session.handMode === "multi" && selected[index]) node.classList.add("sel");
  function go() {
    if (session.handMode === "single") {
      var play = card.play || [];
      if (play.length === 1) act(play[0]);
      else if (play.length > 1) chooseColor(play, node);
      return;
    }
    selected[index] = !selected[index];
    node.classList.toggle("sel", Boolean(selected[index]));
    paintActions(session);
  }
  node.addEventListener("click", go);
  node.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") { ev.preventDefault(); go(); }
  });
}
function closeChooser() {
  var old = table.querySelector(".chooser");
  if (old) old.parentNode.removeChild(old);
}
function chooseColor(play, from) {
  closeChooser();
  var box = document.createElement("div");
  box.className = "chooser";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "选择颜色");
  var names = { r: "红", g: "绿", b: "蓝", y: "黄" };
  play.forEach(function (action) {
    var color = action.split("-")[0];
    var b = document.createElement("button");
    b.type = "button";
    b.className = "card uno";
    b.style.background = TONE[color];
    b.style.color = color === "y" ? "#1c1915" : "#f7f1e4";
    b.textContent = names[color] || color;
    b.setAttribute("aria-label", "选" + (names[color] || color) + "色");
    b.addEventListener("click", function () { closeChooser(); act(action); });
    box.appendChild(b);
  });
  var x = document.createElement("button");
  x.type = "button";
  x.className = "x";
  x.textContent = "取消";
  x.addEventListener("click", function () { closeChooser(); if (from) from.focus(); });
  box.appendChild(x);
  box.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closeChooser(); if (from) from.focus(); } });
  table.appendChild(box);
  var first = box.querySelector("button");
  if (first) first.focus();
}
function selectionAction(session) {
  var row = null;
  (session.rows || []).forEach(function (r) { if (r.label === "H" && !row) row = r; });
  if (!row) return "";
  var ranks = [];
  row.cards.forEach(function (card, i) { if (selected[i]) ranks.push(card.rank || card.code); });
  var ORDER = "3456789TJQKA2BR";
  ranks.sort(function (a, b) { return ORDER.indexOf(a) - ORDER.indexOf(b); });
  return ranks.join("");
}
function turnNote(session) {
  var note = document.createElement("span");
  note.className = "turn-note";
  note.textContent = session.turnRole === "agent" ? "等待 AI 出牌…" : ("轮到 " + (session.turnName || "对手"));
  actions.appendChild(note);
}
function paintActions(session) {
  actions.textContent = "";
  if (!session || session.over || session.turn === "over") return;
  if (session.canAct === false || (session.canAct === undefined && session.turn === "ai")) { if (session.mode === "versus") turnNote(session); return; }
  var legal = session.legal || [];
  if (session.handMode === "single") return;
  if (session.handMode === "multi") {
    var combo = selectionAction(session);
    var playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.textContent = "出牌";
    playBtn.disabled = !combo || legal.indexOf(combo) < 0;
    playBtn.title = combo && legal.indexOf(combo) < 0 ? "这几张不是合法牌型" : "";
    playBtn.addEventListener("click", function () { var a = selectionAction(session); selected = {}; act(a); });
    actions.appendChild(playBtn);
    if (legal.indexOf("pass") >= 0) {
      var passBtn = document.createElement("button");
      passBtn.type = "button";
      passBtn.textContent = "不出";
      passBtn.addEventListener("click", function () { selected = {}; act("pass"); });
      actions.appendChild(passBtn);
    }
    if (combo) {
      var clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "重选";
      clear.addEventListener("click", function () { selected = {}; paint(last); });
      actions.appendChild(clear);
    }
    return;
  }
  if (legal.length > 16) {
    var select = document.createElement("select");
    legal.forEach(function (action) {
      var option = document.createElement("option");
      option.value = action;
      option.textContent = LABELS[action] || action;
      select.appendChild(option);
    });
    var go = document.createElement("button");
    go.type = "button";
    go.textContent = "出牌";
    go.addEventListener("click", function () { act(select.value); });
    actions.append(select, go);
    return;
  }
  legal.forEach(function (action) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = LABELS[action] || action;
    button.addEventListener("click", function () { act(action); });
    actions.appendChild(button);
  });
}
function paint(session) {
  if (!last || !session || last.id !== session.id || last.moveCount !== session.moveCount) selected = {};
  last = session;
  closeChooser();
  if (!session) {
    title.textContent = "牌桌";
    meta.textContent = "当前没有进行中的牌局";
    table.textContent = "";
    actions.textContent = "";
    return;
  }
  title.textContent = (session.label || "牌桌") + " · " + session.playerName;
  if (session.mode === "room" && session.occupants && session.occupants.length) {
    var who = session.occupants.map(function (o) { return o.name + (o.status === "pending" ? "（待入座）" : ""); }).join("、");
    var turnLine = session.over ? (winnerText(session.over) + " · " + session.over.reason) : (session.waiting && session.waiting.length ? ("等待入座：" + session.waiting.join("、")) : ("轮到 " + (session.turnName || "下一位")));
    meta.textContent = turnLine + " · " + who;
  } else if (session.over) meta.textContent = winnerText(session.over) + " · " + session.over.reason;
  else if (session.summary) meta.textContent = session.summary;
  else meta.textContent = session.turn === "ai" ? "对手回合" : "玩家回合";
  if (!session.over && session.mode === "versus" && session.canAct === false) meta.textContent = "轮到 " + (session.turnName || "对手") + " · " + meta.textContent;
  var layout = cardTableLayout(session);
  table.textContent = "";
  var felt = document.createElement("div");
  felt.className = "felt";
  felt.setAttribute("aria-hidden", "false");
  var middle = document.createElement("div");
  middle.className = "center";
  layout.center.forEach(function (group) {
    if (!group.cards.length) return;
    var g = document.createElement("div");
    g.className = "pile";
    var cap = document.createElement("div");
    cap.className = "pile-title";
    cap.textContent = group.title;
    var cards = document.createElement("div");
    cards.className = "pile-cards";
    group.cards.forEach(function (card) { cards.appendChild(cardEl(card)); });
    g.append(cap, cards);
    middle.appendChild(g);
  });
  felt.appendChild(middle);
  table.appendChild(felt);
  layout.opponents.forEach(function (seat) {
    var node = document.createElement("div");
    node.className = "seat";
    node.setAttribute("role", "group");
    var count = seat.cards.length ? seat.cards.length : seat.count;
    var label = seat.title + " · " + count + " 张" + (seat.score !== "" ? " · " + seat.score + " 点" : "");
    node.setAttribute("aria-label", label);
    var fan = document.createElement("div");
    fan.className = "mini-fan";
    var cards = seat.cards.length ? seat.cards : [];
    if (!cards.length) for (var i = 0; i < Math.min(seat.count || 0, 10); i++) cards.push({ hidden: true });
    cards.slice(0, 24).forEach(function (card) {
      var c = cardEl(card, true);
      // 摊牌后的明牌用手牌尺寸，暗牌用小牌背
      if (card && !card.hidden) fan.classList.add("faces");
      else c.classList.add("mini");
      fan.appendChild(c);
    });
    if (fan.classList.contains("faces")) Array.prototype.forEach.call(fan.children, function (c) { c.classList.remove("mini"); });
    var name = document.createElement("div");
    name.className = "seat-name";
    var who = document.createElement("span");
    who.textContent = seat.title;
    var n = document.createElement("b");
    n.textContent = "· " + (seat.score !== "" ? seat.score + " 点 · " : "") + count + " 张";
    var tag = teamTagEl(seat.team);
    if (tag) { name.append(tag); node.setAttribute("aria-label", "第 " + (seat.team + 1) + " 队 · " + label); }
    name.append(who, n);
    node.append(fan, name);
    node._seat = seat;
    table.appendChild(node);
  });
  var hand = document.createElement("div");
  hand.className = "hand";
  var mine = document.createElement("div");
  mine.className = "seat-name me";
  var meWho = document.createElement("span");
  meWho.textContent = layout.me.title;
  var meN = document.createElement("b");
  meN.textContent = "· " + (layout.me.score !== "" ? layout.me.score + " 点 · " : "") + layout.me.cards.length + " 张";
  var meTag = teamTagEl(layout.me.team);
  if (meTag) mine.append(meTag);
  mine.append(meWho, meN);
  var fanBox = document.createElement("div");
  fanBox.className = "fan";
  fanBox.setAttribute("role", "list");
  fanBox.setAttribute("aria-label", "手牌");
  layout.me.cards.forEach(function (card, i) {
    var c = cardEl(card);
    c.classList.add("in-hand");
    c.setAttribute("role", "listitem");
    c.tabIndex = 0;
    c.setAttribute("aria-label", "第 " + (i + 1) + " 张：" + (card.hidden ? "暗牌" : (card.text || card.code || "")) + (card.playable === false ? "（不能出）" : ""));
    wirePlay(c, card, i, session);
    fanBox.appendChild(c);
  });
  wireHover(fanBox);
  hand.append(mine, fanBox);
  if (session.drawAction) {
    var pile = document.createElement("button");
    pile.type = "button";
    pile.className = "draw-pile";
    pile.setAttribute("aria-label", "摸牌");
    var back = cardEl({ hidden: true });
    var lab = document.createElement("span");
    lab.textContent = "摸牌";
    pile.append(back, lab);
    pile.addEventListener("click", function () { act(session.drawAction); });
    hand.appendChild(pile);
  }
  if (session.passAction) {
    var keep = document.createElement("button");
    keep.type = "button";
    keep.className = "draw-pile keep";
    keep.setAttribute("aria-label", "不出，结束回合");
    var kb = cardEl({ hidden: true });
    var kl = document.createElement("span");
    kl.textContent = "不出 · 结束回合";
    keep.append(kb, kl);
    keep.addEventListener("click", function () { act(session.passAction); });
    hand.appendChild(keep);
  }
  table.appendChild(hand);
  placeAll();
  paintActions(session);
}
function showPrompt(text) { promptEl.textContent = text || ""; }
function act(action) {
  actions.querySelectorAll("button,select").forEach(function (node) { node.disabled = true; });
  closeChooser();
  if (!action) return;
  fetch(API + "/play", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: action, key: tableKey })
  }).then(function (r) { return r.json(); }).then(function (body) {
    if (!body || body.ok === false) {
      showPrompt((body && body.error) || "没有打成");
      lastJson = "";
      return load();
    }
    lastJson = JSON.stringify(body.session || null);
    paint(body.session);
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
    // 与棋盘共用对话输入框那条通道，避免再挂一套发送逻辑。
    try { parent.postMessage({ source: "dsh-boards", prompt: body.prompt, key: tableKey, roomId: tableKey.indexOf("room:") === 0 ? tableKey.slice(5) : "" }, location.origin); } catch (e) {}
    setTimeout(function () {
      window.removeEventListener("message", onMsg);
      if (!acked) showPrompt(body.prompt || "");
    }, 1600);
  }).catch(function (e) { showPrompt(String(e && e.message || e)); });
}
function load() {
  fetch(API + "/session" + sessionQuery()).then(function (r) { return r.json(); }).then(function (body) {
    var session = body && body.open ? body.session : null;
    if (session && seen && seen !== session.id) showPrompt("");
    seen = session ? session.id : "";
    // 局面没变就不重绘，避免每秒重建手牌打断悬停
    var json = JSON.stringify(session);
    if (json === lastJson) return;
    lastJson = json;
    paint(session);
  }).catch(function () {});
}
syncTheme();
load();
setInterval(function () { syncTheme(); load(); }, 1000);
if (window.ResizeObserver) new ResizeObserver(function () { if (last) placeAll(); }).observe(table);
else window.addEventListener("resize", function () { if (last) placeAll(); });
</script>
</body>
</html>`
}
