/* =========================================================
   НАСТРОЙКА АДРЕСА СЕРВЕРА
   ---------------------------------------------------------
   ⚠️ ОБЯЗАТЕЛЬНО: после того как зальёшь СЕРВЕР на Render и
   получишь адрес вроде  https://draw-guess-xxxx.onrender.com
   — впиши его ниже в кавычки вместо текста "ВПИШИ_СЮДА_АДРЕС_СЕРВЕРА".

   Пример правильно заполненного:
   const MY_SERVER = "https://draw-guess-abcd.onrender.com";

   ВАЖНО: адрес в кавычках, БЕЗ слэша "/" в конце.
   ========================================================= */

const MY_SERVER = "https://draw-guess-q17m.onrender.com";

/* ↓↓↓ ниже ничего трогать не нужно ↓↓↓ */
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
window.SERVER_URL = isLocal ? "http://localhost:3000" : MY_SERVER;

// если адрес сервера забыли вписать — сразу скажем об этом понятно
window.SERVER_CONFIGURED = isLocal || (MY_SERVER && MY_SERVER.startsWith("http"));
