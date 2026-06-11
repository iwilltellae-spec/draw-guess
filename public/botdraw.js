/* =========================================================
   ДВИЖОК "БОТ РИСУЕТ" — постепенная отрисовка картинки на canvas.
   Рисует линии по очереди, точку за точкой, с лёгкой "дрожью"
   как от руки. Прогресс задаётся снаружи (0..1), чтобы у обоих
   игроков картинка раскрывалась синхронно по таймеру сервера.
   ========================================================= */
(function () {
  "use strict";

  function makeBotDrawer(canvas) {
    const ctx = canvas.getContext("2d");
    let pic = null;            // текущий рисунок
    let flatPoints = [];       // все точки всех линий подряд (с метками линий)
    let totalLen = 0;          // суммарная "длина" в точках
    let seed = 1;

    // простой детерминированный псевдослучайный (чтобы дрожь была одинаковой у обоих)
    function rng() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff); }
    function jitter(v) { return v + (rng() - 0.5) * 0.006; } // лёгкая "человеческая" дрожь

    function setPicture(picture, seedVal = 1) {
      pic = picture;
      seed = seedVal || 1;
      flatPoints = [];
      totalLen = 0;
      // превращаем линии в последовательность сегментов с дрожью
      pic.strokes.forEach((stroke, si) => {
        const jittered = stroke.map(([x, y]) => [jitter(x), jitter(y)]);
        for (let i = 0; i < jittered.length; i++) {
          flatPoints.push({ x: jittered[i][0], y: jittered[i][1], stroke: si, first: i === 0 });
          totalLen++;
        }
      });
    }

    function fit() {
      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
    }

    // progress: 0..1 — какую долю всех точек уже нарисовать
    function render(progress) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      if (!pic || totalLen === 0) return;
      ctx.strokeStyle = "#3a2b4a";
      ctx.lineWidth = Math.max(2.5, Math.min(w, h) * 0.012);

      const upto = Math.max(1, Math.floor(totalLen * Math.min(1, Math.max(0, progress))));
      let prev = null;
      for (let i = 0; i < upto; i++) {
        const p = flatPoints[i];
        if (p.first || !prev || prev.stroke !== p.stroke) {
          ctx.beginPath();
          ctx.moveTo(p.x * w, p.y * h);
        } else {
          ctx.lineTo(p.x * w, p.y * h);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(p.x * w, p.y * h);
        }
        prev = p;
      }
    }

    function clear() {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    }

    return { setPicture, fit, render, clear };
  }

  window.makeBotDrawer = makeBotDrawer;
})();
