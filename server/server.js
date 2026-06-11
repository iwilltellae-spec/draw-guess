/* ===== Рисуй & Угадай — Socket.IO сервер ===== */
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { WORDS } from "./words.js";
import { PICTURES_META } from "./pictures.js";

const SERVER_VERSION = "coop-1.0"; // версия для проверки, что Render обновился

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("Draw & Guess server is running 💕 — version: " + SERVER_VERSION + ", coop: ON"));
app.get("/health", (_req, res) => res.json({ ok: true, version: SERVER_VERSION, coop: true, pictures: PICTURES_META.length, rooms: rooms.size }));

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

// Три РАЗНЫХ слова на выбор
function drawChoices(room, n = 3) {
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < n && guard < 50) {
    const w = drawWord(room);
    if (!seen.has(w)) { seen.add(w); out.push(w); }
    guard++;
  }
  return out;
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

// =========================================================
//  РЕЖИМ "КООП ПРОТИВ БОТА"
//  Бот "рисует" картинку (клиенты рисуют её сами по id),
//  оба игрока угадывают в общий чат. Сервер — единый источник
//  времени, выбора картинок и проверки догадок.
// =========================================================
const COOP_REVEAL = 0.35; // доля картинки, нарисованная мгновенно в начале (затравка)

function coopDeck(room) {
  // колода картинок по выбранной теме, без повторов в рамках сессии
  let pool = PICTURES_META;
  if (room.coop.theme && room.coop.theme !== "mix") {
    pool = PICTURES_META.filter((p) => p.cat === room.coop.theme);
  }
  if (pool.length === 0) pool = PICTURES_META;
  return shuffle(pool.map((p) => p.id));
}

function coopNextPic(room) {
  if (!room.coop.deck || room.coop.deck.length === 0) room.coop.deck = coopDeck(room);
  return room.coop.deck.pop();
}

function startCoop(room) {
  room.coop.roundNo = 0;
  room.coop.correct = 0;
  room.coop.score = 0;
  room.coop.streak = 0;
  room.coop.deck = coopDeck(room);
  coopNextRound(room);
}

function coopNextRound(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  room.coop.roundNo += 1;

  if (room.coop.roundNo > room.coop.totalRounds) return coopEnd(room);
  if (room.players.length < 1) return;

  const picId = coopNextPic(room);
  const meta = PICTURES_META[picId];
  room.coop.curPicId = picId;
  room.coop.curName = meta.name;
  room.coop.curAlt = meta.alt || [];
  room.coop.solved = false;
  room.coop.endsAt = Date.now() + room.coop.roundTime * 1000;
  room.coop.seed = Math.floor(Math.random() * 1e9); // для одинаковой "дрожи" линий

  // всем — старт раунда (без имени! только id картинки, длина слова, подсказки)
  io.to(room.code).emit("coop:round", {
    round: room.coop.roundNo,
    totalRounds: room.coop.totalRounds,
    picId,
    seed: room.coop.seed,
    maskLength: meta.name.length,
    timeLeft: room.coop.roundTime,
    revealStart: COOP_REVEAL,
    drawSpeed: room.coop.drawSpeed,
    hintsOn: room.coop.hintsOn,
    correct: room.coop.correct,
    score: room.coop.score,
    streak: room.coop.streak,
  });

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    const left = Math.max(0, Math.round((room.coop.endsAt - Date.now()) / 1000));
    io.to(room.code).emit("coop:tick", { left });
    // подсказка: на последней четверти времени открываем первую букву
    if (room.coop.hintsOn && !room.coop.hintSent && left <= room.coop.roundTime * 0.35) {
      room.coop.hintSent = true;
      io.to(room.code).emit("coop:hint", { firstLetter: room.coop.curName[0] });
    }
    if (left <= 0 && !room.coop.solved) coopEndRound(room, false, null);
  }, 1000);
  room.coop.hintSent = false;
}

function coopEndRound(room, solved, byPlayer) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  if (solved) {
    // очки по скорости: чем больше времени осталось, тем больше
    const left = Math.max(0, (room.coop.endsAt - Date.now()) / 1000);
    const speedBonus = Math.round((left / room.coop.roundTime) * 50);
    room.coop.streak += 1;
    const streakBonus = room.coop.streak >= 3 ? (room.coop.streak * 5) : 0;
    const gained = 50 + speedBonus + streakBonus;
    room.coop.score += gained;
    room.coop.correct += 1;
    io.to(room.code).emit("coop:result", {
      solved: true, word: room.coop.curName,
      byName: byPlayer ? byPlayer.name : null,
      gained, streak: room.coop.streak,
      correct: room.coop.correct, score: room.coop.score,
    });
  } else {
    room.coop.streak = 0;
    io.to(room.code).emit("coop:result", {
      solved: false, word: room.coop.curName,
      gained: 0, streak: 0,
      correct: room.coop.correct, score: room.coop.score,
    });
  }
  room.coop.curName = null;
  setTimeout(() => coopNextRound(room), 2800);
}

