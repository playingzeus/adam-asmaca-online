const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"], // Render'da daha stabil
});

app.use(express.static(path.join(__dirname, "public")));

// room state (memory)
const rooms = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,      // kelimeyi giren
      guestId: null,     // tahmin eden
      phase: "waiting",  // waiting | playing | over
      secretRaw: "",
      secretNorm: "",
      guessed: new Set(),
      wrong: 0,
      maxWrong: 6,       // klasik 6 parça (kafa/gövde/2kol/2bacak)
      lastGuess: null,   // { by, letter, hit }
    });
  }
  return rooms.get(roomId);
}

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
    if (!isLetter) return ch;          // boşluk, tire vs açılsın
    if (guessedSet.has(lower)) return ch;
    return "_";
  });
}

function publicState(roomId, r) {
  const revealed = r.secretRaw ? maskSecret(r.secretRaw, r.guessed) : [];
  const won = revealed.length ? !revealed.includes("_") : false;

  return {
    roomId,
    phase: r.phase,
    players: { host: !!r.hostId, guest: !!r.guestId },
    hostId: r.hostId,
    guestId: r.guestId,
    wrong: r.wrong,
    maxWrong: r.maxWrong,
    guessed: Array.from(r.guessed),
    revealed,
    lastGuess: r.lastGuess,
    won,
  };
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

    // role ata
    if (!r.hostId) r.hostId = socket.id;
    else if (!r.guestId && socket.id !== r.hostId) r.guestId = socket.id;
    else {
      socket.emit("roomFull", { roomId });
      return;
    }

    socket.join(roomId);

    // secret varsa ve iki kişi varsa oynat
    if (r.hostId && r.guestId && r.secretNorm) r.phase = "playing";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("setSecret", ({ roomId, secret }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;           // sadece host ayarlar
    if (!secret || !secret.trim()) return;

    r.secretRaw = secret.trim();
    r.secretNorm = normalizeTR(r.secretRaw);
    r.guessed = new Set();
    r.wrong = 0;
    r.lastGuess = null;

    // iki kişi varsa başla, yoksa guest bekle
    r.phase = (r.hostId && r.guestId) ? "playing" : "waiting";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("guess", ({ roomId, letter }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.phase !== "playing") return;
    if (socket.id !== r.guestId) return;          // sadece guest tahmin eder

    let l = String(letter || "").trim().toLocaleLowerCase("tr-TR");
    if (l.length !== 1) return;
    if (!/[a-zçğıöşü]/.test(l)) return;
    if (r.guessed.has(l)) return;

    r.guessed.add(l);
    const hit = r.secretNorm.includes(l);
    if (!hit) r.wrong += 1;

    r.lastGuess = { by: socket.id, letter: l, hit };

    const revealed = maskSecret(r.secretRaw, r.guessed);
    const won = !revealed.includes("_");
    const lost = r.wrong >= r.maxWrong;

    if (won || lost) {
      r.phase = "over";
    }

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("newGame", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;

    // yeni oyun: secret sıfırla, tekrar girilsin
    r.secretRaw = "";
    r.secretNorm = "";
    r.guessed = new Set();
    r.wrong = 0;
    r.lastGuess = null;
    r.phase = "waiting";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("disconnect", () => {
    for (const [roomId, r] of rooms.entries()) {
      let changed = false;

      if (r.hostId === socket.id) { r.hostId = null; changed = true; }
      if (r.guestId === socket.id) { r.guestId = null; changed = true; }

      if (changed) {
        // biri gidince oyunu basitçe sıfırla
        r.secretRaw = "";
        r.secretNorm = "";
        r.guessed = new Set();
        r.wrong = 0;
        r.lastGuess = null;
        r.phase = "waiting";

        io.to(roomId).emit("state", publicState(roomId, r));

        if (!r.hostId && !r.guestId) rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on :${PORT}`));
