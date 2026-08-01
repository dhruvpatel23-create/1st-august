const $ = (selector) => document.querySelector(selector);
const loginPanel = $("#loginPanel");
const lobbyScreen = $("#lobbyScreen");
const tableScreen = $("#tableScreen");
const loginForm = $("#loginForm");
const createRoomForm = $("#createRoomForm");
const joinRoomForm = $("#joinRoomForm");
const practiceRoomForm = $("#practiceRoomForm");
const loginError = $("#loginError");
const lobbyError = $("#lobbyError");
const gameError = $("#gameError");
const welcomeText = $("#welcomeText");
const roomCode = $("#roomCode");
const phaseBadge = $("#phaseBadge");
const potEl = $("#pot");
const communityEl = $("#community");
const winnerEl = $("#winner");
const seatRing = $("#seatRing");
const holeCardsEl = $("#holeCards");
const raiseAmount = $("#raiseAmount");
const raiseMinus = $("#raiseMinus");
const raisePlus = $("#raisePlus");
const logEl = $("#log");
const hostPanel = $("#hostPanel");
const chipControls = $("#chipControls");
const actionButtons = [...document.querySelectorAll("[data-action]")];

let me = null;
let room = null;
let lastEvent = "";
let lastHandId = 0;
let lastCommunityKey = "";
let lastHoleKey = "";
let actionInFlight = false;
let clockOffset = 0;

const suitMarks = { spades: "&spades;", hearts: "&hearts;", diamonds: "&diams;", clubs: "&clubs;" };

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  try {
    const name = new FormData(loginForm).get("playerName");
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ name }) });
    me = data.user;
    showLobby();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  lobbyError.textContent = "";
  try {
    const data = await api("/api/rooms", { method: "POST", body: JSON.stringify({ practice: false }) });
    room = data.room;
    showTable();
  } catch (error) {
    lobbyError.textContent = error.message;
  }
});

practiceRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  lobbyError.textContent = "";
  try {
    const data = await api("/api/rooms", { method: "POST", body: JSON.stringify({ practice: true }) });
    room = data.room;
    showTable();
  } catch (error) {
    lobbyError.textContent = error.message;
  }
});

joinRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  lobbyError.textContent = "";
  try {
    const code = $("#roomCodeInput").value;
    const data = await api("/api/rooms/join", { method: "POST", body: JSON.stringify({ code }) });
    room = data.room;
    showTable();
  } catch (error) {
    lobbyError.textContent = error.message;
  }
});

$("#leaveRoom").addEventListener("click", async () => {
  await api("/api/room/leave", { method: "POST", body: "{}" });
  room = null;
  showLobby();
});

$("#saveSettings").addEventListener("click", async () => {
  gameError.textContent = "";
  try {
    const data = await api("/api/host/settings", {
      method: "POST",
      body: JSON.stringify({
        smallBlind: Number($("#smallBlind").value),
        bigBlind: Number($("#bigBlind").value),
        defaultBuyIn: Number($("#defaultBuyIn").value)
      })
    });
    room = data.room;
    render();
  } catch (error) {
    gameError.textContent = error.message;
  }
});

$("#startHand").addEventListener("click", async () => {
  gameError.textContent = "";
  try {
    const data = await api("/api/host/start", { method: "POST", body: "{}" });
    room = data.room;
    render();
  } catch (error) {
    gameError.textContent = error.message;
  }
});

raiseMinus.addEventListener("click", () => {
  changeRaiseAmount(-25);
});

raisePlus.addEventListener("click", () => {
  changeRaiseAmount(25);
});

actionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (actionInFlight || button.disabled) return;
    gameError.textContent = "";
    actionInFlight = true;
    actionButtons.forEach((candidate) => {
      candidate.disabled = true;
    });
    try {
      await api("/api/action", {
        method: "POST",
        body: JSON.stringify({ action: button.dataset.action, amount: Number(raiseAmount.value) })
      });
      await refreshRoom();
    } catch (error) {
      gameError.textContent = error.message;
      await refreshRoom({ quiet: true });
    } finally {
      actionInFlight = false;
      render();
    }
  });
});

