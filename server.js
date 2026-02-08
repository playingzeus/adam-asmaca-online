const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"],
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

// ---- helpers ----
function normalizeTR(s) {
  return s
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ");
}

function maskSecret(secretRaw, guessedSet) {
  const chars = [...secretRaw];
  return chars.map((ch) => {
    const lower = ch.toLocaleLowerCase("tr-TR");
    const isLetter = /[a-zçğıöşü]/i.test(ch);
    if (!isLetter) return ch;
    if (guessedSet.has(lower)) return ch;
    return "_";
  });
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      // fixed player slots (scores follow players, not host/guest)
      p1Id: null,
      p2Id: null,

      // roles (swap every round)
      hostId: null,  // word setter
      guestId: null, // guesser

      // names
      names: new Map(), // socketId -> name

      // game state
      phase: "waiting", // waiting | playing
      secretRaw: "",
      secretNorm: "",
      guessed: new Set(),
      wrong: 0,
      maxWrong: 6,
      lastGuess: null,

      // scoring
      pointsToWinSet: 5,
      setsToWinMatch: 2,
      points: { p1: 0, p2: 0 }, // within current set
      sets: { p1: 0, p2: 0 },   // sets won
      currentSet: 1,            // 1..3

      // timers
      nextTimer: null,
    });
  }
  return rooms.get(roomId);
}

function getName(r, id) {
  if (!id) return "";
  return r.names.get(id) || "Oyuncu";
}

function playerSlot(r, id) {
  if (!id) return null;
  if (id === r.p1Id) return "p1";
  if (id === r.p2Id) return "p2";
  return null;
}

function publicState(roomId, r) {
  const revealed = r.secretRaw ? maskSecret(r.secretRaw, r.guessed) : [];

  return {
    roomId,
    phase: r.phase,

    // ids
    hostId: r.hostId,
    guestId: r.guestId,
    p1Id: r.p1Id,
    p2Id: r.p2Id,

    // names
    names: {
      host: r.hostId ? getName(r, r.hostId) : "",
      guest: r.guestId ? getName(r, r.guestId) : "",
      p1: r.p1Id ? getName(r, r.p1Id) : "",
      p2: r.p2Id ? getName(r, r.p2Id) : "",
    },

    // hangman (NEVER send secretRaw here)
    wrong: r.wrong,
    maxWrong: r.maxWrong,
    guessed: Array.from(r.guessed),
    revealed,
    lastGuess: r.lastGuess,

    // scoring
    scoring: {
      pointsToWinSet: r.pointsToWinSet,
      setsToWinMatch: r.setsToWinMatch,
      points: r.points,
      sets: r.sets,
      currentSet: r.currentSet,
    },
  };
}

function cleanupRoomIfEmpty(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  if (!r.hostId && !r.guestId && !r.p1Id && !r.p2Id) rooms.delete(roomId);
}

function clearNextTimer(r) {
  if (r.nextTimer) {
    clearTimeout(r.nextTimer);
    r.nextTimer = null;
  }
}

function resetRound(r) {
  r.secretRaw = "";
  r.secretNorm = "";
  r.guessed = new Set();
  r.wrong = 0;
  r.lastGuess = null;
  r.phase = "waiting";
}

function resetMatch(r) {
  r.points = { p1: 0, p2: 0 };
  r.sets = { p1: 0, p2: 0 };
  r.currentSet = 1;
}

// ---- socket ----
io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    const roomId = nanoid(8);
    ensureRoom(roomId);
    socket.emit("roomCreated", { roomId });
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!roomId) return;

    const r = ensureRoom(roomId);
    const safeName = String(name || "").trim().slice(0, 20) || "Oyuncu";
    r.names.set(socket.id, safeName);

    // assign player slots
    if (!r.p1Id) r.p1I