function coopEnd(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  io.to(room.code).emit("coop:over", {
    correct: room.coop.correct,
    total: room.coop.totalRounds,
    score: room.coop.score,
  });
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
  room.drawerIndex = -1;       // всегда сбрасываем, чтобы рисующий считался корректно
  room.deck = shuffle(WORDS);  // свежая перетасованная колода на каждую игру
  room.players.forEach((p) => (p.score = 0));
  nextRound(room);
}

// Этап 1: выбор слова. Рисующему даём 3 варианта на выбор.
function nextRound(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  if (room.chooseTimer) clearTimeout(room.chooseTimer);
  room.round += 1;

  if (room.round > room.totalRounds) return endGame(room);
  if (room.players.length < 2) return;

  // Чередуем рисующего (с защитой от выхода за границы массива)
  if (room.drawerIndex == null || room.drawerIndex < 0) room.drawerIndex = -1;
  room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
  const drawer = room.players[room.drawerIndex];
  if (!drawer) { // подстраховка: вдруг состав изменился
    room.drawerIndex = 0;
  }
  room.drawerId = room.players[room.drawerIndex].id;
  room.word = null;
  room.guessed = false;
  room.phase = "choosing";

  // три уникальных слова на выбор
  room.choices = drawChoices(room, 3);

  io.to(room.code).emit("room:update", { players: publicPlayers(room) });

  // рисующему — выбор из 3 слов; угадывающему — экран ожидания
  room.players.forEach((p) => {
    if (p.id === room.drawerId) {
      io.to(p.id).emit("round:choose", {
        round: room.round, totalRounds: room.totalRounds,
        drawerId: room.drawerId, choices: room.choices,
      });
    } else {
      io.to(p.id).emit("round:waiting", {
        round: room.round, totalRounds: room.totalRounds,
        drawerId: room.drawerId, drawerName: drawerName(room),
      });
    }
  });

  // если рисующий долго не выбирает (20 сек) — выбираем случайно за него
  room.chooseTimer = setTimeout(() => {
    if (room.phase === "choosing" && room.choices) {
      beginRound(room, room.choices[Math.floor(Math.random() * room.choices.length)]);
    }
  }, 20000);
}

function drawerName(room) {
  const d = room.players.find((p) => p.id === room.drawerId);
  return d ? d.name : "";
}

// Этап 2: слово выбрано — стартуем сам раунд и таймер.
function beginRound(room, word) {
  if (room.chooseTimer) { clearTimeout(room.chooseTimer); room.chooseTimer = null; }
  if (room.phase !== "choosing") return;
  room.phase = "playing";
  room.word = word;
  room.choices = null;
  room.timeLeft = ROUND_TIME;
  room.roundEndsAt = Date.now() + ROUND_TIME * 1000; // абсолютное время конца (для антилага)

  // Каждому — своя версия события (слово только рисующему)
  room.players.forEach((p) => {
    io.to(p.id).emit("game:start", {
      drawerId: room.drawerId,
      round: room.round,
      totalRounds: room.totalRounds,
      word: p.id === room.drawerId ? room.word : null,
      maskLength: room.word.length,
      timeLeft: room.timeLeft,
    });
  });

  io.to(room.code).emit("timer:tick", room.timeLeft);
  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    // считаем оставшееся время от АБСОЛЮТНОГО момента конца —
    // так таймер не «уплывает» при лагах и одинаков у обоих игроков
    const left = Math.max(0, Math.round((room.roundEndsAt - Date.now()) / 1000));
    room.timeLeft = left;
    io.to(room.code).emit("timer:tick", left);
    if (left <= 0) endRound(room, false);
  }, 1000);
}