function showLobby() {
  loginPanel.classList.add("hidden");
  tableScreen.classList.add("hidden");
  lobbyScreen.classList.remove("hidden");
  welcomeText.textContent = `Welcome, ${me.name}. Choose a table.`;
}

function showTable() {
  loginPanel.classList.add("hidden");
  lobbyScreen.classList.add("hidden");
  tableScreen.classList.remove("hidden");
  render();
}

function render() {
  if (!room) return;
  const mySeat = room.seats.find((seat) => seat.userId === me.id);
  const currentSeat = room.seats.find((seat) => seat.index === room.currentSeat);
  const isMyTurn = room.currentSeat === mySeat?.index && !["lobby", "showdown"].includes(room.status);
  const browserSyncedNow = Date.now() + clockOffset;
  const turnLeft = Math.max(0, Math.ceil(((room.turnExpiresAt || 0) - browserSyncedNow) / 1000));
  const toCall = Math.max(0, room.highestBet - (mySeat?.bet || 0));

  roomCode.textContent = room.practice ? "Practice" : `Code ${room.code}`;
  phaseBadge.textContent = room.status;
  potEl.textContent = `Pot $${room.pot}`;
  winnerEl.textContent = room.winnerText || (room.status === "lobby" ? "Waiting for host" : isMyTurn ? "Your turn" : `${currentSeat?.name || "Player"}'s turn`);
  renderCardZone(communityEl, padCards(room.community, 5), "community");
  renderCardZone(holeCardsEl, mySeat?.cards?.length ? mySeat.cards : [null, null], "hole");
  logEl.innerHTML = room.log.map((line) => `<li>${escapeHtml(line)}</li>`).join("");

  renderSeats(turnLeft);
  renderHostPanel();

  raiseAmount.min = room.highestBet + room.minRaise;
  raiseAmount.value = Math.max(Number(raiseAmount.value), room.highestBet + room.minRaise);
  raiseMinus.disabled = actionInFlight || Number(raiseAmount.value) <= Number(raiseAmount.min);
  updateActionLabels(toCall);
  actionButtons.forEach((button) => {
    const action = button.dataset.action;
    const invalidCheck = action === "check" && toCall > 0;
    const invalidCall = action === "call" && toCall === 0;
    button.disabled = !isMyTurn || actionInFlight || invalidCheck || invalidCall;
  });

  lastEvent = room.lastEvent;
  lastHandId = room.handId;
}

function changeRaiseAmount(delta) {
  const min = Number(raiseAmount.min) || 0;
  const current = Number(raiseAmount.value) || min;
  const next = Math.max(min, current + delta);
  raiseAmount.value = Math.ceil(next / 25) * 25;
  raiseMinus.disabled = Number(raiseAmount.value) <= min;
}

function updateActionLabels(toCall) {
  const labels = {
    check: toCall > 0 ? "Check" : "Check",
    call: toCall > 0 ? `Call $${toCall}` : "No Call",
    raise: "Raise",
    allin: "All-In",
    fold: "Fold"
  };
  actionButtons.forEach((button) => {
    button.textContent = labels[button.dataset.action] || button.textContent;
  });
}

function renderSeats(turnLeft) {
  seatRing.innerHTML = room.seats.map((seat) => {
    const active = room.currentSeat === seat.index ? " active" : "";
    const folded = seat.folded ? " folded" : "";
    const winner = seat.winner ? " winner-seat" : "";
    const empty = seat.connected ? "" : " empty-seat";
    const dealer = room.dealerSeat === seat.index ? `<span class="dealer-chip">D</span>` : "";
    const timer = room.currentSeat === seat.index && room.status !== "lobby" && room.status !== "showdown"
      ? `<span class="seat-timer">${turnLeft}s</span>`
      : "";
    return `
      <article class="seat seat-${seat.index}${active}${folded}${winner}${empty}">
        <div class="seat-avatar">${seat.connected ? initials(seat.name) : "+"}</div>
        <div class="seat-info">
          <strong>${escapeHtml(seat.connected ? seat.name : "Open Seat")}</strong>
          <span>${seat.connected ? `$${seat.chips} · Bet $${seat.bet}` : "Waiting"}</span>
          <small>${seat.connected ? escapeHtml(seat.lastAction) : "Seat empty"}</small>
        </div>
        <div class="seat-cards">${(seat.cards || []).map(renderMiniCard).join("")}</div>
        ${dealer}${timer}
      </article>
    `;
  }).join("");
}

