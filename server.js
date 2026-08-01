const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const TURN_SECONDS = 30;
const MAX_SEATS = 6;
const BOT_THINK_MS = 900;

const users = new Map();
const sessions = new Map();
const rooms = new Map();

const SUITS = ["spades", "hearts", "diamonds", "clubs"];
const RANKS = [
  { code: "2", value: 2 }, { code: "3", value: 3 }, { code: "4", value: 4 },
  { code: "5", value: 5 }, { code: "6", value: 6 }, { code: "7", value: 7 },
  { code: "8", value: 8 }, { code: "9", value: 9 }, { code: "10", value: 10 },
  { code: "J", value: 11 }, { code: "Q", value: 12 }, { code: "K", value: 13 },
  { code: "A", value: 14 }
];

function makeSeat(index) {
  return {
    id: `seat_${index}`,
    index,
    userId: null,
    name: "Open Seat",
    isBot: false,
    chips: 0,
    buyIn: 0,
    cards: [],
    folded: false,
    allIn: false,
    bet: 0,
    acted: false,
    connected: false,
    lastAction: "Waiting"
  };
}

function makeRoom({ host, practice = false }) {
  const code = practice ? `PRAC${crypto.randomInt(100, 999)}` : uniqueCode();
  const room = {
    code,
    practice,
    hostId: host.id,
    status: "lobby",
    handId: 0,
    dealerSeat: -1,
    currentSeat: -1,
    smallBlind: 25,
    bigBlind: 50,
    defaultBuyIn: 1250,
    highestBet: 0,
    minRaise: 50,
    pot: 0,
    deck: [],
    community: [],
    log: [],
  winnerText: "",
  winners: [],
    turnStartedAt: null,
    turnExpiresAt: null,
    lastEvent: "room-created",
    seats: Array.from({ length: MAX_SEATS }, (_, index) => makeSeat(index))
  };
  sitPlayer(room, host);
  if (practice) {
    ["Mira", "Kade", "Nova"].forEach((name, i) => {
      const bot = room.seats[i + 1];
      bot.userId = `bot_${i}`;
      bot.name = name;
      bot.isBot = true;
      bot.connected = true;
      bot.chips = room.defaultBuyIn;
      bot.buyIn = room.defaultBuyIn;
      bot.lastAction = "Practice bot";
    });
  }
  addLog(room, practice ? "Practice room created with bots." : `Room ${code} created.`);
  rooms.set(code, room);
  return room;
}

function uniqueCode() {
  let code = "";
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter((pair) => pair[0]));
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).session;
  return token ? sessions.get(token) : null;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain" : "application/json",
    ...headers
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank: rank.code, value: rank.value });
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sitPlayer(room, user) {
  const existing = room.seats.find((seat) => seat.userId === user.id);
  if (existing) {
    existing.connected = true;
    existing.name = user.name;
    return existing;
  }
  const seat = room.seats.find((candidate) => !candidate.connected);
  if (!seat) throw new Error("Room is full.");
  seat.userId = user.id;
  seat.name = user.name;
  seat.connected = true;
  seat.isBot = false;
  seat.chips = seat.chips || room.defaultBuyIn;
  seat.buyIn = seat.buyIn || room.defaultBuyIn;
  seat.lastAction = "Seated";
  addLog(room, `${user.name} joined the table.`);
  return seat;
}

function requireRoom(user) {
  if (!user.roomCode || !rooms.has(user.roomCode)) throw new Error("Join or create a room first.");
  return rooms.get(user.roomCode);
}

function requireHost(room, user) {
  if (room.hostId !== user.id) throw new Error("Only the host can do that.");
}

function activeSeats(room) {
  return room.seats.filter((seat) => seat.connected && seat.chips > 0);
}

function liveSeats(room) {
  return activeSeats(room).filter((seat) => !seat.folded);
}

function addLog(room, message) {
  room.log.unshift(message);
  room.log = room.log.slice(0, 10);
  room.lastEvent = `${Date.now()}_${message}`;
}

