const socket = io();

const el = (id) => document.getElementById(id);

const roomIdEl = el("roomId");
const copyLinkBtn = el("copyLink");
const newRoomBtn = el("newRoom");

const statusEl = el("status");
const hintTextEl = el("hintText");
const revealEl = el("reveal");
const wrongBar = el("wrongBar");
const wrongText = el("wrongText");
const turnEl = el("turn");
const guessedListEl = el("guessedList");

const guessInput = el("guessInput");
const guessBtn = el("guessBtn");
const rematchBtn = el("rematchBtn");

const secretInput = el("secretInput");
const hintInput = el("hintInput");
const maxWrongInput = el("maxWrongInput");
const setSecretBtn = el("setSecretBtn");

const chatBox = el("chatBox");
const chatInput = el("chatInput");
const sendChatBtn = el("sendChat");
const typingEl = el("typing");

let myId = null;
let currentRoom = null;
let lastState = null;
let typingTimer = null;

function getRoomFromUrl() {
  const u = new URL(window.location.href);
  return u.searchParams.get("room");
}

function setRoomInUrl(roomId) {
  const u = new URL(window.location.href);
  u.searchParams.set("room", roomId);
  window.history.replaceState({}, "", u.toString());
}

function sysMsg(text) {
  const p = document.createElement("p");
  p.className = "msg sys";
  p.textContent = "• " + text;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function chatMsg(from, text) {
  const p = document.createElement("p");
  p.className = "msg " + (from === myId ? "me" : "them");
  p.textContent = (from === myId ? "Sen: " : "O: ") + text;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updateUI(state) {
  lastState = state;

  roomIdEl.textContent = state?.roomId || "—";
  copyLinkBtn.disabled = !state?.roomId;

  hintTextEl.textContent = state?.hint?.length ? state.hint : "—";
  revealEl.textContent = state?.revealed?.length ? state.revealed.join(" ") : "—";

  wrongBar.max = state?.maxWrong ?? 7;
  wrongBar.value = state?.wrong ?? 0;
  wrongText.textContent = `${state?.wrong ?? 0}/${state?.maxWrong ?? 7}`;

  const isMyTurn = state?.turn && state.turn === myId;
  const isPlaying = state?.phase === "playing";
  const isOver = state?.phase === "over";

  guessBtn.disabled = !(isPlaying && isMyTurn);
  guessInput.disabled = !(isPlaying && isMyTurn);

  const amHost = state?.hostId === myId;
  setSecretBtn.disabled = !(state?.phase === "set" && amHost);
  rematchBtn.disabled = !(isOver && amHost);

  guessedListEl.textContent = (state.guessed?.length ? state.guessed.join(", ") : "—");

  if (!state) {
    setStatus("Oda yok.");
    turnEl.textContent = "—";
    return;
  }

  if (state.phase === "lobby") setStatus("Oda beklemede. Linki paylaş.");
  if (state.phase === "set") setStatus(amHost ? "Kelime/ipuçu gir ve başlat." : "Oda sahibi kelime ayarlıyor…");
  if (state.phase === "playing") setStatus("Oyun başladı.");
  if (state.phase === "over") setStatus("Oyun bitti.");

  if (state.phase === "playing") {
    turnEl.textContent = isMyTurn ? "Sıra sende ✅" : "Rakipte ⏳";
  } else if (state.phase === "over") {
    const won = state.winner === myId;
    turnEl.textContent = won ? "Kazandın 🏆" : "Kaybettin 😅";
  } else {
    turnEl.textContent = "—";
  }
}

socket.on("connect", () => {
  myId = socket.id;

  const room = getRoomFromUrl();
  if (room) {
    currentRoom = room;
    socket.emit("joinRoom", { roomId: room });
  } else {
    setStatus("Yeni oda oluştur veya linkle gir.");
  }
});

socket.on("roomCreated", ({ roomId }) => {
  currentRoom = roomId;
  setRoomInUrl(roomId);
  socket.emit("joinRoom", { roomId });
});

socket.on("roomFull", () => {
  setStatus("Oda dolu. Başka link dene.");
});

socket.on("state", (state) => {
  if (state?.roomId && !currentRoom) currentRoom = state.roomId;
  updateUI(state);
});

socket.on("systemMsg", ({ text }) => sysMsg(text));
socket.on("chat", ({ from, text }) => chatMsg(from, text));

socket.on("typing", ({ isTyping }) => {
  typingEl.textContent = isTyping ? "Rakip yazıyor…" : "";
});

socket.on("revealSecret", ({ secret }) => {
  sysMsg(`Kelime: ${secret}`);
});

// UI Events
newRoomBtn.addEventListener("click", () => socket.emit("createRoom"));

copyLinkBtn.addEventListener("click", async () => {
  const url = window.location.href;
  await navigator.clipboard.writeText(url);
  sysMsg("Davet linki kopyalandı.");
});

setSecretBtn.addEventListener("click", () => {
  if (!currentRoom) return;
  socket.emit("setSecret", {
    roomId: currentRoom,
    secret: secretInput.value,
    hint: hintInput.value,
    maxWrong: parseInt(maxWrongInput.value, 10),
  });
  secretInput.value = "";
});

function sendGuess() {
  if (!currentRoom) return;
  const l = guessInput.value.trim();
  if (!l) return;
  socket.emit("guess", { roomId: currentRoom, letter: l });
  guessInput.value = "";
}

guessBtn.addEventListener("click", sendGuess);
guessInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendGuess();
});

rematchBtn.addEventListener("click", () => {
  if (!currentRoom) return;
  socket.emit("rematch", { roomId: currentRoom });
});

function sendChat() {
  if (!currentRoom) return;
  const t = chatInput.value.trim();
  if (!t) return;
  socket.emit("chat", { roomId: currentRoom, text: t });
  chatInput.value = "";
  socket.emit("typing", { roomId: currentRoom, isTyping: false });
}

sendChatBtn.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", () => {
  if (!currentRoom) return;
  socket.emit("typing", { roomId: currentRoom, isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", { roomId: currentRoom, isTyping: false }), 600);
});
chatInput.addEventListener("blur", () => {
  if (!currentRoom) return;
  socket.emit("typing", { roomId: currentRoom, isTyping: false });
});
