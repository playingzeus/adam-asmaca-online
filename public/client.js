const socket = io({ transports: ["websocket", "polling"] });

const el = (id) => document.getElementById(id);

const roomIdEl = el("roomId");
const newRoomBtn = el("newRoom");
const copyLinkBtn = el("copyLink");

const statusEl = el("status");
const roleEl = el("role");
const namesLine = el("namesLine");

const wordEl = el("word");
const wrongEl = el("wrong");
const guessedEl = el("guessed");
const lastEl = el("last");

const setBox = el("setBox");
const secretInput = el("secretInput");
const setSecretBtn = el("setSecretBtn");

const keyboardEl = el("keyboard");

// name modal
const nameModal = el("nameModal");
const nameInput = el("nameInput");
const nameBtn = el("nameBtn");

// overlay
const overlay = el("overlay");
const ovTitle = el("ovTitle");
const ovSub = el("ovSub");
const ovSecret = el("ovSecret");

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
let myName = "";

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

function showNameModal() {
  nameModal.classList.remove("hidden");
  nameModal.style.display = "flex";
  setTimeout(() => nameInput.focus(), 50);
}
function hideNameModal() {
  nameModal.classList.add("hidden");
  nameModal.style.display = "none";
}

function showOverlay(title, sub, secret) {
  ovTitle.textContent = title;
  ovSub.textContent = sub;
  ovSecret.textContent = `Kelime: “${secret}”`;
  overlay.classList.remove("hidden");
}
function hideOverlay() {
  overlay.classList.add("hidden");
}

function renderKeyboard(disabled, guessedSet, lastGuess) {
  keyboardEl.innerHTML = "";
  LETTERS.forEach((L) => {
    const btn = document.createElement("button");
    btn.className = "key";
    btn.textContent = L;

    const l = L.toLocaleLowerCase("tr-TR");
    const isGuessed = guessedSet.has(l);

    btn.disabled = disabled || isGuessed;

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
  myId = socket.id;

  roomIdEl.textContent = s.roomId || "—";
  copyLinkBtn.disabled = !s.roomId;

  const amHost = s.hostId === myId;
  const amGuest = s.guestId === myId;

  // isim satırı
  if (s.names?.host || s.names?.guest) {
    const host = s.names.host ? `${s.names.host} (Kelime)` : "—";
    const guest = s.names.guest ? `${s.names.guest} (Tahmin)` : "—";
    namesLine.textContent = `${host}  vs  ${guest}`;
  } else {
    namesLine.textContent = "—";
  }

  // role pill
  if (amHost) setRole("Sen: Kelime yazan");
  else if (amGuest) setRole("Sen: Tahmin eden");
  else setRole("—");

  // status
  if (!s.hostId) setStatus("Oda boş. Yeni oda aç.");
  else if (s.hostId && !s.guestId) setStatus("Rakip bekleniyor… Linki gönder.");
  else if (s.phase === "waiting") setStatus("Kelime bekleniyor…");
  else if (s.phase === "playing") setStatus("Oyun başladı.");

  // host için kelime kutusu
  setBox.style.display = amHost ? "block" : "none";
  setSecretBtn.disabled = !amHost || !secretInput.value.trim();

  // parts + meta
  renderParts(s.wrong || 0);
  wrongEl.textContent = String(s.wrong ?? 0);
  guessedEl.textContent = s.guessed && s.guessed.length ? s.guessed.join(", ") : "—";

  // word
  if (amHost && s.phase === "waiting" && (!s.revealed || s.revealed.length === 0)) {
    wordEl.textContent = "Kelimeyi girip başlat.";
  } else {
    renderWord(s.revealed);
  }

  // last guess
  if (s.lastGuess) {
    const who = (s.lastGuess.by === s.guestId) ? (s.names?.guest || "Tahmin eden") : "Biri";
    const L = s.lastGuess.letter.toLocaleUpperCase("tr-TR");
    lastEl.textContent = `Son tahmin: ${who} → “${L}” (${s.lastGuess.hit ? "doğru" : "yanlış"})`;
  } else {
    lastEl.textContent = "Son tahmin: —";
  }

  // keyboard sadece guest oynarken aktif
  const guessedSet = new Set((s.guessed || []).map(x => x.toLocaleLowerCase("tr-TR")));
  const keyboardDisabled = !(amGuest && s.phase === "playing") || !s.hostId || !s.guestId;
  renderKeyboard(keyboardDisabled, guessedSet, s.lastGuess);
}

// --- Socket events ---

socket.on("connect", () => {
  myId = socket.id;

  // isim yoksa modal aç
  const saved = localStorage.getItem("hangman_name") || "";
  myName = saved.trim();
  if (!myName) {
    showNameModal();
  } else {
    hideNameModal();
  }

  const room = getRoomFromUrl();
  if (room && myName) {
    currentRoom = room;
    socket.emit("joinRoom", { roomId: room, name: myName });
  } else if (!room) {
    setStatus("Yeni oda oluştur.");
  } else if (room && !myName) {
    setStatus("İsim seç…");
  }
});

socket.on("roomCreated", ({ roomId }) => {
  currentRoom = roomId;
  setRoomInUrl(roomId);
  socket.emit("joinRoom", { roomId, name: myName });
});

socket.on("roomFull", () => setStatus("Oda dolu. Yeni oda aç."));

socket.on("state", (s) => {
  if (!currentRoom && s?.roomId) currentRoom = s.roomId;
  updateUI(s);
});

socket.on("roundOver", (info) => {
  // info: {winnerName, loserName, secret, wonByGuesser}
  const title = `${info.winnerName} kazandı ✅`;
  const sub = `${info.loserName} kaybetti ❌`;
  showOverlay(title, sub, info.secret);

  // overlay 2.1s sonra kapansın (server 2s sonra swap ediyor)
  setTimeout(() => hideOverlay(), 2100);
});

// --- UI events ---

newRoomBtn.addEventListener("click", () => {
  if (!myName) {
    showNameModal();
    return;
  }
  socket.emit("createRoom");
});

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

// name modal
nameBtn.addEventListener("click", () => {
  const n = (nameInput.value || "").trim().slice(0, 20);
  if (!n) return;
  myName = n;
  localStorage.setItem("hangman_name", myName);
  hideNameModal();

  const room = getRoomFromUrl();
  if (room) {
    currentRoom = room;
    socket.emit("joinRoom", { roomId: room, name: myName });
  } else {
    setStatus("Yeni oda oluştur.");
  }
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameBtn.click();
});
