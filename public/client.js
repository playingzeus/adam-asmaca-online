const socket = io({ transports: ["websocket", "polling"] });

const el = (id) => document.getElementById(id);

const roomIdEl = el("roomId");
const newRoomBtn = el("newRoom");
const copyLinkBtn = el("copyLink");

const statusEl = el("status");
const roleEl = el("role");

const wordEl = el("word");
const wrongEl = el("wrong");
const guessedEl = el("guessed");
const lastEl = el("last");

const setBox = el("setBox");
const secretInput = el("secretInput");
const setSecretBtn = el("setSecretBtn");

const keyboardEl = el("keyboard");
const newGameBtn = el("newGameBtn");

// parts
const parts = [
  el("p-head"),
  el("p-body"),
  el("p-armL"),
  el("p-armR"),
  el("p-legL"),
  el("p-legR"),
];

const LETTERS = "ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ".split("");

let myId = null;
let currentRoom = null;
let state = null;

function getRoomFromUrl() {
  const u = new URL(window.location.href);
  return u.searchParams.get("room");
}
function setRoomInUrl(roomId) {
  const u = new URL(window.location.href);
  u.searchParams.set("room", roomId);
  window.history.replaceState({}, "", u.toString());
}

function setStatus(t) { statusEl.textContent = t; }
function setRole(t) { roleEl.textContent = t; }

function renderKeyboard(disabled, guessedSet, lastGuess) {
  keyboardEl.innerHTML = "";
  LETTERS.forEach((L) => {
    const btn = document.createElement("button");
    btn.className = "key";
    btn.textContent = L;
    const l = L.toLocaleLowerCase("tr-TR");
    const isGuessed = guessedSet.has(l);

    if (isGuessed) btn.disabled = true;
    if (disabled) btn.disabled = true;

    // son tahmine göre renkle
    if (lastGuess && lastGuess.letter === l) {
      btn.classList.add(lastGuess.hit ? "hit" : "miss");
    }

    btn.addEventListener("click", () => {
      socket.emit("guess", { roomId: currentRoom, letter: l });
    });

    keyboardEl.appendChild(btn);
  });
}

function renderParts(wrongCount) {
  parts.forEach((p, i) => {
    if (!p) return;
    if (i < wrongCount) p.classList.remove("hidden");
    else p.classList.add("hidden");
  });
}

function renderWord(revealedArr) {
  if (!revealedArr || revealedArr.length === 0) {
    wordEl.textContent = "—";
    return;
  }
  wordEl.textContent = revealedArr.join(" ");
}

function updateUI(s) {
  state = s;
  roomIdEl.textContent = s.roomId || "—";
  copyLinkBtn.disabled = !s.roomId;

  myId = socket.id;

  const amHost = s.hostId === myId;
  const amGuest = s.guestId === myId;

  if (amHost) setRole("Sen: Kelimeyi yazan");
  else if (amGuest) setRole("Sen: Tahmin eden");
  else setRole("—");

  // status
  if (!s.players.host) setStatus("Oda boş. Yenile / Yeni oda.");
  else if (s.players.host && !s.players.guest) setStatus("Rakip bekleniyor… Linki gönder.");
  else if (s.phase === "waiting") setStatus("Kelime bekleniyor…");
  else if (s.phase === "playing") setStatus("Oyun başladı.");
  else if (s.phase === "over") setStatus(s.won ? "TAHMİN EDEN kazandı ✅" : "Kaybettiniz ❌ (adam asıldı)");

  // host için kelime kutusu
  setBox.style.display = amHost ? "block" : "none";
  setSecretBtn.disabled = !amHost || !secretInput.value.trim();

  // new game butonu sadece host ve oyun bitince aktif
  newGameBtn.disabled = !(amHost);

  // parts
  renderParts(s.wrong || 0);

  // word
  if (amHost && (s.phase === "waiting") && (!s.revealed || s.revealed.length === 0)) {
    wordEl.textContent = "Kelimeyi girip başlat.";
  } else {
    renderWord(s.revealed);
  }

  // guessed list (host da görsün!)
  guessedEl.textContent = s.guessed && s.guessed.length ? s.guessed.join(", ") : "—";
  wrongEl.textContent = String(s.wrong ?? 0);

  // last guess
  if (s.lastGuess) {
    const who = (s.lastGuess.by === s.guestId) ? "Tahmin eden" : "Biri";
    lastEl.textContent = `Son tahmin: ${who} → “${s.lastGuess.letter.toLocaleUpperCase("tr-TR")}” (${s.lastGuess.hit ? "doğru" : "yanlış"})`;
  } else {
    lastEl.textContent = "Son tahmin: —";
  }

  // keyboard sadece guest oynarken aktif
  const guessedSet = new Set((s.guessed || []).map(x => x.toLocaleLowerCase("tr-TR")));
  const keyboardDisabled = !(amGuest && s.phase === "playing");
  renderKeyboard(keyboardDisabled, guessedSet, s.lastGuess);

  // oyun bitince guest klavyeyi kilitle
}

socket.on("connect", () => {
  myId = socket.id;

  const room = getRoomFromUrl();
  if (room) {
    currentRoom = room;
    socket.emit("joinRoom", { roomId: room });
  } else {
    setStatus("Yeni oda oluştur.");
  }
});

socket.on("roomCreated", ({ roomId }) => {
  currentRoom = roomId;
  setRoomInUrl(roomId);
  socket.emit("joinRoom", { roomId });
});

socket.on("roomFull", () => setStatus("Oda dolu. Yeni oda aç."));

socket.on("state", (s) => {
  if (!currentRoom && s?.roomId) currentRoom = s.roomId;
  updateUI(s);
});

newRoomBtn.addEventListener("click", () => socket.emit("createRoom"));

copyLinkBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(window.location.href);
  setStatus("Link kopyalandı. Arkadaşına at.");
});

secretInput.addEventListener("input", () => {
  if (!state) return;
  setSecretBtn.disabled = !(state.hostId === socket.id && secretInput.value.trim());
});

setSecretBtn.addEventListener("click", () => {
  if (!currentRoom) return;
  socket.emit("setSecret", { roomId: currentRoom, secret: secretInput.value });
  secretInput.value = "";
  setSecretBtn.disabled = true;
});

newGameBtn.addEventListener("click", () => {
  if (!currentRoom) return;
  socket.emit("newGame", { roomId: currentRoom });
});