function startHand(room) {
  const seats = activeSeats(room);
  if (seats.length < 2) throw new Error("At least two players need chips to start.");
  room.status = "preflop";
  room.handId += 1;
  room.deck = createDeck();
  room.community = [];
  room.pot = 0;
  room.highestBet = 0;
  room.minRaise = room.bigBlind;
  room.winnerText = "";
  room.winners = [];

  for (const seat of seats) {
    seat.cards = [room.deck.pop(), room.deck.pop()];
    seat.folded = false;
    seat.allIn = false;
    seat.bet = 0;
    seat.acted = false;
    seat.lastAction = "Dealt in";
  }
  auditDealtCards(room);

  const indexes = seats.map((seat) => seat.index);
  const previousDealer = indexes.includes(room.dealerSeat) ? indexes.indexOf(room.dealerSeat) : -1;
  room.dealerSeat = indexes[(previousDealer + 1) % indexes.length];
  const dealer = room.seats[room.dealerSeat];
  const sb = seats.length === 2 ? dealer : nextPlayableSeat(room, room.dealerSeat);
  const bb = nextPlayableSeat(room, sb.index);
  postBlind(room, sb, room.smallBlind, "Small blind");
  postBlind(room, bb, room.bigBlind, "Big blind");
  room.highestBet = room.bigBlind;
  setTurn(room, nextPlayableSeat(room, bb.index).index);
  addLog(room, `Hand #${room.handId}: ${sb.name} posts SB, ${bb.name} posts BB.`);
  autoPlayBots(room);
}

function auditDealtCards(room) {
  const seen = new Set();
  const dealt = activeSeats(room).flatMap((seat) => seat.cards).concat(room.community);
  for (const card of dealt) {
    const key = `${card.rank}-${card.suit}`;
    if (seen.has(key)) throw new Error("Deck integrity check failed.");
    seen.add(key);
  }
}

function postBlind(room, seat, amount, label) {
  const paid = Math.min(seat.chips, amount);
  seat.chips -= paid;
  seat.bet += paid;
  room.pot += paid;
  seat.allIn = seat.chips === 0;
  seat.lastAction = label;
}

function nextPlayableSeat(room, fromIndex) {
  for (let offset = 1; offset <= room.seats.length; offset += 1) {
    const seat = room.seats[(fromIndex + offset) % room.seats.length];
    if (seat.connected && seat.chips > 0 && !seat.folded && !seat.allIn) return seat;
  }
  return activeSeats(room)[0];
}

function setTurn(room, seatIndex) {
  room.currentSeat = seatIndex;
  room.turnStartedAt = Date.now();
  room.turnExpiresAt = room.turnStartedAt + TURN_SECONDS * 1000;
}

function playerAction(room, userId, action, amount = 0) {
  enforceExpiredTurn(room);
  const seat = room.seats[room.currentSeat];
  if (!seat || seat.userId !== userId) throw new Error("It is not your turn.");
  if (room.status === "lobby" || room.status === "showdown") throw new Error("No active hand.");
  takeAction(room, seat, action, amount);
}

function takeAction(room, seat, action, amount = 0) {
  const toCall = Math.max(0, room.highestBet - seat.bet);
  if (action === "fold") {
    seat.folded = true;
    seat.acted = true;
    seat.lastAction = "Fold";
    addLog(room, `${seat.name} folds.`);
  } else if (action === "check") {
    if (toCall > 0) throw new Error("You must call, raise, or fold.");
    seat.acted = true;
    seat.lastAction = "Check";
    addLog(room, `${seat.name} checks.`);
  } else if (action === "call") {
    putChips(room, seat, toCall);
    seat.acted = true;
    seat.lastAction = toCall ? `Call ${toCall}` : "Check";
    addLog(room, `${seat.name} ${toCall ? `calls ${toCall}` : "checks"}.`);
  } else if (action === "raise") {
    const raiseTo = Math.max(room.highestBet + room.minRaise, Number(amount) || 0);
    const totalNeeded = raiseTo - seat.bet;
    if (totalNeeded <= toCall) throw new Error("Raise must exceed the current bet.");
    putChips(room, seat, totalNeeded);
    room.minRaise = Math.max(room.bigBlind, seat.bet - room.highestBet);
    room.highestBet = seat.bet;
    for (const other of liveSeats(room)) if (other.id !== seat.id) other.acted = false;
    seat.acted = true;
    seat.lastAction = `Raise ${seat.bet}`;
    addLog(room, `${seat.name} raises to ${seat.bet}.`);
  } else if (action === "allin") {
    putChips(room, seat, seat.chips);
    if (seat.bet > room.highestBet) {
      room.minRaise = Math.max(room.bigBlind, seat.bet - room.highestBet);
      room.highestBet = seat.bet;
      for (const other of liveSeats(room)) if (other.id !== seat.id) other.acted = false;
    }
    seat.acted = true;
    seat.lastAction = "All-in";
    addLog(room, `${seat.name} moves all-in.`);
  }
  nextTurn(room);
}

