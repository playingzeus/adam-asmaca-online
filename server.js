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
    if (!r.p1Id) r.p1Id = socket.id;
    else if (!r.p2Id && socket.id !== r.p1Id) r.p2Id = socket.id;

    // assign roles
    if (!r.hostId) r.hostId = socket.id;
    else if (!r.guestId && socket.id !== r.hostId) r.guestId = socket.id;
    else {
      socket.emit("roomFull", { roomId });
      return;
    }

    socket.join(roomId);

    // phase
    if (r.hostId && r.guestId && r.secretNorm) r.phase = "playing";
    else r.phase = "waiting";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("setSecret", ({ roomId, secret }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;
    if (!secret || !secret.trim()) return;

    clearNextTimer(r);

    r.secretRaw = secret.trim();
    r.secretNorm = normalizeTR(r.secretRaw);
    r.guessed = new Set();
    r.wrong = 0;
    r.lastGuess = null;

    r.phase = (r.hostId && r.guestId) ? "playing" : "waiting";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  // ✅ Host forgot the word: send ONLY to host (never broadcast)
  socket.on("requestSecret", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;
    if (!r.secretRaw) return;
    socket.emit("secretReveal", { secret: r.secretRaw });
  });

  socket.on("guess", ({ roomId, letter }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.phase !== "playing") return;
    if (socket.id !== r.guestId) return;

    let l = String(letter || "").trim().toLocaleLowerCase("tr-TR");
    if (l.length !== 1) return;
    if (!/[a-zçğıöşü]/.test(l)) return;
    if (r.guessed.has(l)) return;

    r.guessed.add(l);
    const hit = r.secretNorm.includes(l);
    if (!hit) r.wrong += 1;
    r.lastGuess = { by: socket.id, letter: l, hit };

    const revealed = maskSecret(r.secretRaw, r.guessed);
    const guesserWon = !revealed.includes("_");
    const guesserLost = r.wrong >= r.maxWrong;

    if (!(guesserWon || guesserLost)) {
      io.to(roomId).emit("state", publicState(roomId, r));
      return;
    }

    // round winner/loser
    const winnerId = guesserWon ? r.guestId : r.hostId;
    const loserId = guesserWon ? r.hostId : r.guestId;

    // update points
    const winnerSlot = playerSlot(r, winnerId);
    if (winnerSlot) r.points[winnerSlot] += 1;

    // set win?
    let setWinnerSlot = null;
    if (r.points.p1 >= r.pointsToWinSet) setWinnerSlot = "p1";
    if (r.points.p2 >= r.pointsToWinSet) setWinnerSlot = "p2";

    let setEnded = false;
    let matchEnded = false;
    let matchWinnerSlot = null;

    if (setWinnerSlot) {
      setEnded = true;
      r.sets[setWinnerSlot] += 1;

      // reset points for next set
      r.points = { p1: 0, p2: 0 };
      r.currentSet = Math.min(3, r.currentSet + 1);

      if (r.sets[setWinnerSlot] >= r.setsToWinMatch) {
        matchEnded = true;
        matchWinnerSlot = setWinnerSlot;
      }
    }

    const info = {
      winnerId,
      loserId,
      winnerName: getName(r, winnerId),
      loserName: getName(r, loserId),
      secret: r.secretRaw,
      guesserWon,

      scoring: {
        pointsToWinSet: r.pointsToWinSet,
        setsToWinMatch: r.setsToWinMatch,
        points: r.points,
        sets: r.sets,
        currentSet: r.currentSet,
      },

      setEnded,
      matchEnded,
      setWinnerName: setEnded
        ? getName(r, setWinnerSlot === "p1" ? r.p1Id : r.p2Id)
        : null,
      matchWinnerName: matchEnded
        ? getName(r, matchWinnerSlot === "p1" ? r.p1Id : r.p2Id)
        : null,
    };

    // send overlay info (includes secret for both, by design at end of round)
    io.to(roomId).emit("roundOver", info);

    // prepare next round
    clearNextTimer(r);

    // swap roles
    if (r.hostId && r.guestId) {
      const oldHost = r.hostId;
      r.hostId = r.guestId;
      r.guestId = oldHost;
    }

    // reset round (word cleared)
    resetRound(r);

    // overlay duration
    const overlayMs = 3000;

    r.nextTimer = setTimeout(() => {
      const rr = rooms.get(roomId);
      if (!rr) return;

      if (info.matchEnded) {
        resetMatch(rr);
      }

      rr.nextTimer = null;
      io.to(roomId).emit("state", publicState(roomId, rr));
    }, overlayMs);

    // push state now (locks keyboard, shows waiting)
    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("disconnect", () => {
    for (const [roomId, r] of rooms.entries()) {
      let changed = false;

      if (r.hostId === socket.id) { r.hostId = null; changed = true; }
      if (r.guestId === socket.id) { r.guestId = null; changed = true; }

      if (r.p1Id === socket.id) { r.p1Id = null; changed = true; }
      if (r.p2Id === socket.id) { r.p2Id = null; changed = true; }

      if (r.names.has(socket.id)) { r.names.delete(socket.id); changed = true; }

      if (changed) {
        clearNextTimer(r);
        resetRound(r);
        resetMatch(r);

        io.to(roomId).emit("state", publicState(roomId, r));
        cleanupRoomIfEmpty(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on :${PORT}`));
