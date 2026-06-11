/* ===== Рисуй & Угадай — Socket.IO сервер ===== */
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { WORDS } from "./words.js";

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("Draw & Guess server is running 💕"));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ---- Настройки игры ----
const ROUND_TIME = 80;        // секунд на раунд
const DEFAULT_ROUNDS = 6;     // раундов по умолчанию
const MIN_ROUNDS = 1, MAX_ROUNDS = 99; // допустимые границы
const POINTS_GUESS = 100;  // очки угадавшему
const POINTS_DRAW = 60;    // очки рисующему за успех

// ---- Хранилище комнат ----
const rooms = new Map();

// Перемешивание (Fisher–Yates) — для случайного порядка без повторов
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Берём следующее слово из «колоды» комнаты — без повторов.
// Когда слова кончаются (если раундов больше, чем слов) — колода тасуется заново.
function drawWord(room) {
  if (!room.deck || room.deck.length === 0) room.deck = shuffle(WORDS);
  return room.deck.pop();
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function getRoom(code) { return rooms.get(code); }

function publicPlayers(room) {
  return room.players.map((p) => ({
    id: p.id, name: p.name, score: p.score, isDrawer: p.id === room.drawerId,
  }));
}

function normalize(s) {
  return String(s).toLowerCase().trim()
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9 ]/g, "")
    .replace(/\s+/g, " ");
}

// Расстояние Левенштейна — для определения «почти угадал»
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

// ---- Игровой цикл ----
function startGame(room) {
  room.round = 0;
  room.deck = shuffle(WORDS); // свежая перетасованная колода на каждую игру
  room.players.forEach((p) => (p.score = 0));
  nextRound(room);
}

function nextRound(room) {
  if (room.timer) clearInterval(room.timer);
  room.round += 1;

  if (room.round > room.totalRounds) return endGame(room);
  if (room.players.length < 2) return;

  // Чередуем рисующего
  room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
  room.drawerId = room.players[room.drawerIndex].id;
  room.word = drawWord(room);
  room.guessed = false;
  room.timeLeft = ROUND_TIME;

  io.to(room.code).emit("room:update", { players: publicPlayers(room) });

  // Каждому — своя версия события (слово только рисующему)
  room.players.forEach((p) => {
    io.to(p.id).emit("game:start", {
      drawerId: room.drawerId,
      round: room.round,
      totalRounds: room.totalRounds,
      word: p.id === room.drawerId ? room.word : null,
      maskLength: room.word.length,
    });
  });

  io.to(room.code).emit("timer:tick", room.timeLeft);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.code).emit("timer:tick", room.timeLeft);
    if (room.timeLeft <= 0) endRound(room, false);
  }, 1000);
}

function endRound(room, guessed) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  io.to(room.code).emit("round:end", {
    word: room.word,
    guessed,
    scores: publicPlayers(room),
  });
  setTimeout(() => nextRound(room), 3500);
}

function endGame(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  const scores = publicPlayers(room).sort((a, b) => b.score - a.score);
  const draw = scores.length === 2 && scores[0].score === scores[1].score;
  io.to(room.code).emit("game:over", { winner: scores[0], scores, draw });
}

// ---- Сокеты ----
io.on("connection", (socket) => {

  socket.on("room:create", ({ name, rounds }) => {
    const code = makeCode();
    let total = parseInt(rounds, 10);
    if (!Number.isFinite(total)) total = DEFAULT_ROUNDS;
    total = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, total));
    const room = {
      code, players: [], drawerIndex: -1, drawerId: null,
      round: 0, totalRounds: total, word: null, timer: null, guessed: false, timeLeft: 0,
    };
    rooms.set(code, room);
    joinRoom(socket, room, name);
    socket.emit("room:created", { room: code });
  });

  socket.on("room:join", ({ name, room: code }) => {
    const room = getRoom(code);
    if (!room) return socket.emit("room:error", { message: "Комната не найдена 🔍" });
    if (room.players.length >= 2) return socket.emit("room:error", { message: "Комната заполнена (макс. 2) 👫" });
    joinRoom(socket, room, name);
    // Второй игрок зашёл — стартуем!
    if (room.players.length === 2) {
      io.to(room.code).emit("room:update", { players: publicPlayers(room) });
      setTimeout(() => startGame(room), 600);
    }
  });

  socket.on("draw:stroke", (s) => {
    const room = getRoom(s.room);
    if (!room || socket.id !== room.drawerId) return;
    socket.to(room.code).emit("draw:stroke", s);
  });

  socket.on("draw:clear", ({ room: code }) => {
    const room = getRoom(code);
    if (!room || socket.id !== room.drawerId) return;
    socket.to(code).emit("draw:clear");
  });

  socket.on("guess:try", ({ room: code, text }) => {
    const room = getRoom(code);
    if (!room || !room.word || room.guessed) return;
    if (socket.id === room.drawerId) return; // рисующий не угадывает

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const guess = normalize(text);
    const answer = normalize(room.word);

    if (guess === answer) {
      room.guessed = true;
      player.score += POINTS_GUESS;
      const drawer = room.players.find((p) => p.id === room.drawerId);
      if (drawer) drawer.score += POINTS_DRAW;
      io.to(code).emit("guess:correct", {
        guesserId: player.id, guesserName: player.name, word: room.word,
      });
      io.to(code).emit("room:update", { players: publicPlayers(room) });
      return endRound(room, true);
    }

    // «почти угадал» — подсказка только тому, кто пишет
    const dist = levenshtein(guess, answer);
    if (dist > 0 && dist <= 2 && answer.length > 3) {
      socket.emit("guess:close");
    }
  });

  socket.on("game:restart", ({ room: code }) => {
    const room = getRoom(code);
    if (!room || room.players.length < 2) return;
    room.drawerIndex = -1;
    startGame(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.timer) clearInterval(room.timer);
        socket.to(room.code).emit("player:left");
        if (room.players.length === 0) rooms.delete(room.code);
        else io.to(room.code).emit("room:update", { players: publicPlayers(room) });
      }
    }
  });
});

function joinRoom(socket, room, name) {
  socket.join(room.code);
  room.players.push({ id: socket.id, name: (name || "Игрок").slice(0, 16), score: 0 });
  io.to(room.code).emit("room:update", { players: publicPlayers(room) });
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`💕 Draw & Guess server on :${PORT}`));