function putChips(room, seat, amount) {
  const paid = Math.min(seat.chips, Math.max(0, amount));
  seat.chips -= paid;
  seat.bet += paid;
  room.pot += paid;
  seat.allIn = seat.chips === 0;
}

function nextTurn(room) {
  if (liveSeats(room).length === 1) return finishByFold(room);
  if (roundComplete(room)) return advanceStreet(room);
  setTurn(room, nextPlayableSeat(room, room.currentSeat).index);
  autoPlayBots(room);
}

function roundComplete(room) {
  return liveSeats(room).every((seat) => seat.allIn || (seat.acted && seat.bet === room.highestBet));
}

function advanceStreet(room) {
  for (const seat of activeSeats(room)) {
    seat.bet = 0;
    seat.acted = false;
  }
  room.highestBet = 0;
  room.minRaise = room.bigBlind;
  if (room.status === "preflop") {
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    auditDealtCards(room);
    room.status = "flop";
    addLog(room, "The flop opens.");
  } else if (room.status === "flop") {
    room.community.push(room.deck.pop());
    auditDealtCards(room);
    room.status = "turn";
    addLog(room, "The turn opens.");
  } else if (room.status === "turn") {
    room.community.push(room.deck.pop());
    auditDealtCards(room);
    room.status = "river";
    addLog(room, "The river opens.");
  } else {
    return showdown(room);
  }
  setTurn(room, nextPlayableSeat(room, room.dealerSeat).index);
  autoPlayBots(room);
}

function finishByFold(room) {
  const winner = liveSeats(room)[0];
  winner.chips += room.pot;
  const won = room.pot;
  room.pot = 0;
  room.winners = [winner.id];
  room.winnerText = `${winner.name} wins ${won}`;
  room.status = "showdown";
  room.turnExpiresAt = null;
  addLog(room, room.winnerText);
}

function showdown(room) {
  const ranked = liveSeats(room).map((seat) => ({
    seat,
    hand: evaluateSeven([...seat.cards, ...room.community])
  })).sort((a, b) => compareScore(b.hand.score, a.hand.score));
  const best = ranked[0];
  const winners = ranked.filter((entry) => compareScore(entry.hand.score, best.hand.score) === 0);
  const share = Math.floor(room.pot / winners.length);
  let remainder = room.pot % winners.length;
  for (const winner of winners) {
    winner.seat.chips += share + (remainder > 0 ? 1 : 0);
    remainder -= 1;
  }
  const won = room.pot;
  room.pot = 0;
  room.winners = winners.map((entry) => entry.seat.id);
  room.winnerText = winners.length === 1
    ? `${best.seat.name} wins ${won} with ${best.hand.name}`
    : `${winners.map((entry) => entry.seat.name).join(", ")} split ${won} with ${best.hand.name}`;
  room.status = "showdown";
  room.turnExpiresAt = null;
  addLog(room, room.winnerText);
}

function enforceExpiredTurn(room) {
  if (!room.turnExpiresAt || Date.now() <= room.turnExpiresAt || room.status === "showdown" || room.status === "lobby") return;
  const seat = room.seats[room.currentSeat];
  if (seat && !seat.isBot) {
    const toCall = Math.max(0, room.highestBet - seat.bet);
    takeAction(room, seat, toCall ? "fold" : "check");
  }
}

function processRoom(room) {
  if (room.status === "lobby" || room.status === "showdown") return;
  enforceExpiredTurn(room);
  autoPlayBots(room);
}

