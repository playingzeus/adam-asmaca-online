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
    if (!isLetter) return ch; // boşluk, tire, noktalama açık kalsın
    if (guessedSet.has(lower)) return ch;
    return "_";
  });
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,         // kelimeyi yazan
      guestId: null,        // tahmin eden
      names: new Map(),     // socketId -> name
      phase: "waiting",     // waiting | playing
      secretRaw: "",
      secretNorm: "",
      guessed: new Set(),
      wrong: 0,
      maxWrong: 6,          // kafa, gövde, 2 kol, 2 bacak
      lastGuess: null,      // { by, letter, hit }
      roundOver: null,      // { winnerId, loserId, winnerName, loserName, secret, wonByGuesser }
      swapTimer: null,
    });
  }
  return rooms.get(roomId);
}

function getName(r, id) {
  if (!id) return "";
  return r.names.get(id) || "Oyuncu";
}

function publicState(roomId, r) {
  const revealed = r.secretRaw ? maskSecret(r.secretRaw, r.guessed) : [];

  return {
    roomId,
    phase: r.phase,
    hostId: r.hostId,
    guestId: r.guestId,
    names: {
      host: r.hostId ? getName(r, r.hostId) : "",
      guest: r.guestId ? getName(r, r.guestId) : "",
    },
    wrong: r.wrong,
    maxWrong: r.maxWrong,
    guessed: Array.from(r.guessed),
    revealed,
    lastGuess: r.lastGuess,
    // roundOver server'dan ayrı event olarak gidiyor, ama state'de de dursun
    roundOver: r.roundOver,
  };
}

function cleanupRoomIfEmpty(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  if (!r.hostId && !r.guestId) rooms.delete(roomId);
}

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    const roomId = nanoid(8);
    ensureRoom(roomId);
    socket.emit("roomCreated", { roomId });
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!roomId) return;

    const r = ensureRoom(roomId);

    // isim kaydet
    const safeName = String(name || "").trim().slice(0, 20) || "Oyuncu";
    r.names.set(socket.id, safeName);

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
    else r.phase = "waiting";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("setSecret", ({ roomId, secret }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (socket.id !== r.hostId) return;
    if (!secret || !secret.trim()) return;

    // önceki timer varsa temizle
    if (r.swapTimer) {
      clearTimeout(r.swapTimer);
      r.swapTimer = null;
    }

    r.secretRaw = secret.trim();
    r.secretNorm = normalizeTR(r.secretRaw);
    r.guessed = new Set();
    r.wrong = 0;
    r.lastGuess = null;
    r.roundOver = null;

    r.phase = (r.hostId && r.guestId) ? "playing" : "waiting";

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("guess", ({ roomId, letter }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.phase !== "playing") return;
    if (socket.id !== r.guestId) return; // sadece guest tahmin eder

    let l = String(letter || "").trim().toLocaleLowerCase("tr-TR");
    if (l.length !== 1) return;
    if (!/[a-zçğıöşü]/.test(l)) return;
    if (r.guessed.has(l)) return;

    r.guessed.add(l);
    const hit = r.secretNorm.includes(l);
    if (!hit) r.wrong += 1;
    r.lastGuess = { by: socket.id, letter: l, hit };

    const revealed = maskSecret(r.secretRaw, r.guessed);
    const won = !revealed.includes("_");            // tahmin eden kazandı
    const lost = r.wrong >= r.maxWrong;             // tahmin eden kaybetti

    if (won || lost) {
      const winnerId = won ? r.guestId : r.hostId;
      const loserId = won ? r.hostId : r.guestId;

      r.roundOver = {
        winnerId,
        loserId,
        winnerName: getName(r, winnerId),
        loserName: getName(r, loserId),
        secret: r.secretRaw,
        wonByGuesser: won,
      };

      // Tur bitti ekranını herkes görsün (kelime de burada gösteriliyor)
      io.to(roomId).emit("roundOver", r.roundOver);

      // 2 saniye sonra roller değişsin ve yeni tur beklesin
      if (r.swapTimer) clearTimeout(r.swapTimer);
      r.swapTimer = setTimeout(() => {
        // oda hâlâ var mı?
        const rr = rooms.get(roomId);
        if (!rr) return;

        // iki kişi varsa swap
        if (rr.hostId && rr.guestId) {
          const oldHost = rr.hostId;
          rr.hostId = rr.guestId;
          rr.guestId = oldHost;
        }

        // yeni tur reset (kelime yeni host tarafından girilecek)
        rr.secretRaw = "";
        rr.secretNorm = "";
        rr.guessed = new Set();
        rr.wrong = 0;
        rr.lastGuess = null;
        rr.phase = "waiting";
        // roundOver bilgisi dursun (ekranda gösterildi zaten), ama state'te kalsın sorun değil

        rr.swapTimer = null;

        io.to(roomId).emit("state", publicState(roomId, rr));
      }, 2000);

      // state'i de hemen güncelleyelim (klavye kilitlensin vs)
      io.to(roomId).emit("state", publicState(roomId, r));
      return;
    }

    io.to(roomId).emit("state", publicState(roomId, r));
  });

  socket.on("disconnect", () => {
    for (const [roomId, r] of rooms.entries()) {
      let changed = false;

      if (r.hostId === socket.id) { r.hostId = null; changed = true; }
      if (r.guestId === socket.id) { r.guestId = null; changed = true; }
      if (r.names.has(socket.id)) { r.names.delete(socket.id); changed = true; }

      if (changed) {
        if (r.swapTimer) {
          clearTimeout(r.swapTimer);
          r.swapTimer = null;
        }

        // biri gidince oyunu resetle (basit)
        r.secretRaw = "";
        r.secretNorm = "";
        r.guessed = new Set();
        r.wrong = 0;
        r.lastGuess = null;
        r.phase = "waiting";
        r.roundOver = null;

        io.to(roomId).emit("state", publicState(roomId, r));
        cleanupRoomIfEmpty(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on :${PORT}`));