function renderHostPanel() {
  hostPanel.classList.toggle("hidden", !room.isHost);
  if (!room.isHost) return;
  $("#smallBlind").value = room.smallBlind;
  $("#bigBlind").value = room.bigBlind;
  $("#defaultBuyIn").value = room.defaultBuyIn;
  $("#startHand").disabled = !["lobby", "showdown"].includes(room.status);
  chipControls.innerHTML = room.seats.filter((seat) => seat.connected).map((seat) => `
    <div class="chip-control">
      <span>${escapeHtml(seat.name)}</span>
      <input data-seat-id="${seat.id}" type="number" min="0" step="50" value="${seat.chips}" />
      <button data-chip-seat="${seat.id}" class="gold">Set</button>
    </div>
  `).join("");
  chipControls.querySelectorAll("[data-chip-seat]").forEach((button) => {
    button.addEventListener("click", async () => {
      const seatId = button.dataset.chipSeat;
      const input = chipControls.querySelector(`[data-seat-id="${seatId}"]`);
      try {
        const data = await api("/api/host/chips", {
          method: "POST",
          body: JSON.stringify({ seatId, chips: Number(input.value) })
        });
        room = data.room;
        render();
      } catch (error) {
        gameError.textContent = error.message;
      }
    });
  });
}

function padCards(cards, count) {
  const padded = [...cards];
  while (padded.length < count) padded.push(undefined);
  return padded;
}

function renderCard(card) {
  if (card === null) return `<div class="card back"></div>`;
  if (card === undefined) return `<div class="card empty"><span class="suit">&diams;</span></div>`;
  const red = card.suit === "hearts" || card.suit === "diamonds" ? " red-suit" : "";
  return `
    <div class="card${red}">
      <div class="corner top"><span>${card.rank}</span><span>${suitMarks[card.suit]}</span></div>
      <div class="suit">${suitMarks[card.suit]}</div>
      <div class="corner bottom"><span>${card.rank}</span><span>${suitMarks[card.suit]}</span></div>
    </div>
  `;
}

function renderCardZone(element, cards, zone) {
  const key = `${room.handId}:${cards.map(cardKey).join("|")}`;
  const previousKey = zone === "community" ? lastCommunityKey : lastHoleKey;
  if (key === previousKey) return;
  const shouldAnimate = room.handId !== lastHandId || previousKey !== "";
  element.innerHTML = cards.map(renderCard).join("");
  if (shouldAnimate) {
    element.querySelectorAll(".card:not(.empty)").forEach((card) => card.classList.add("deal-card"));
  }
  if (zone === "community") lastCommunityKey = key;
  else lastHoleKey = key;
}

function cardKey(card) {
  if (card === null) return "hidden";
  if (card === undefined) return "empty";
  return `${card.rank}-${card.suit}`;
}

function renderMiniCard(card) {
  return card ? `<span class="mini-card ${card.suit === "hearts" || card.suit === "diamonds" ? "red-suit" : ""}">${card.rank}${suitMarks[card.suit]}</span>` : `<span class="mini-card back"></span>`;
}

function initials(name) {
  return String(name).split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function boot() {
  try {
    const data = await api("/api/me");
    me = data.user;
    room = data.room;
    syncClock();
    room ? showTable() : showLobby();
  } catch {
    loginPanel.classList.remove("hidden");
  }
}

async function refreshRoom({ quiet = false } = {}) {
  try {
    const data = await api("/api/me");
    me = data.user;
    room = data.room;
    syncClock();
    return room;
  } catch (error) {
    if (!quiet) throw error;
    return null;
  }
}

function syncClock() {
  if (room?.serverNow) clockOffset = room.serverNow - Date.now();
}

setInterval(async () => {
  if (!me) return;
  try {
    await refreshRoom();
    if (room) render();
  } catch {
    me = null;
  }
}, 1000);

setInterval(() => {
  if (room && !["lobby", "showdown"].includes(room.status)) render();
}, 250);

boot();