function autoPlayBots(room) {
  const bot = room.seats[room.currentSeat];
  if (!bot?.isBot || room.status === "showdown" || room.status === "lobby") return;
  if (Date.now() - (room.turnStartedAt || 0) < BOT_THINK_MS) return;
  const toCall = Math.max(0, room.highestBet - bot.bet);
  const score = botStrength(room, bot);
  if (toCall > bot.chips * 0.45 && score < 2 && Math.random() > 0.2) takeAction(room, bot, "fold");
  else if (toCall === 0 && bot.chips > room.bigBlind * 4 && Math.random() < 0.18) {
    takeAction(room, bot, "raise", Math.max(room.highestBet + room.minRaise, bot.bet + room.bigBlind));
  }
  else takeAction(room, bot, "call");
}

function botStrength(room, bot) {
  const visible = [...bot.cards, ...room.community];
  if (visible.length >= 5) return evaluateSeven(visible).score[0];
  const [a, b] = bot.cards;
  return (a.value === b.value ? 2 : 0) + (a.suit === b.suit ? 0.5 : 0) + (Math.max(a.value, b.value) >= 12 ? 0.5 : 0);
}

function evaluateSeven(cards) {
  return combinations(cards, 5).map(evaluateFive).sort((a, b) => compareScore(b.score, a.score))[0];
}

function combinations(cards, size) {
  const result = [];
  function walk(start, combo) {
    if (combo.length === size) return result.push(combo);
    for (let i = start; i < cards.length; i += 1) walk(i + 1, combo.concat(cards[i]));
  }
  walk(0, []);
  return result;
}

function evaluateFive(cards) {
  const values = cards.map((card) => card.value).sort((a, b) => b - a);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straightHigh = getStraightHigh(values);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (flush && straightHigh) return { name: straightHigh === 14 ? "Royal Flush" : "Straight Flush", score: [8, straightHigh] };
  if (groups[0][1] === 4) return { name: "Four of a Kind", score: [7, groups[0][0], groups[1][0]] };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { name: "Full House", score: [6, groups[0][0], groups[1][0]] };
  if (flush) return { name: "Flush", score: [5, ...values] };
  if (straightHigh) return { name: "Straight", score: [4, straightHigh] };
  if (groups[0][1] === 3) return { name: "Three of a Kind", score: [3, groups[0][0], ...groups.slice(1).map((g) => g[0])] };
  if (groups[0][1] === 2 && groups[1][1] === 2) return { name: "Two Pair", score: [2, groups[0][0], groups[1][0], groups[2][0]] };
  if (groups[0][1] === 2) return { name: "One Pair", score: [1, groups[0][0], ...groups.slice(1).map((g) => g[0])] };
  return { name: "High Card", score: [0, ...values] };
}

function getStraightHigh(values) {
  const unique = [...new Set(values)];
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i += 1) if (unique[i] - unique[i + 4] === 4) return unique[i];
  return 0;
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function serializeRoom(room, userId) {
  processRoom(room);
  return {
    code: room.code,
    practice: room.practice,
    isHost: room.hostId === userId,
    hostId: room.hostId,
    status: room.status,
    handId: room.handId,
    dealerSeat: room.dealerSeat,
    currentSeat: room.currentSeat,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    defaultBuyIn: room.defaultBuyIn,
    highestBet: room.highestBet,
    minRaise: room.minRaise,
    pot: room.pot,
    community: room.community,
    log: room.log,
    winnerText: room.winnerText,
    turnExpiresAt: room.turnExpiresAt,
    serverNow: Date.now(),
    lastEvent: room.lastEvent,
    seats: room.seats.map((seat) => ({
      id: seat.id,
      index: seat.index,
      userId: seat.userId,
      name: seat.name,
      chips: seat.chips,
      buyIn: seat.buyIn,
      bet: seat.bet,
      folded: seat.folded,
      allIn: seat.allIn,
      isBot: seat.isBot,
      connected: seat.connected,
      lastAction: seat.lastAction,
      winner: room.status === "showdown" && room.winners?.includes(seat.id),
      cards: seat.userId === userId || (room.status === "showdown" && !seat.folded) ? seat.cards : seat.cards.map(() => null)
    }))
  };
}

