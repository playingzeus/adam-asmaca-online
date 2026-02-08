const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

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

function roomPublicState(roomId, r) {
  return {
    roomId,
    phase: r.phase,
    hint: r.hint || "",
    revealed: r.revealed || [],
    guessed: Array.from(r.guessed || []),
    wrong: r.wrong ?? 0,
    maxWrong: r.maxWrong ?? 7,
    turn: r.turn || null,
    players: { host: !!r.hostId, guest: !!r.guestId },
    winner: r.winner || null,
    hostId: r.hostId || null,
    guestId: r.guestId || null,
  };
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,
      guestId: null,
      phase: "lobby",
      secretRaw: "",
      secretNorm: "",
      hint: "",
      revealed: [],
      guessed: new Set(),
      wrong: 0,
      maxWrong: 7,
      turn: null,
      winner: null,
    });
  }
  return rooms.get(roomId);
}

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    const roomId = nanoid(8);
    ensureRoom(roomId);
    socket.emit("roomCreated", { roomId });
  });

  socket.on("joinRoom", ({ roomId }) => {
    if (!roomId) return;
    const r = ensureRoom(roomId);

    if (socket.rooms.has(roomId)) return;

    if (!r.hostId) r.hostId = socket.id;
    else if (!r.guestId && socket.id !== r.hostId) r.guestId = socket.id;
    else {
      socket.emit("roomFull", { roomId });
      return;
    }

    socket.join(roomId);

    if (r.hostId && !r.guestId) r.phase = "set";
    if (r.hostId && r.guestId && r.secretNorm) {
      r.phase = "playing";
      if (!r.turn) r.turn = r.hostId;
    }

    io.to(roomId).emit("state", roomPublicState(roomId, r));
    io.to(roomId).emit("systemMsg", { text: "Bir oyuncu bağlandı." });
  });

  socket.on("setSecret", ({ roomId, secret, hint, maxWrong }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;
    if (!secret || !secret.trim()) return;

    r.secretRaw = secret.trim();
    r.secretNorm = normalizeTR(r.secretRaw);
    r.hint = (hint || "").trim();
    r.maxWrong = Number.isFinite(+maxWrong) ? Math.max(3, Math.min(12, +maxWrong)) : 7;

    r.guessed = new Set();
    r.wrong = 0;
    r.winner = null;
    r.revealed = maskSecret(r.secretRaw, r.guessed);
    r.phase = r.guestId ? "playing" : "set";
    r.turn = r.hostId;

    io.to(roomId).emit("state", roomPublicState(roomId, r));
    io.to(roomId).emit("systemMsg", { text: "Kelime ayarlandı. Oyun başladı!" });
  });

  socket.on("guess", ({ roomId, letter }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.phase !== "playing") return;
    if (socket.id !== r.turn) return;

    if (!letter) return;
    let l = String(letter).trim().toLocaleLowerCase("tr-TR");

    if (l.length !== 1) return;
    if (!/[a-zçğıöşü]/.test(l)) return;
    if (r.guessed.has(l)) return;

    r.guessed.add(l);

    const hit = r.secretNorm.includes(l);
    if (!hit) r.wrong += 1;

    r.revealed = maskSecret(r.secretRaw, r.guessed);

    const won = !r.revealed.includes("_");
    const lost = r.wrong >= r.maxWrong;

    if (won || lost) {
      r.phase = "over";
      r.winner = won ? socket.id : (socket.id === r.hostId ? r.guestId : r.hostId);
      io.to(roomId).emit("revealSecret", { secret: r.secretRaw });
    } else {
      r.turn = (socket.id === r.hostId ? r.guestId : r.hostId);
    }

    io.to(roomId).emit("state", roomPublicState(roomId, r));
  });

  socket.on("rematch", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;

    r.phase = "set";
    r.secretRaw = "";
    r.secretNorm = "";
    r.hint = "";
    r.guessed = new Set();
    r.wrong = 0;
    r.winner = null;
    r.revealed = [];
    r.turn = r.hostId;

    io.to(roomId).emit("state", roomPublicState(roomId, r));
    io.to(roomId).emit("systemMsg", { text: "Yeni oyun için kelime bekleniyor." });
  });

  socket.on("chat", ({ roomId, text }) => {
    const t = (text || "").trim();
    if (!t) return;
    io.to(roomId).emit("chat", { from: socket.id, text: t });
  });

  socket.on("typing", ({ roomId, isTyping }) => {
    socket.to(roomId).emit("typing", { from: socket.id, isTyping: !!isTyping });
  });

  socket.on("disconnect", () => {
    for (const [roomId, r] of rooms.entries()) {
      let changed = false;
      if (r.hostId === socket.id) { r.hostId = null; changed = true; }
      if (r.guestId === socket.id) { r.guestId = null; changed = true; }

      if (changed) {
        r.phase = "lobby";
        r.secretRaw = "";
        r.secretNorm = "";
        r.hint = "";
        r.guessed = new Set();
        r.wrong = 0;
        r.winner = null;
        r.revealed = [];
        r.turn = null;

        io.to(roomId).emit("state", roomPublicState(roomId, r));
        io.to(roomId).emit("systemMsg", { text: "Bir oyuncu ayrıldı. Oyun sıfırlandı." });

        if (!r.hostId && !r.guestId) rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