function endRound(room, guessed) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  room.phase = "ended";
  room.roundEndsAt = null;
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

  // ---------- КООП ПРОТИВ БОТА ----------
  socket.on("coop:create", ({ name, rounds, theme, roundTime, hintsOn, drawSpeed }) => {
    const code = makeCode();
    let total = parseInt(rounds, 10);
    if (!Number.isFinite(total)) total = 10;
    total = Math.max(1, Math.min(99, total));
    let rt = parseInt(roundTime, 10);
    if (![30, 45, 60].includes(rt)) rt = 45;
    const speed = ["slow", "normal", "fast"].includes(drawSpeed) ? drawSpeed : "normal";
    const room = {
      code, mode: "coop", players: [], drawerId: null, timer: null,
      coop: {
        totalRounds: total,
        theme: theme || "mix",
        roundTime: rt,
        hintsOn: hintsOn !== false,
        drawSpeed: speed,
        deck: null, roundNo: 0, correct: 0, score: 0, streak: 0,
        curPicId: null, curName: null, curAlt: [], endsAt: 0, seed: 0,
      },
    };
    rooms.set(code, room);
    joinRoom(socket, room, name);
    socket.emit("room:created", { room: code, mode: "coop" });
  });

  socket.on("coop:join", ({ name, room: code }) => {
    const room = getRoom(code);
    if (!room) return socket.emit("room:error", { message: "Комната не найдена 🔍" });
    if (room.mode !== "coop") return socket.emit("room:error", { message: "Это код обычной игры! Открой вкладку «🎨 Друг против друга»" });
    if (room.players.length >= 2) return socket.emit("room:error", { message: "Комната заполнена (макс. 2) 👫" });
    joinRoom(socket, room, name);
    io.to(room.code).emit("room:update", { players: publicPlayers(room) });
    // как только второй зашёл — старт
    if (room.players.length === 2) setTimeout(() => startCoop(room), 600);
  });

  // одиночный старт коопа (если решил играть один, без партнёра)
  socket.on("coop:solo", () => {
    for (const room of rooms.values()) {
      if (room.mode === "coop" && room.players.some((p) => p.id === socket.id) && room.coop.roundNo === 0) {
        startCoop(room);
        break;
      }
    }
  });

  socket.on("coop:guess", ({ room: code, text }) => {
    const room = getRoom(code);
    if (!room || room.mode !== "coop" || !room.coop.curName || room.coop.solved) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    const guess = normalize(text);
    const answer = normalize(room.coop.curName);
    const alts = (room.coop.curAlt || []).map(normalize);
    if (guess === answer || alts.includes(guess)) {
      room.coop.solved = true;
      return coopEndRound(room, true, player);
    }
    // эхо догадки партнёру (чтобы видеть, что пишет другой)
    socket.to(code).emit("coop:peer-guess", { name: player.name, text });
    // "почти угадал"
    const d = levenshtein(guess, answer);
    if (d > 0 && d <= 2 && answer.length > 3) socket.emit("coop:close");
  });

  socket.on("coop:skip", ({ room: code }) => {
    const room = getRoom(code);
    if (!room || room.mode !== "coop" || room.coop.solved || !room.coop.curName) return;
    coopEndRound(room, false, null);
  });

  socket.on("coop:restart", ({ room: code }) => {
    const room = getRoom(code);
    if (!room || room.mode !== "coop") return;
    startCoop(room);
  });

  socket.on("coop:sync", ({ room: code }) => {
    const room = getRoom(code);
    if (!room || room.mode !== "coop" || !room.coop.endsAt) return;
    const left = Math.max(0, Math.round((room.coop.endsAt - Date.now()) / 1000));
    socket.emit("coop:tick", { left });
  });
  // ---------- /КООП ----------

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
    if (room.mode === "coop") return socket.emit("room:error", { message: "Это код кооп-режима! Открой вкладку «🤖 Кооп против бота»" });
    if (room.players.length >= 2) return socket.emit("room:error", { message: "Комната заполнена (макс. 2) 👫" });
    joinRoom(socket, room, name);
    // Второй игрок зашёл — стартуем!
    if (room.players.length === 2) {
      io.to(room.code).emit("room:update", { players: publicPlayers(room) });
      setTimeout(() => {
        // перепроверяем: вдруг кто-то вышел за эти 0.6 сек
        if (room.players.length === 2) startGame(room);
      }, 600);
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

  // Рисующий выбрал слово из трёх предложенных
  socket.on("word:chosen", ({ room: code, word }) => {
    const room = getRoom(code);
    if (!room || socket.id !== room.drawerId) return;
    if (room.phase !== "choosing") return;
    // защита: принимаем только одно из предложенных слов
    const valid = room.choices && room.choices.includes(word) ? word
      : (room.choices ? room.choices[0] : null);
    if (valid) beginRound(room, valid);
  });

  // Антилаг: клиент может попросить актуальное оставшееся время
  socket.on("timer:sync", ({ room: code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== "playing" || !room.roundEndsAt) return;
    const left = Math.max(0, Math.round((room.roundEndsAt - Date.now()) / 1000));
    socket.emit("timer:tick", left);
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
        if (room.chooseTimer) clearTimeout(room.chooseTimer);
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