async function handleApi(req, res) {
  try {
    const route = req.url.split("?")[0];
    if (route === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.name || "").trim().slice(0, 24);
      if (name.length < 2) return send(res, 400, { error: "Enter a player name with at least 2 characters." });
      const id = uid("user");
      const user = { id, name, roomCode: null };
      users.set(id, user);
      const token = uid("session");
      sessions.set(token, user);
      return send(res, 200, { user }, { "Set-Cookie": `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
    }

    const user = getSession(req);
    if (!user) return send(res, 401, { error: "Login required." });

    if (route === "/api/me" && req.method === "GET") {
      const room = user.roomCode && rooms.get(user.roomCode);
      return send(res, 200, { user, room: room ? serializeRoom(room, user.id) : null });
    }

    if (route === "/api/rooms" && req.method === "POST") {
      const body = await readJson(req);
      const room = makeRoom({ host: user, practice: Boolean(body.practice) });
      user.roomCode = room.code;
      return send(res, 200, { room: serializeRoom(room, user.id) });
    }

    if (route === "/api/rooms/join" && req.method === "POST") {
      const body = await readJson(req);
      const code = String(body.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(res, 404, { error: "Room not found." });
      if (room.practice) return send(res, 400, { error: "Practice rooms are private." });
      sitPlayer(room, user);
      user.roomCode = room.code;
      return send(res, 200, { room: serializeRoom(room, user.id) });
    }

    if (route === "/api/room/leave" && req.method === "POST") {
      const room = requireRoom(user);
      const seat = room.seats.find((candidate) => candidate.userId === user.id);
      if (seat) {
        seat.connected = false;
        seat.cards = [];
        seat.lastAction = "Left";
      }
      user.roomCode = null;
      return send(res, 200, { room: null });
    }

    const room = requireRoom(user);

    if (route === "/api/host/settings" && req.method === "POST") {
      requireHost(room, user);
      const body = await readJson(req);
      room.smallBlind = Math.max(1, Number(body.smallBlind) || room.smallBlind);
      room.bigBlind = Math.max(room.smallBlind * 2, Number(body.bigBlind) || room.bigBlind);
      room.defaultBuyIn = Math.max(room.bigBlind, Number(body.defaultBuyIn) || room.defaultBuyIn);
      for (const seat of room.seats) {
        if (seat.connected && room.status === "lobby") {
          seat.buyIn = room.defaultBuyIn;
          seat.chips = room.defaultBuyIn;
        }
      }
      addLog(room, "Host updated table settings.");
      return send(res, 200, { room: serializeRoom(room, user.id) });
    }

    if (route === "/api/host/chips" && req.method === "POST") {
      requireHost(room, user);
      const body = await readJson(req);
      const seat = room.seats.find((candidate) => candidate.id === body.seatId);
      if (!seat || !seat.connected) throw new Error("Seat not found.");
      const chips = Math.max(0, Number(body.chips) || 0);
      seat.chips = chips;
      seat.buyIn = chips;
      seat.lastAction = `Buy-in ${chips}`;
      addLog(room, `Host set ${seat.name}'s buy-in to ${chips}.`);
      return send(res, 200, { room: serializeRoom(room, user.id) });
    }

    if (route === "/api/host/start" && req.method === "POST") {
      requireHost(room, user);
      if (room.status !== "lobby" && room.status !== "showdown") throw new Error("A hand is already running.");
      startHand(room);
      return send(res, 200, { room: serializeRoom(room, user.id) });
    }

    if (route === "/api/action" && req.method === "POST") {
      const body = await readJson(req);
      playerAction(room, user.id, body.action, body.amount);
      return send(res, 200, { room: serializeRoom(room, user.id) });
    }

    return send(res, 404, { error: "API route not found." });
  } catch (error) {
    return send(res, 400, { error: error.message || "Request failed." });
  }
}

function serveStatic(req, res) {
  const safePath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, "Not found");
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Online poker table running at http://localhost:${PORT}`);
  });
}

module.exports = {
  evaluateSeven,
  compareScore
};
