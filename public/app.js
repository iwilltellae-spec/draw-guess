/* ===== Рисуй & Угадай — клиентская логика ===== */
(() => {
  "use strict";

  // ---- Telegram Web App init (работает и без Telegram, в обычном браузере) ----
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#ffe3ee"); tg.setBackgroundColor("#ffe3ee"); } catch (e) {}
    // не даём свайпом случайно закрыть/свернуть приложение во время рисования
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
    try { tg.enableClosingConfirmation && tg.enableClosingConfirmation(); } catch (e) {}
  }
  const tgUser = tg?.initDataUnsafe?.user;
  const tgName = tgUser ? (tgUser.first_name || tgUser.username || "") : "";

  // ---- Правильные отступы под шапку Telegram ----
  // Внутри Telegram сверху есть его панель (кнопка закрытия, имя бота).
  // env(safe-area-inset-top) её НЕ учитывает, поэтому берём отступы из SDK.
  function applyTelegramInsets() {
    const root = document.documentElement;
    let top = 0, bottom = 0;
    if (tg) {
      // высота, реально доступная приложению (без клавиатуры и т.п.)
      const vh = tg.viewportStableHeight || tg.viewportHeight;
      if (vh) root.style.setProperty("--tg-vh", vh + "px");

      // safe area телефона (чёлка) + content safe area (шапка Telegram)
      const sa = tg.safeAreaInset || {};
      const csa = tg.contentSafeAreaInset || {};
      top = (sa.top || 0) + (csa.top || 0);
      bottom = (sa.bottom || 0) + (csa.bottom || 0);

      // ВАЖНО: на многих клиентах Telegram инсеты приходят как 0,
      // хотя сверху всё равно есть шапка бота. Поэтому когда инсеты
      // не дали запаса — добавляем гарантированный отступ под шапку.
      const MIN_TG_HEADER = 56; // примерная высота шапки Telegram
      if (top < MIN_TG_HEADER) top = MIN_TG_HEADER;
    }
    root.style.setProperty("--tg-top", top + "px");
    root.style.setProperty("--tg-bottom", bottom + "px");
  }
  applyTelegramInsets();
  if (tg) {
    tg.onEvent && tg.onEvent("viewportChanged", applyTelegramInsets);
    tg.onEvent && tg.onEvent("safeAreaChanged", applyTelegramInsets);
    tg.onEvent && tg.onEvent("contentSafeAreaChanged", applyTelegramInsets);
  }
  window.addEventListener("resize", applyTelegramInsets);

  // Антилаг: когда возвращаемся в приложение — просим у сервера актуальное время
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && socket && state.room) {
      socket.emit(state.mode === "coop" ? "coop:sync" : "timer:sync", { room: state.room });
    }
  });

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const screens = {
    lobby: $("lobby"),
    wait: $("waitRoom"),
    game: $("game"),
    coopGame: $("coopGame"),
  };
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("is-active"));
    screens[name].classList.add("is-active");
  }

  // ---- Состояние ----
  const state = {
    name: tgName || "",
    room: null,
    mode: "versus",    // versus | coop
    myId: null,
    isDrawer: false,
    players: [],
    word: null,        // знает только рисующий
    canDraw: false,
  };

  // =========================================================
  //  СТАТИСТИКА (сохраняется в браузере, не теряется после перезахода)
  // =========================================================
  const STATS_KEY = "drawguess_stats_v1";
  const NAME_KEY = "drawguess_name";
  const defaultStats = { games: 0, wins: 0, draws: 0, guessed: 0, points: 0, lastWord: null };

  function loadStats() {
    try { return { ...defaultStats, ...JSON.parse(localStorage.getItem(STATS_KEY) || "{}") }; }
    catch (e) { return { ...defaultStats }; }
  }
  function saveStats(s) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function bumpStat(key, by = 1) {
    const s = loadStats();
    s[key] = (s[key] || 0) + by;
    saveStats(s);
    renderStats();
  }
  function renderStats() {
    const s = loadStats();
    const box = $("statsBox");
    if (s.games > 0) box.hidden = false;
    $("stGames").textContent = s.games;
    $("stWins").textContent = s.wins;
    $("stGuessed").textContent = s.guessed;
    $("stPoints").textContent = s.points;
  }
  // запоминаем последнюю игру, чтобы засчитать её результат один раз
  let gameCounted = false;

  // ---- Тосты ----
  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // =========================================================
  //  СОКЕТ
  // =========================================================
  let socket = null;
  function connect() {
    // если адрес сервера не настроен — сразу понятная подсказка
    if (!window.SERVER_CONFIGURED) {
      toast("⚠️ Не вписан адрес сервера в config.js");
      return;
    }
    socket = io(window.SERVER_URL, { transports: ["websocket", "polling"] });

    socket.on("connect_error", () => toast("Не получается подключиться к серверу 😕 (сервер спит ~30 сек или неверный адрес)"));

    socket.on("room:created", ({ room, mode }) => {
      state.room = room;
      state.mode = mode || "versus";
      $("roomCodeBig").textContent = room;
      showScreen("wait");
      if (state.mode === "coop") showCoopSolo();
    });

    // ---- события коопа ----
    socket.on("coop:round", (d) => coopOnRound(d));
    socket.on("coop:tick", (d) => coopOnTick(d));
    socket.on("coop:hint", (d) => coopOnHint(d));
    socket.on("coop:result", (d) => coopOnResult(d));
    socket.on("coop:over", (d) => coopOnOver(d));
    socket.on("coop:peer-guess", (d) => coopPeerGuess(d));
    socket.on("coop:close", () => toast("🔥 Почти! Очень близко!"));

    socket.on("room:error", ({ message }) => {
      toast(message || "Ошибка комнаты");
    });

    socket.on("room:update", ({ players }) => {
      state.players = players;
      renderScoreboard();
    });

    socket.on("round:choose", (d) => onRoundChoose(d));
    socket.on("round:waiting", (d) => onRoundWaiting(d));
    socket.on("game:start", (data) => onGameStart(data));
    socket.on("draw:stroke", (s) => remoteStroke(s));
    socket.on("draw:clear", () => clearCanvas(false));
    socket.on("guess:correct", (d) => onCorrect(d));
    socket.on("guess:close", () => onClose());
    socket.on("timer:tick", (sec) => updateTimer(sec));
    socket.on("round:end", (d) => onRoundEnd(d));
    socket.on("game:over", (d) => onGameOver(d));
    socket.on("player:left", () => {
      toast("Партнёр вышел из игры 💔");
      setTimeout(() => location.reload(), 1500);
    });
    // при переподключении просим у сервера актуальное время (антилаг)
    socket.on("connect", () => {
      state.myId = socket.id;
      if (state.room) socket.emit(state.mode === "coop" ? "coop:sync" : "timer:sync", { room: state.room });
    });
  }

  // =========================================================
  //  ЛОББИ
  // =========================================================
  const nameInput = $("nameInput");
  // подставляем сохранённое имя (или из Telegram), показываем статистику
  try {
    const savedName = localStorage.getItem(NAME_KEY);
    if (savedName && !state.name) state.name = savedName;
  } catch (e) {}
  nameInput.value = state.name;
  renderStats();

  $("resetStatsBtn").addEventListener("click", () => {
    saveStats({ ...defaultStats });
    renderStats();
    $("statsBox").hidden = true;
    toast("Статистика сброшена 🧹");
  });

  // ---- Переключение режима игры (друг против друга / кооп) ----
  let lobbyMode = "versus";
  const modeTabs = document.querySelectorAll(".mode-tab");
  modeTabs.forEach((t) => {
    t.addEventListener("click", () => {
      modeTabs.forEach((x) => x.classList.remove("is-active"));
      t.classList.add("is-active");
      lobbyMode = t.dataset.mode;
      const coop = lobbyMode === "coop";
      $("versusSettings").hidden = coop;
      $("coopSettings").hidden = !coop;
      $("createBtn").textContent = coop ? "Создать кооп-комнату" : "Создать комнату";
      $("lobbyHint").textContent = coop
        ? "Бот рисует — вы угадываете вдвоём! Можно и одному 🤖"
        : "Один создаёт комнату — другой вводит код 👫";
    });
  });

  // ---- Настройки коопа ----
  const coopCfg = { rounds: 10, theme: "mix", roundTime: 45, hintsOn: true, drawSpeed: "normal" };
  function pickGroup(selector, attr, cb) {
    const opts = document.querySelectorAll(selector);
    opts.forEach((b) => b.addEventListener("click", () => {
      opts.forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      cb(b.dataset[attr], b);
    }));
  }
  pickGroup(".coop-rounds-opt", "rounds", (v) => { coopCfg.rounds = +v; $("coopRoundsCustom").value = ""; });
  pickGroup(".theme-opt", "theme", (v) => { coopCfg.theme = v; });
  pickGroup(".time-opt", "time", (v) => { coopCfg.roundTime = +v; });
  pickGroup(".speed-opt", "speed", (v) => { coopCfg.drawSpeed = v; });
  $("coopRoundsCustom").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1 && v <= 99) {
      document.querySelectorAll(".coop-rounds-opt").forEach((x) => x.classList.remove("is-active"));
      coopCfg.rounds = v;
    }
  });
  $("hintsToggle").addEventListener("change", (e) => { coopCfg.hintsOn = e.target.checked; });

  // ---- Выбор количества раундов (versus) ----
  let chosenRounds = 6;
  const roundOpts = document.querySelectorAll(".round-opt");
  const roundsCustom = $("roundsCustom");
  roundOpts.forEach((b) => {
    b.addEventListener("click", () => {
      roundOpts.forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      roundsCustom.value = "";
      chosenRounds = +b.dataset.rounds;
    });
  });
  roundsCustom.addEventListener("input", () => {
    const v = parseInt(roundsCustom.value, 10);
    if (v >= 1 && v <= 99) {
      roundOpts.forEach((x) => x.classList.remove("is-active"));
      chosenRounds = v;
    }
  });

  $("createBtn").addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) return toast("Введи имя 🙂");
    state.name = name;
    state.mode = lobbyMode;
    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
    gameCounted = false;
    if (!socket) connect();
    if (lobbyMode === "coop") {
      socket.emit("coop:create", { name, rounds: coopCfg.rounds, theme: coopCfg.theme, roundTime: coopCfg.roundTime, hintsOn: coopCfg.hintsOn, drawSpeed: coopCfg.drawSpeed });
    } else {
      socket.emit("room:create", { name, rounds: chosenRounds });
    }
  });

  $("joinBtn").addEventListener("click", () => {
    const name = nameInput.value.trim();
    const code = $("roomInput").value.trim().toUpperCase();
    if (!name) return toast("Введи имя 🙂");
    if (code.length < 4) return toast("Введи код комнаты");
    state.name = name;
    state.mode = lobbyMode;
    state.room = code;
    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
    gameCounted = false;
    if (!socket) connect();
    if (lobbyMode === "coop") {
      socket.emit("coop:join", { name, room: code });
    } else {
      socket.emit("room:join", { name, room: code });
    }
  });

  $("roomInput").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  $("copyCodeBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.room);
      toast("Код скопирован! Отправь партнёру 💌");
    } catch (e) {
      toast("Код: " + state.room);
    }
  });

  $("leaveWaitBtn").addEventListener("click", () => location.reload());

  // =========================================================
  //  ВЫБОР СЛОВА (перед раундом)
  // =========================================================
  let chooseCountdown = null;

  function hideChoose() {
    $("chooseOverlay").classList.remove("show");
    if (chooseCountdown) { clearInterval(chooseCountdown); chooseCountdown = null; }
  }

  // Рисующему — показываем 3 слова на выбор
  function onRoundChoose({ round, totalRounds, drawerId, choices }) {
    showScreen("game");
    if (round === 1) gameCounted = false;
    state.isDrawer = true;
    state.canDraw = false; // рисовать ещё нельзя, пока не выбрал
    // подготовим экран (но контент покажем после выбора)
    $("roundPill").textContent = `Раунд ${round}/${totalRounds}`;
    clearCanvas(false);
    $("tools").classList.add("hidden");
    $("guessForm").classList.add("hidden");

    // настроим оверлей выбора
    $("chooseForDrawer").hidden = false;
    $("chooseForGuesser").hidden = true;
    const box = $("chooseWords");
    box.innerHTML = "";
    choices.forEach((w) => {
      const b = document.createElement("button");
      b.className = "choose-word";
      b.textContent = w;
      b.addEventListener("click", () => {
        socket?.emit("word:chosen", { room: state.room, word: w });
        hideChoose();
      });
      box.appendChild(b);
    });
    $("chooseOverlay").classList.add("show");

    // обратный отсчёт (20 сек — потом сервер выберет сам)
    let left = 20;
    $("chooseTimerTxt").textContent = `(${left})`;
    if (chooseCountdown) clearInterval(chooseCountdown);
    chooseCountdown = setInterval(() => {
      left -= 1;
      $("chooseTimerTxt").textContent = left > 0 ? `(${left})` : "";
      if (left <= 0) { clearInterval(chooseCountdown); chooseCountdown = null; }
    }, 1000);
  }

  // Угадывающему — экран ожидания, пока партнёр выбирает слово
  function onRoundWaiting({ round, totalRounds, drawerName }) {
    showScreen("game");
    if (round === 1) gameCounted = false;
    state.isDrawer = false;
    state.canDraw = false;
    $("roundPill").textContent = `Раунд ${round}/${totalRounds}`;
    clearCanvas(false);
    $("tools").classList.add("hidden");
    $("guessForm").classList.add("hidden");

    $("chooseForDrawer").hidden = true;
    $("chooseForGuesser").hidden = false;
    $("chooseWaitText").textContent = `${drawerName || "Партнёр"} выбирает слово`;
    $("chooseOverlay").classList.add("show");
  }

  // =========================================================
  //  ИГРА: старт раунда
  // =========================================================
  function onGameStart({ drawerId, round, totalRounds, word, maskLength, timeLeft }) {
    hideChoose();
    showScreen("game");
    if (round === 1) gameCounted = false; // началась новая игра
    state.isDrawer = drawerId === state.myId;
    state.canDraw = state.isDrawer;
    state.word = state.isDrawer ? word : null;

    $("roundPill").textContent = `Раунд ${round}/${totalRounds}`;
    clearCanvas(false);

    const banner = $("roleBanner");
    if (state.isDrawer) {
      $("wordDisplay").textContent = word;
      $("wordDisplay").style.letterSpacing = "1px";
      banner.textContent = `🎨 Рисуй: «${word}»`;
      banner.className = "banner show draw";
      $("tools").classList.remove("hidden");
      $("canvasLock").classList.remove("show");
      $("guessForm").classList.add("hidden");
    } else {
      $("wordDisplay").style.letterSpacing = "5px";
      $("wordDisplay").textContent = maskWord(maskLength);
      banner.textContent = "👀 Угадывай, что рисует партнёр!";
      banner.className = "banner show guess";
      $("tools").classList.add("hidden");
      const badge = $("canvasLock");
      badge.classList.add("show");
      // прячем угловой бейдж через 4 сек, чтобы холст был полностью чистым
      setTimeout(() => badge.classList.remove("show"), 4000);
      $("guessForm").classList.remove("hidden");
      $("guessInput").focus();
    }
    if (timeLeft != null) updateTimer(timeLeft);
    setTimeout(() => banner.classList.remove("show"), 3500);
    // даём браузеру пересчитать раскладку (панель инструментов появилась/исчезла),
    // затем подгоняем размер холста под итоговое место
    requestAnimationFrame(() => requestAnimationFrame(fitCanvas));
  }

  function maskWord(len) {
    return Array.from({ length: len }, () => "_").join(" ");
  }

  // милые аватарки по имени (стабильные)
  const AVATARS = ["🐱","🐰","🦊","🐻","🐼","🐨","🐯","🦄","🐧","🐸","🐶","🐹","🦉","🐳","🦋","🌸"];
  function avatarFor(name) {
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATARS[h % AVATARS.length];
  }

  function renderScoreboard() {
    const me = state.players.find((p) => p.id === state.myId);
    const other = state.players.find((p) => p.id !== state.myId);
    fillPlayer("p1", me, true);
    fillPlayer("p2", other, false);
  }
  function fillPlayer(prefix, p, isMe) {
    const el = $(prefix);
    const nameEl = el.querySelector(".player__name");
    const scoreEl = $(prefix + "score");
    const roleEl = $(prefix + "role");
    const avEl = $(prefix + "avatar");
    if (!p) {
      nameEl.textContent = "—"; scoreEl.textContent = "0";
      roleEl.textContent = ""; avEl.textContent = "❓";
      el.classList.remove("is-drawing", "me");
      return;
    }
    nameEl.textContent = p.name;
    scoreEl.textContent = p.score;
    avEl.textContent = avatarFor(p.name);
    roleEl.textContent = p.isDrawer ? "🎨 рисует" : "👀 угадывает";
    el.classList.toggle("me", isMe);
    el.classList.toggle("is-drawing", p.isDrawer);
  }

  // =========================================================
  //  ТАЙМЕР
  // =========================================================
  function updateTimer(sec) {
    const t = $("timer");
    t.textContent = sec;
    t.classList.toggle("low", sec <= 10);
  }

  // =========================================================
  //  ХОЛСТ И РИСОВАНИЕ
  // =========================================================
  const canvas = $("board");
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let last = null;
  let curColor = "#3a2b4a";
  let curSize = 6;
  let erasing = false;

  // ВАЖНО: храним ВСЕ штрихи раунда в массиве (нормализованные координаты 0..1).
  // Благодаря этому при изменении размера экрана (например, всплыла клавиатура
  // при вводе догадки) мы просто перерисовываем холст из памяти — рисунок НЕ теряется.
  let strokes = [];

  // Координаты храним нормализованными (0..1), чтобы у обоих игроков
  // рисунок совпадал независимо от размера экрана.
  function fitCanvas() {
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (w === 0 || h === 0) return; // холст ещё не виден — не трогаем
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    redraw(); // перерисовываем всё из памяти
  }

  // Полная перерисовка холста из массива штрихов
  function redraw() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const s of strokes) {
      paintSegment(s.x0, s.y0, s.x1, s.y1, s.color, s.size, s.eraser);
    }
  }

  // Реакция на изменение размера — БЕЗ потери рисунка
  window.addEventListener("resize", () => {
    if (screens.game.classList.contains("is-active")) fitCanvas();
  });

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) / r.width, y: (p.clientY - r.top) / r.height };
  }

  // Низкоуровневая отрисовка одного сегмента (без сохранения в память)
  function paintSegment(x0, y0, x1, y1, color, size, isEraser) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(x0 * w, y0 * h);
    ctx.lineTo(x1 * w, y1 * h);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  // Отрисовка + запоминание штриха в память (чтобы пережить resize)
  function drawSegment(x0, y0, x1, y1, color, size, isEraser) {
    strokes.push({ x0, y0, x1, y1, color, size, eraser: isEraser });
    paintSegment(x0, y0, x1, y1, color, size, isEraser);
  }

  function pointerDown(e) {
    if (!state.canDraw) return;
    e.preventDefault();
    drawing = true;
    last = getPos(e);
    // точка-клик
    drawSegment(last.x, last.y, last.x + 0.0001, last.y, curColor, curSize, erasing);
    emitStroke(last.x, last.y, last.x + 0.0001, last.y);
  }
  function pointerMove(e) {
    if (!drawing || !state.canDraw) return;
    e.preventDefault();
    const p = getPos(e);
    drawSegment(last.x, last.y, p.x, p.y, curColor, curSize, erasing);
    emitStroke(last.x, last.y, p.x, p.y);
    last = p;
  }
  function pointerUp() { drawing = false; last = null; }

  function emitStroke(x0, y0, x1, y1) {
    socket?.emit("draw:stroke", {
      room: state.room, x0, y0, x1, y1,
      color: curColor, size: curSize, eraser: erasing,
    });
  }
  function remoteStroke(s) {
    // приходит штрих от рисующего — рисуем И запоминаем (чтобы пережить resize)
    drawSegment(s.x0, s.y0, s.x1, s.y1, s.color, s.size, s.eraser);
  }

  canvas.addEventListener("mousedown", pointerDown);
  canvas.addEventListener("mousemove", pointerMove);
  window.addEventListener("mouseup", pointerUp);
  canvas.addEventListener("touchstart", pointerDown, { passive: false });
  canvas.addEventListener("touchmove", pointerMove, { passive: false });
  canvas.addEventListener("touchend", pointerUp);

  function clearCanvas(emit = true) {
    strokes = []; // чистим и память тоже
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (emit) socket?.emit("draw:clear", { room: state.room });
  }
  $("clearBtn").addEventListener("click", () => clearCanvas(true));

  // ---- Палитра ----
  const PALETTE = ["#3a2b4a","#ff6fa5","#9b6dff","#5ec6ff","#5fd38a","#ffd23f","#ff7a45","#8b5a2b","#ffffff"];
  const colorsEl = $("colors");
  PALETTE.forEach((c, i) => {
    const sw = document.createElement("button");
    sw.className = "swatch" + (i === 0 ? " active" : "");
    sw.style.background = c;
    sw.addEventListener("click", () => {
      curColor = c; erasing = false;
      $("eraserBtn").classList.remove("active");
      $("colorPickWrap").classList.remove("active");
      $("colorDot").style.background = c;
      document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
    });
    colorsEl.appendChild(sw);
  });

  // ---- Выбор любого цвета (нативная палитра-колесо) ----
  const colorPicker = $("colorPicker");
  const colorPickWrap = $("colorPickWrap");
  const colorDot = $("colorDot");
  colorDot.style.background = curColor; // стартовый цвет на кругляше
  colorPicker.addEventListener("input", (e) => {
    curColor = e.target.value;
    erasing = false;
    colorDot.style.background = curColor;
    $("eraserBtn").classList.remove("active");
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
    colorPickWrap.classList.add("active");
  });

  $("brushSize").addEventListener("input", (e) => { curSize = +e.target.value; });
  $("eraserBtn").addEventListener("click", () => {
    erasing = !erasing;
    $("eraserBtn").classList.toggle("active", erasing);
  });

  // =========================================================
  //  ВВОД ДОГАДКИ
  // =========================================================
  $("guessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = $("guessInput").value.trim();
    if (!val) return;
    socket?.emit("guess:try", { room: state.room, text: val });
    $("guessInput").value = "";
  });

  // Кто угадал последним (для оверлея конца раунда)
  let lastGuesserName = null;

  // Подсказка "почти угадал" — короткий тост, без чата
  function onClose() {
    toast("🔥 Почти! Очень близко!");
  }

  // =========================================================
  //  СОБЫТИЯ РАУНДА
  // =========================================================
  function onCorrect({ guesserId, guesserName, word }) {
    lastGuesserName = guesserName;
    if (navigator.vibrate) navigator.vibrate(60);
    // если угадал именно я — засчитываем в статистику
    if (guesserId === state.myId) {
      bumpStat("guessed", 1);
      bumpStat("points", 100);
    }
  }

  function onRoundEnd({ word, guessed, scores }) {
    state.players = scores;
    renderScoreboard();
    if (guessed) {
      const who = lastGuesserName ? `${lastGuesserName} угадал(а)!` : "Угадано!";
      showOverlay("✅", who, `Слово: «${word}»`, "Следующий раунд →");
    } else {
      showOverlay("⏱️", "Время вышло!", `Никто не угадал. Было: «${word}»`, "Следующий раунд →");
    }
    lastGuesserName = null;
  }

  function onGameOver({ winner, scores, draw }) {
    state.players = scores;
    renderScoreboard();

    // ---- засчитываем игру в статистику (один раз) ----
    if (!gameCounted) {
      gameCounted = true;
      const s = loadStats();
      s.games += 1;
      if (draw) s.draws += 1;
      else if (winner.id === state.myId) s.wins += 1;
      saveStats(s);
      renderStats();
    }

    if (draw) {
      showOverlay("🤝", "Ничья!", "Вы прошли идеально вместе 💕", "Сыграть ещё", true);
    } else {
      const isMe = winner.id === state.myId;
      showOverlay(isMe ? "🏆" : "💪", isMe ? "Ты победил(а)!" : `Победил(а) ${winner.name}!`,
        `Финальный счёт: ${scores.map((s) => `${s.name} ${s.score}`).join(" • ")}`,
        "Сыграть ещё", true);
    }
  }

  // ---- Оверлей ----
  let overlayIsFinal = false;
  function showOverlay(emoji, title, text, btn, isFinal = false) {
    $("overlayEmoji").textContent = emoji;
    $("overlayTitle").textContent = title;
    $("overlayText").textContent = text;
    $("overlayBtn").textContent = btn;
    overlayIsFinal = isFinal;
    $("overlay").classList.add("show");
  }
  $("overlayBtn").addEventListener("click", () => {
    $("overlay").classList.remove("show");
    if (overlayIsFinal) {
      if (state.mode === "coop") socket?.emit("coop:restart", { room: state.room });
      else socket?.emit("game:restart", { room: state.room });
    }
    // для промежуточного раунда сервер сам пришлёт следующий старт
  });

  // =========================================================
  //  РЕЖИМ "КООП ПРОТИВ БОТА" (клиент)
  // =========================================================
  const coopBoard = $("coopBoard");
  const bot = window.makeBotDrawer(coopBoard);
  const coop = {
    raf: null, startAt: 0, roundTime: 45, revealStart: 0.35, finishFrac: 0.55,
    serverLeft: null, lastTickAt: 0, solved: false, picName: null,
  };

  function coopFit() { bot.fit(); }
  window.addEventListener("resize", () => {
    if (screens.coopGame.classList.contains("is-active")) coopFit();
  });

  // показать "играть одному" на экране ожидания в коопе
  function showCoopSolo() {
    if (state.mode !== "coop") return;
    $("waitHint").textContent = "Ждём партнёра… или начни один!";
    let btn = $("coopSoloBtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "coopSoloBtn";
      btn.className = "btn btn--primary";
      btn.textContent = "🤖 Играть одному";
      btn.style.marginTop = "10px";
      btn.addEventListener("click", () => socket?.emit("coop:solo"));
      $("leaveWaitBtn").parentElement.insertBefore(btn, $("leaveWaitBtn"));
    }
    btn.hidden = false;
  }

  // старт раунда коопа: бот начинает рисовать
  function coopOnRound(d) {
    hideChoose();
    $("overlay").classList.remove("show");
    showScreen("coopGame");
    coop.solved = false;
    coop.roundTime = d.timeLeft;
    coop.revealStart = d.revealStart;
    // скорость рисования бота: чем меньше доля времени, тем быстрее он дорисовывает
    coop.finishFrac = ({ slow: 0.8, normal: 0.5, fast: 0.28 })[d.drawSpeed] || 0.5;
    coop.startAt = performance.now();
    coop.serverLeft = d.timeLeft;
    coop.lastTickAt = performance.now();

    const meta = window.PICTURES[d.picId];
    coop.picName = meta ? meta.name : "";

    $("coopRoundPill").textContent = `Рисунок ${d.round}/${d.totalRounds}`;
    $("coopMask").textContent = maskWord(d.maskLength);
    $("coopMask").style.letterSpacing = "5px";
    $("coopCorrect").textContent = d.correct;
    $("coopScore").textContent = d.score;
    $("coopStreak").textContent = d.streak;
    $("coopInput").value = "";

    const banner = $("coopBanner");
    banner.textContent = "🤖 Бот начал рисовать — угадывайте!";
    banner.className = "banner show guess";
    setTimeout(() => banner.classList.remove("show"), 2500);
    $("coopBadge").classList.add("show");
    setTimeout(() => $("coopBadge").classList.remove("show"), 3000);

    // готовим картинку и запускаем анимацию рисования
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bot.fit();
      if (meta) bot.setPicture(meta, d.seed);
      startCoopAnim();
    }));
  }

  // плавная анимация: progress зависит от прошедшего времени раунда
  function startCoopAnim() {
    if (coop.raf) cancelAnimationFrame(coop.raf);
    const loop = () => {
      // оценка оставшегося времени между серверными тиками
      const sinceTick = (performance.now() - coop.lastTickAt) / 1000;
      const left = Math.max(0, (coop.serverLeft ?? coop.roundTime) - sinceTick);
      const elapsedFrac = 1 - left / coop.roundTime; // 0..1 по времени
      // прогресс рисунка: стартовая затравка + дорисовываем к моменту finishFrac.
      // Чем меньше finishFrac, тем БЫСТРЕЕ бот дорисовывает картинку.
      let progress = coop.revealStart + (1 - coop.revealStart) * Math.min(1, elapsedFrac / coop.finishFrac);
      if (coop.solved) progress = 1; // если угадали — дорисуем целиком
      bot.render(progress);
      if (!coop.solved && left > 0) coop.raf = requestAnimationFrame(loop);
      else if (coop.solved) bot.render(1);
    };
    coop.raf = requestAnimationFrame(loop);
  }

  function coopOnTick(d) {
    coop.serverLeft = d.left;
    coop.lastTickAt = performance.now();
    const t = $("coopTimer");
    t.textContent = d.left;
    t.classList.toggle("low", d.left <= 10);
  }

  function coopOnHint(d) {
    // открываем первую букву в маске
    const mask = $("coopMask").textContent.split(" ");
    if (mask.length) { mask[0] = d.firstLetter; $("coopMask").textContent = mask.join(" "); }
    toast("💡 Подсказка: первая буква «" + d.firstLetter + "»");
  }

  function coopPeerGuess(d) {
    // показываем догадку партнёра тостом
    toast(`${d.name}: ${d.text}`);
  }

  function coopOnResult(d) {
    coop.solved = true;
    if (coop.raf) cancelAnimationFrame(coop.raf);
    bot.render(1); // дорисовываем полностью
    $("coopCorrect").textContent = d.correct;
    $("coopScore").textContent = d.score;
    $("coopStreak").textContent = d.streak;

    const banner = $("coopBanner");
    if (d.solved) {
      if (navigator.vibrate) navigator.vibrate(60);
      const who = d.byName ? `${d.byName} угадал(а)!` : "Угадано!";
      banner.textContent = `✅ ${who} «${d.word}» (+${d.gained})`;
      banner.className = "banner show draw";
    } else {
      banner.textContent = `⏭️ Не угадали. Это «${d.word}»`;
      banner.className = "banner show guess";
    }
    banner.classList.add("show");
    setTimeout(() => banner.classList.remove("show"), 2600);
  }

  function coopOnOver(d) {
    if (coop.raf) cancelAnimationFrame(coop.raf);
    // рекорд пары
    const best = getCoopBest();
    let recordTxt = "";
    if (d.score > best) {
      setCoopBest(d.score);
      recordTxt = " 🏆 Новый рекорд!";
    } else {
      recordTxt = ` (ваш рекорд: ${best})`;
    }
    showOverlay("🎉", `Угадали ${d.correct} из ${d.total}!`,
      `Очки: ${d.score}${recordTxt}`, "Сыграть ещё", true);
  }

  // рекорд коопа в localStorage
  function getCoopBest() { try { return +(localStorage.getItem("coop_best") || 0); } catch (e) { return 0; } }
  function setCoopBest(v) { try { localStorage.setItem("coop_best", String(v)); } catch (e) {} }

  // отправка догадки в коопе
  $("coopForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = $("coopInput").value.trim();
    if (!val) return;
    socket?.emit("coop:guess", { room: state.room, text: val });
    $("coopInput").value = "";
  });
  $("coopSkipBtn").addEventListener("click", () => {
    socket?.emit("coop:skip", { room: state.room });
  });

})();
