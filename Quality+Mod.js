/**
 * Quality+Mod - Enhanced Quality Plugin for Lampa
 * --------------------------------------------------------------------------------
 * Автоматично визначає та показує якість релізу з JacRed:
 *  - Мітки на повній і спискових картках
 *  - Спрощені (4K/FHD/HD/SD, TS/TC/CAM) або повні підписи — перемикається
 *  - Ручні оверрайди для окремих ID
 *  - Кеш 48h + тихе фонове оновлення
 *  - Черга запитів, проксі, поліфіли для старих WebView
 *
 * Налаштування: Інтерфейс → «Мітки якості»
 */

// LQE TV-BOX COMPAT LAYER 
(function () {
    // 1. Проміси (дуже простий поліфіл, достатньо для then/catch)
    if (typeof window.Promise !== 'function') {
        (function () {
            function SimplePromise(executor) {
                var self = this;
                self._state = 'pending';
                self._value = undefined;
                self._handlers = [];

                function resolve(value) {
                    if (self._state !== 'pending') return;
                    self._state = 'fulfilled';
                    self._value = value;
                    run();
                }

                function reject(reason) {
                    if (self._state !== 'pending') return;
                    self._state = 'rejected';
                    self._value = reason;
                    run();
                }

                function run() {
                    setTimeout(function () {
                        for (var i = 0; i < self._handlers.length; i++) {
                            handle(self._handlers[i]);
                        }
                        self._handlers = [];
                    }, 0);
                }

                function handle(h) {
                    if (self._state === 'pending') {
                        self._handlers.push(h);
                        return;
                    }
                    var cb = self._state === 'fulfilled' ? h.onFulfilled : h.onRejected;

                    if (!cb) {
                        (self._state === 'fulfilled' ? h.resolve : h.reject)(self._value);
                        return;
                    }

                    try {
                        var ret = cb(self._value);
                        h.resolve(ret);
                    } catch (e) {
                        h.reject(e);
                    }
                }

                self.then = function (onFulfilled, onRejected) {
                    return new SimplePromise(function (resolve2, reject2) {
                        handle({
                            onFulfilled: typeof onFulfilled === 'function' ? onFulfilled : null,
                            onRejected: typeof onRejected === 'function' ? onRejected : null,
                            resolve: resolve2,
                            reject: reject2
                        });
                    });
                };

                self.catch = function (onRejected) {
                    return self.then(null, onRejected);
                };

                try {
                    executor(resolve, reject);
                } catch (e) {
                    reject(e);
                }
            }

            window.Promise = SimplePromise;
        })();
    }

    // 2. requestAnimationFrame поліфіл
    if (typeof window.requestAnimationFrame !== 'function') {
        window.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 16); // ~60fps
        };
    }

    // 3. Безпечне localStorage
    var safeLocalStorage = (function () {
        try {
            var testKey = '__lqe_test__';
            window.localStorage.setItem(testKey, '1');
            window.localStorage.removeItem(testKey);
            // якщо дійшли сюди — localStorage живий
            return window.localStorage;
        } catch (e) {
            // fallback у RAM
            var memoryStore = {};
            return {
                getItem: function (k) { return memoryStore[k] || null; },
                setItem: function (k, v) { memoryStore[k] = String(v); },
                removeItem: function (k) { delete memoryStore[k]; }
            };
        }
    })();

    // 4. Якщо чомусь немає Lampa.Storage,
    // створимо просту сумісну версію поверх safeLocalStorage.
    if (!window.Lampa) window.Lampa = {};
    if (!Lampa.Storage) {
        Lampa.Storage = {
            get: function (key, def) {
                try {
                    var raw = safeLocalStorage.getItem(key);
                    return raw ? JSON.parse(raw) : (def || null);
                } catch (e) {
                    return def || null;
                }
            },
            set: function (key, val) {
                try {
                    safeLocalStorage.setItem(key, JSON.stringify(val));
                } catch (e) {
                    // ігноруємо, щоб не завалити плагін
                }
            }
        };
    }

    // 5. safeFetchText: універсальна обгортка, яка:
    //    - якщо є нормальний fetch -> використовує його
    //    - якщо немає fetch -> XHR
    //    - повертає Promise<String>, щоб залишити існуючу логіку з then/catch
    function safeFetchText(url) {
        return new Promise(function (resolve, reject) {
            // Варіант 1: сучасний fetch
            if (typeof fetch === 'function') {
                try {
                    fetch(url)
                        .then(function (res) {
                            if (!res.ok) throw new Error('HTTP ' + res.status);
                            return res.text();
                        })
                        .then(resolve)
                        .catch(reject);
                    return;
                } catch (e) {
                    // якщо сам fetch впав синхронно — просто падати не будемо, йдемо в XHR
                }
            }

            // Варіант 2: старий WebView -> XMLHttpRequest
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(xhr.responseText);
                        } else {
                            reject(new Error('XHR ' + xhr.status));
                        }
                    }
                };
                xhr.onerror = function () {
                    reject(new Error('Network error'));
                };
                xhr.send(null);
            } catch (err) {
                reject(err);
            }
        });
    }

    // Експортуємо, щоб основний код плагіна зміг цим користуватись.
    window.LQE_safeFetchText = safeFetchText;
})();





(function () {
    'use strict'; // Використання суворого режиму для запобігання помилок

    // ===================== КОНФІГУРАЦІЯ =====================
    var LQE_CONFIG = {
        CACHE_VERSION: 3, // Версія кешу для інвалідації старих даних
        LOGGING_GENERAL: true, // Загальне логування для налагодження
        LOGGING_QUALITY: false, // Логування процесу визначення якості
        LOGGING_CARDLIST: true, // Логування для спискових карток
        CACHE_VALID_TIME_MS: 48 * 60 * 60 * 1000, // Час життя кешу (48 години)
        CACHE_REFRESH_THRESHOLD_MS: 24 * 60 * 60 * 1000, // Час для фонового оновлення кешу (24 годин)
        CACHE_KEY: 'lampa_quality_cache', // Ключ для зберігання кешу в LocalStorage
        JACRED_PROTOCOL: 'https://', // Протокол для API JacRed
        JACRED_URL: 'jacred.stream/', // Домен API JacRed (jr.maxvol.pro або jacred.xyz)
        JACRED_API_KEY: 'pp', // Ключ API (не використовується в даній версії)
        PROXY_LIST: [ // Список проксі серверів для обходу CORS обмежень
            'https://fndr.kzktools.workers.dev/?key={KEY}&url=',
            'https://api.allorigins.win/raw?url=',
            'https://cors.bwa.workers.dev/'
            
        ],
        PROXY_TIMEOUT_MS: 3500, // Таймаут для проксі запитів (3 секунди)
        WORKER_KEY: 'lmp_2026_JacRed_K9xP7aQ4mV2E', // ключ
        SHOW_QUALITY_FOR_TV_SERIES: false, // ✅ Показувати якість для серіалів
        SHOW_FULL_CARD_LABEL: true,       // ✅ Показувати мітку якості у повній картці

        MAX_PARALLEL_REQUESTS: 8, // Максимальна кількість паралельних запитів

        USE_SIMPLE_QUALITY_LABELS: true, // ✅ Використовувати спрощені мітки якості (4K, FHD, TS, TC тощо) "true" - так /  "false" - ні
        USE_COLORED_LABELS: false, // ✅ ДОДАНО: Перемикач кольорових міток (за замовчуванням вимкнено)

        
        // Стилі для відображення якості на повній картці
        FULL_CARD_LABEL_BORDER_COLOR: '#FFFFFF',
        FULL_CARD_LABEL_TEXT_COLOR: '#FFFFFF',
        FULL_CARD_LABEL_FONT_WEIGHT: 'normal',
        FULL_CARD_LABEL_FONT_SIZE: '1.2em',
        FULL_CARD_LABEL_FONT_STYLE: 'normal',

        // Стилі для відображення якості на спискових картках
        LIST_CARD_LABEL_BORDER_COLOR: 'rgba(61, 161, 141, 0.9)', // Зроблено як фон, щоб не було рамки
        LIST_CARD_LABEL_BACKGROUND_COLOR: 'rgba(61, 161, 141, 0.9)', 
        LIST_CARD_LABEL_BACKGROUND_TRANSPARENT: false,
        LIST_CARD_LABEL_TEXT_COLOR: '#FFFFFF',
        LIST_CARD_LABEL_FONT_WEIGHT: '600', // Було 600, стало 700 (як у Seasons)
        LIST_CARD_LABEL_FONT_SIZE: '0.9em', // Було 1.1em, стало 0.9em (як у Seasons)
        LIST_CARD_LABEL_FONT_STYLE: 'normal',
        

        // Ручні перевизначення якості для конкретних ID контенту
        MANUAL_OVERRIDES: {
            '338969': {
                quality_code: 2160,
                full_label: '4K WEB-DL', //✅ Повна мітка
                simple_label: '4K'  	 //✅ Спрощена мітка
            },
            '654028': {
                quality_code: 2160,
                full_label: '4K WEB-DL', //✅ Повна мітка
                simple_label: '4K'  	 //✅ Спрощена мітка
            },
            '12556': {
                quality_code: 1080,
                full_label: '1080 ВDRemux', //✅ Повна мітка
                simple_label: 'FHD'  	 //✅ Спрощена мітка
            },
            '604079': {
                quality_code: 2160,
                full_label: '4K WEB-DL', //✅ Повна мітка
                simple_label: '4K'  	 //✅ Спрощена мітка
            },
            '1267905': {
                quality_code: 2160,
                full_label: '4K WEB-DL', //✅ Повна мітка
                simple_label: '4K'  	 //✅ Спрощена мітка
            }

            /*'Тут ID фільму': { 
                quality_code: 1080, 
                full_label: '1080p WEB-DLRip',  //✅ Повна мітка
                simple_label: 'FHD'  		    //✅ Спрощена мітка
            },*/
            /*'Тут ID фільму': { 
                quality_code: 2160, 
                full_label: '4K WEB-DL',     //✅ Повна мітка
                simple_label: '4K'  		 //✅ Спрощена мітка
            }*/
        }
    };


    window.LQE_CONFIG = LQE_CONFIG;
    var currentGlobalMovieId = null; // Змінна для відстеження поточного ID фільму

    // ===================== МАПИ ДЛЯ ПАРСИНГУ ЯКОСТІ =====================

    // Мапа для прямих відповідностей назв якості (fallback)
    var QUALITY_DISPLAY_MAP = {
        "WEBRip 1080p | AVC @ звук с TS": "1080P WEBRip/TS",
        "TeleSynch 1080P": "1080P TS",
        "4K Web-DL 10bit HDR P81 HEVC": "4K WEB-DL",
        "Telecine [H.264/1080P] [звук с TS] [AD]": "1080P TS",
        "WEB-DLRip @ Синема УС": "WEB-DLRip",
        "UHD Blu-ray disc 2160p": "4K Blu-ray",
        "Blu-ray disc 1080P]": "1080P Blu-ray",
        "Blu-Ray Remux (1080P)": "1080P BDRemux",
        "BDRemux 1080P] [Крупний план]": "1080P BDRemux",
        "Blu-ray disc (custom) 1080P]": "1080P BDRip",
        "DVDRip [AV1/2160p] [4K, SDR, 10-bit] [hand made Upscale AI]": "4K Upscale AI",
        "Hybrid (2160p)": "4K Hybrid",
        "Blu-ray disc] [Mastered in 4K] [Extended Cut]": "4K Blu-ray",
        "4K, HEVC, HDR / Blu-Ray Remux (2160p)": "4K BDRemux",
        "4K, HEVC, HDR, HDR10+, Dolby Vision / Hybrid (2160p)": "4K Hybrid",
        "4K, HEVC, HDR, Dolby Vision P7 / Blu-Ray Remux (2160p)": "4K BDRemux",
        "4K, HEVC, HDR, Dolby Vision / Blu-Ray Remux (2160p)": "4K BDRemux",
        "Blu-Ray Remux 2160p | 4K | HDR | Dolby Vision P7": "4K BDRemux",
        "4K, HEVC, HDR / WEB-DLRip (2160p)": "4K WEB-DLRip",
        "Blu-ray disc (custom) 1080P] [StudioCanal]": "1080P BDRip",
        "hd-dvd remux": "HDRemux", "hddvdremux": "HDRemux", "hd dvd remux": "HDRemux",
        "HDTVRip [H.264/720p]": "720p HDTVRip",
        "HDTVRip 720p": "720p HDTVRip",
        "2025 / ЛМ / TC": "TC", // Telecine

        // Стандартні варіанти якості
        "2160p": "4K", "4k": "4K", "4К": "4K", "1080p": "1080p", "1080": "1080p",
        "1080i": "1080p", "hdtv 1080i": "1080i FHDTV", "480p": "SD", "480": "SD",
        "web-dl": "WEB-DL", "webrip": "WEBRip", "web-dlrip": "WEB-DLRip",
        "bluray": "BluRay", "bdrip": "BDRip", "bdremux": "BDRemux",
        "hdtvrip": "HDTVRip", "dvdrip": "DVDRip", "ts": "TS", "camrip": "CAMRip",

        "blu-ray remux (2160p)": "4K BDRemux", "hdtvrip 2160p": "4K HDTVRip", "hybrid 2160p": "4K Hybrid",
        "web-dlrip (2160p)": "4K WEB-DLRip",
        "1080p web-dlrip": "1080p WEB-DLRip", "webdlrip": "WEB-DLRip", "hdtvrip-avc": "HDTVRip-AVC",
        "HDTVRip (1080p)": "1080p FHDTVRip", "hdrip": "HDRip",
        "hdtvrip (720p)": "720p HDTVRip",
        "dvdrip": "DVDRip", "hdtv": "HDTV", "dsrip": "DSRip", "satrip": "SATRip",
        "telecine": "TC", "tc": "TC", "ts": "TS"

    };

    // Мапа для визначення роздільності з назви
    var RESOLUTION_MAP = {
        "2160p": "4K", "2160": "4K", "4k": "4K", "4к": "4K", "uhd": "4K", "ultra hd": "4K", "ultrahd": "4K", "dci 4k": "4K",
        "1440p": "QHD", "1440": "QHD", "2k": "QHD", "qhd": "QHD",
        "1080p": "1080p", "1080": "1080p", "1080i": "1080i", "full hd": "1080p", "fhd": "1080p",
        "720p": "720p", "720": "720p", "hd": "720p", "hd ready": "720p",
        "576p": "576p", "576": "576p", "pal": "576p",
        "480p": "480p", "480": "480p", "sd": "480p", "standard definition": "480p", "ntsc": "480p",
        "360p": "360p", "360": "360p", "low": "360p"
    };
    // Мапа для визначення джерела відео
    var SOURCE_MAP = {
        "blu-ray remux": "BDRemux", "uhd bdremux": "4K BDRemux", "bdremux": "BDRemux",
        "remux": "BDRemux", "blu-ray disc": "Blu-ray", "bluray": "Blu-ray", "hd-dvd remux": "HDRemux",
        "hddvdremux": "HDRemux", "hd dvd remux": "HDRemux",
        "blu-ray": "Blu-ray", "bdrip": "BDRip", "brrip": "BDRip",
        "uhd blu-ray": "4K Blu-ray", "4k blu-ray": "4K Blu-ray",
        "web-dl": "WEB-DL", "webdl": "WEB-DL", "web dl": "WEB-DL",
        "web-dlrip": "WEB-DLRip", "webdlrip": "WEB-DLRip", "web dlrip": "WEB-DLRip",
        "webrip": "WEBRip", "web rip": "WEBRip", "hdtvrip": "HDTVRip",
        "hdtv": "HDTVRip", "hdrip": "HDRip", "dvdrip": "DVDRip", "dvd rip": "DVDRip",
        "dvd": "DVD", "dvdscr": "DVDSCR", "scr": "SCR", "bdscr": "BDSCR", "r5": "R5",
        "hdrip": "HDRip",
        "screener": "SCR",
        "telecine": "TC", "hdtc": "TC", "telesync": "TS", /*"ts": "TS", "tc": "TC",*/
        "hdts": "TS", "camrip": "CAMRip", "hdcam": "CAMRip", /*"cam": "CAMRip",*/
        "vhsrip": "VHSRip", "vcdrip": "VCDRip", "dcp": "DCP", "workprint": "Workprint",
        "preair": "Preair", "tv": "TVRip", "line": "Line Audio", "hybrid": "Hybrid",
        "uhd hybrid": "4K Hybrid", "upscale": "Upscale", "ai upscale": "AI Upscale",
        "bd3d": "3D Blu-ray", "3d blu-ray": "3D Blu-ray"
    };
    // Мапа для спрощення повних назв якості до коротких форматів
    var QUALITY_SIMPLIFIER_MAP = {
        // Якість (роздільність)
        "2160p": "4K", "2160": "4K", "4k": "4K", "4к": "4K", "uhd": "4K", "ultra hd": "4K", "dci 4k": "4K", "ultrahd": "4K",
        "1440p": "QHD", "1440": "QHD", "2k": "QHD", "qhd": "QHD",
        "1080p": "FHD", "1080": "FHD", "1080i": "FHD", "full hd": "FHD", "fhd": "FHD",
        "720p": "HD", "720": "HD", "hd ready": "HD", "hd": "HD",
        "480p": "SD", "480": "SD", "sd": "SD", "pal": "SD", "ntsc": "SD", "576p": "SD", "576": "SD",
        "360p": "LQ", "360": "LQ",

        // Погана якість (джерело) - мають пріоритет над роздільністю при відображенні
        "camrip": "CamRip", "cam": "CamRip", "hdcam": "CamRip", "камрип": "CamRip",
        "telesync": "TS", "ts": "TS", "hdts": "TS", "телесинк": "TS",
        "telecine": "TC", "tc": "TC", "hdtc": "TC", "телесин": "TC",
        "dvdscr": "SCR", "scr": "SCR", "bdscr": "SCR", "screener": "SCR",

        // Якісні джерела
        "remux": "Remux", "bdremux": "Remux", "blu-ray remux": "Remux",
        "bluray": "BR", "blu-ray": "BR", "bdrip": "BRip", "brrip": "BRip",
        "web-dl": "WebDL", "webdl": "WebDL",
        "webrip": "WebRip", "web-dlrip": "WebDLRip", "webdlrip": "WebDLRip",
        "hdtv": "HDTV", "hdtvrip": "HDTV",
        "hdrip": "HDRip",
        "dvdrip": "DVDRip", "dvd": "DVD"
    };
    

    // ===================== СТИЛІ CSS =====================
    // Основні стилі для відображення якості
    var styleLQE = "<style id=\"lampa_quality_styles\">" +

        "/* ====================================================================== */" +
        "/* === 1. ЛІНІЯ РЕЙТИНГУ НА ПОВНІЙ КАРТЦІ (ДЕ ОПИС ФІЛЬМУ)            === */" +
        "/* ====================================================================== */" +
        ".full-start-new__rate-line {" + 
        "   flex-wrap: wrap;" +      // Дозволяє міткам (IMDb, Вік, Якість) переноситись на новий рядок
        "   gap: 0.4em 0;" +         // Відстань між рядками, якщо елементи перенеслися
        "}" +
        ".full-start-new__rate-line > * {" + 
        "   margin-right: 0.5em;" +  // Відступ праворуч від кожної мітки в рядку
        "   flex-shrink: 0;" +       // Забороняє стискати мітки
        "   flex-grow: 0;" + 
        "}" +

        "/* ====================================================================== */" +
        "/* === 2. МІТКА ЯКОСТІ НА ПОВНІЙ КАРТЦІ                               === */" +
        "/* ====================================================================== */" +
        ".lqe-quality {" + 
        "   min-width: 2.8em;" +     // Мінімальна ширина мітки
        "   text-align: center;" + 
        "   text-transform: none;" + 
        "   border: 1px solid " + LQE_CONFIG.FULL_CARD_LABEL_BORDER_COLOR + " !important;" + // Колір рамки
        "   color: " + LQE_CONFIG.FULL_CARD_LABEL_TEXT_COLOR + " !important;" +               // Колір тексту
        "   font-weight: " + LQE_CONFIG.FULL_CARD_LABEL_FONT_WEIGHT + " !important;" +       // Жирність тексту
        "   font-size: " + LQE_CONFIG.FULL_CARD_LABEL_FONT_SIZE + " !important;" +           // Розмір тексту
        "   font-style: " + LQE_CONFIG.FULL_CARD_LABEL_FONT_STYLE + " !important;" +         // Стиль шрифту
        "   border-radius: 0.2em;" + // Закруглення кутів
        "   padding: 0.3em;" +       // Внутрішні відступи
        "   height: 1.72em;" +       // Фіксована висота мітки
        "   display: flex;" + 
        "   align-items: center;" +  // Вертикальне вирівнювання
        "   justify-content: center;" + // Горизонтальне вирівнювання
        "   box-sizing: border-box;" + 
        "}" +

        "/* ====================================================================== */" +
        "/* === 3. МІТКА ЯКОСТІ У СПИСКАХ ФІЛЬМІВ (НА ПОСТЕРАХ)                === */" +
        "/* ====================================================================== */" +
        ".card__view { position: relative; }" + // Базовий контейнер для позиціонування
        
        "/* ЗОВНІШНІЙ БЛОК (Скидаємо втручання Лампи, копіюємо SeasonsInfo) */" +
        ".card__quality {" + 
        "   position: absolute !important; " + // Абсолютне позиціонування поверх постера
        "   left: 0 !important; " +            // Притискаємо до лівого краю
        "   right: auto !important; " +        // Захист від зміщення Лампою
        "   top: auto !important; " +          // Захист від зміщення Лампою
        "   bottom: 2.4em !important; " +      // ↕️ ВІДСТУП ЗНИЗУ (як у SeasonsInfo)
        "   margin: 0 !important; " +          // Скидаємо зовнішні відступи
        "   margin-left: -0.65em !important; " + // ↔️ ВІДСТУП ЗЛІВА (як у SeasonsInfo)
        "   padding: 0 !important; " +         // ❗ СКИДАЄМО рідний ламповський padding 0.4em
        "   background: none !important; " +   // Скидаємо рідний жовтий фон
        "   border: none !important; " +       // Прибираємо стандартну рамку
        "   z-index: 12 !important; " +        // Висота шару (як у SeasonsInfo)
        "   width: fit-content !important; " + // Ширина підлаштовується під текст
        "   max-width: calc(100% - 1em) !important; " + // Захист від довгого тексту
        "   border-radius: 0.3em !important; " + // 🔄 Закруглення кутів (як у SeasonsInfo)
        "   overflow: hidden !important; " + 
        "   font-size: inherit !important; " + // ❗ Успадковуємо розмір постера (щоб браузер рахував відступи ідентично)
        "   text-transform: none !important; " + 
        "}" +
        
        "/* ВНУТРІШНІЙ БЛОК (Точна копія стилів тексту з SeasonsInfo) */" +
        ".card__quality div {" + 
        "   text-transform: uppercase !important; " + // Всі літери ВЕЛИКІ
        "   font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif !important; " + // Назва шрифту
        "   font-weight: 600 !important; " +     // 🔠 ЖИРНІСТЬ тексту
        "   font-size: 0.9em !important; " +     // 🔠 РОЗМІР ТЕКСТУ
        "   color: " + LQE_CONFIG.LIST_CARD_LABEL_TEXT_COLOR + " !important; " + // Колір тексту
        "   padding: 0.39em 0.39em !important; " + // ↕️↔️ ВНУТРІШНІ ВІДСТУПИ (абсолютно ідентичні)
        "   margin: 0 !important; " +            // Захист від зсувів
        "   white-space: nowrap !important; " +  // Забороняє переносити текст
        "   display: flex !important; " + 
        "   align-items: center !important; " +  // Вертикальне центрування
        "   gap: 4px !important; " +             // Відстань між символами
        "   text-shadow: 0.5px 0.5px 1px rgba(0,0,0,0.3) !important; " + // 🌑 Тінь (як у SeasonsInfo)
        "}" +

        "/* ====================================================================== */" +
        "/* === 4. АДАПТАЦІЯ ДЛЯ МАЛИХ ЕКРАНІВ (СМАРТФОНИ / ПЛАНШЕТИ)          === */" +
        "/* ====================================================================== */" +
        "@media (max-width: 768px) {" +
        "   .card__quality div {" +
        "       font-size: 0.80em !important; " +  // Трохи менший шрифт на смартфонах
        "       padding: 0.35em 0.40em !important; " + // Трохи менші внутрішні відступи
        "   }" +
        "}" +

        "/* Приховати мітку на повній картці, якщо це вимкнено в налаштуваннях */" +
        ".lqe-hide-full .full-start__status.lqe-quality { display: none !important; }" +

        "/* === КОЛЬОРОВІ МІТКИ (Динамічні класи) === */" +
        ".card__quality.lqe-bg-premium { background-color: rgba(61, 161, 141, 0.9) !important; }" + // Зелений (для 4K/2K/Remux)
        ".card__quality.lqe-bg-standard { background-color: rgba(66, 135, 245, 0.9) !important; }" + // М'який синій (для FHD, HD, SD)
        ".card__quality.lqe-bg-poor { background-color: rgba(235, 87, 87, 0.9) !important; }" +     // М'який червоний (для TS, CAM, TC)
        "</style>";
        

    // Додаємо стилі до DOM
    Lampa.Template.add('lampa_quality_css', styleLQE);
    $('body').append(Lampa.Template.get('lampa_quality_css', {}, true));
    
    // ======================================================================
    // === 5. СТИЛІ ДЛЯ ПЛАВНОЇ ПОЯВИ МІТОК (Анімація)                    ===
    // ======================================================================
    var fadeStyles = "<style id='lampa_quality_fade'>" +
        ".card__quality, .full-start__status.lqe-quality {" + 
        "   opacity: 0;" + // Спочатку мітка повністю прозора
        "   transition: opacity 0.22s ease-in-out;" + // Час анімації появи (0.22 сек)
        "}" +
        ".card__quality.show, .full-start__status.lqe-quality.show {" + 
        "   opacity: 1;" + // Коли завантажилась - стає видимою
        "}" +
        ".card__quality.show.fast, .full-start__status.lqe-quality.show.fast {" + 
        "   transition: none !important;" + // Вимкнення анімації для миттєвої появи
        "}" +
        "</style>";

    // ======================================================================
    // === 6. СТИЛІ ЛОАДЕРА (Три крапки, що стрибають під час пошуку)     ===
    // ======================================================================
    var lqeLoaderCss = "<style id=\"lqe_search_loader_css\">" +
        "#lqe-search-loader.loading-dots-container {" +
        "   display: inline-flex; align-items: center; gap: .4em; color: #ccc;" +
        "   font-size: .85em; background: rgba(0,0,0,.3); padding: .6em 1em;" +
        "   border-radius: .5em; pointer-events: none;" +
        "}" +
        "#lqe-search-loader .loading-dots__text { margin-right: .6em; }" +
        "#lqe-search-loader .loading-dots__dot {" +
        "   width: .5em; height: .5em; border-radius: 50%; background: currentColor;" +
        "   animation: lqe-dots-bounce 1.4s infinite ease-in-out both;" + // Анімація стрибання
        "}" +
        "#lqe-search-loader .loading-dots__dot:nth-child(2) { animation-delay: -.16s; }" +
        "#lqe-search-loader .loading-dots__dot:nth-child(3) { animation-delay: -.32s; }" +
        "@keyframes lqe-dots-bounce {" +
        "   0%, 80%, 100% { transform: translateY(0); opacity: .6; }" +
        "   40% { transform: translateY(-.5em); opacity: 1; }" +
        "}" +
        // Ховаємо реальну лінію рейтингу, поки вантажиться
        ".full-start-new__rate-line.lqe-is-loading > :not(#lqe-search-loader), " +
        ".full-start__rate-line.lqe-is-loading > :not(#lqe-search-loader) {" +
        "   opacity: 0 !important; pointer-events: none !important; transition: opacity .15s;" +
        "}" +
        "@media (max-width: 600px) {" +
        "   #lqe-search-loader.loading-dots-container { font-size: .8em; padding: .4em .8em; }" +
        "}" +
        "</style>";

    Lampa.Template.add('lqe_search_loader_css', lqeLoaderCss);
    $('body').append(Lampa.Template.get('lqe_search_loader_css', {}, true));
    
    Lampa.Template.add('lampa_quality_fade', fadeStyles);
    $('body').append(Lampa.Template.get('lampa_quality_fade', {}, true));

   

    // ===================== МЕРЕЖЕВІ ФУНКЦІЇ =====================
    /**
     * Виконує запит через проксі з обробкою помилок + fallback для старих WebView
     * @param {string} url - оригінальний URL, який хочемо викликати
     * @param {string} cardId - ID картки (тільки для логів)
     * @param {function} callback - callback(err, data)
     */
function fetchWithProxy(url, cardId, callback) {
    var currentProxyIndex = 0;
    var callbackCalled = false;
    var saw429 = false;

    function buildProxyUrl(proxy, targetUrl) {
        // підстановка ключа у воркер-проксі
        if (proxy.indexOf('{KEY}') !== -1) {
            proxy = proxy.replace('{KEY}', encodeURIComponent(LQE_CONFIG.WORKER_KEY || ''));
        }

        // allorigins / worker (?url=) -> encodeURIComponent(targetUrl)
        if (proxy.indexOf('url=') !== -1) {
            return proxy + encodeURIComponent(targetUrl);
        }

        // cors.bwa.workers.dev/Host/{URL} -> targetUrl без encode
        // гарантуємо один слеш між проксі і targetUrl
        return (proxy.charAt(proxy.length - 1) === '/' ? proxy : (proxy + '/')) + targetUrl;
    }

    function tryNextProxy() {
if (currentProxyIndex >= LQE_CONFIG.PROXY_LIST.length) {
    if (!callbackCalled) {
        callbackCalled = true;

        // якщо причина — 429/cooldown, повертаємо спец-помилку
        if (saw429) {
            callback(new Error('LQE_COOLDOWN'));
        } else {
            callback(new Error('All proxies failed for ' + url));
        }
    }
    return;
}


var proxy = LQE_CONFIG.PROXY_LIST[currentProxyIndex];
var proxyUrl = buildProxyUrl(proxy, url);

// якщо цей proxy-host у cooldown — пропускаємо його
var phost = lqeGetHost(proxyUrl);
if (phost && lqeHostInCooldown(phost)) {
    if (LQE_CONFIG.LOGGING_GENERAL) {
        console.log("LQE-LOG", "card: " + cardId + ", Proxy in cooldown, skip:", phost);
    }
    currentProxyIndex++;
    tryNextProxy();
    return;
}


        if (LQE_CONFIG.LOGGING_GENERAL) {
            console.log("LQE-LOG", "card: " + cardId + ", Fetch with proxy: " + proxyUrl);
        }

        var finished = false;
        var timeoutId = setTimeout(function () {
            if (finished) return;
            finished = true;
            currentProxyIndex++;
            tryNextProxy();
        }, LQE_CONFIG.PROXY_TIMEOUT_MS);

LQE_safeFetchText(proxyUrl)
    .then(function (data) {
        if (finished) return;

        // ⛔️ 429 як текстове тіло (від воркера або upstream)
        if (typeof data === 'string' && data.indexOf('Too Many Requests') !== -1) {
            finished = true;
            clearTimeout(timeoutId);

            saw429 = true;
            lqeSetHostCooldown(phost);

            currentProxyIndex++;
            tryNextProxy();
            return;
        }

        // ✅ нормальна відповідь
        finished = true;
        clearTimeout(timeoutId);

        if (!callbackCalled) {
            callbackCalled = true;
            callback(null, data);
        }
    })

.catch(function (error) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutId);

    var emsg = (error && error.message) ? String(error.message) : '';

    // ⛔️ 429 через fetch / XHR
    if (emsg.indexOf('429') !== -1) {
        saw429 = true;
        lqeSetHostCooldown(phost);
    }

    if (LQE_CONFIG.LOGGING_GENERAL) {
        console.error(
            "LQE-LOG",
            "card: " + cardId + ", Proxy fetch error for " + proxyUrl + ":",
            error
        );
    }

    currentProxyIndex++;
    tryNextProxy();
});

    }

    tryNextProxy();
}

    // ===================== АНІМАЦІЯ ЗАВАНТАЖЕННЯ =====================
    /**
     * Додає анімацію завантаження до картки
     * @param {string} cardId - ID картки
     * @param {Element} renderElement - DOM елемент
     */
    /**
     * Додає анімацію завантаження всередині рядка рейтингів,
     * не змінюючи видимість самого рядка.
     * - НІКОЛИ не ховає .full-start-new__rate-line
     * - Не додає дублікат, якщо анімація вже є
     * - Поважає налаштування: якщо мітку вимкнено — анімацію не показуємо
     */
    //LQE loader
    var __lqeRateLineObs = null;

    function addLoadingAnimation(cardId, renderElement) {
        if (!renderElement) return;
        if (window.LQE_CONFIG && LQE_CONFIG.SHOW_FULL_CARD_LABEL === false) return;

        var render = $(renderElement);
        if (!render.length) return;

        if ($('#lqe-search-loader', render).length) return; // вже є

        var loaderHtml =
            '<div id="lqe-search-loader" class="loading-dots-container">' +
            '<span class="loading-dots__text">Пошук…</span>' +
            '<span class="loading-dots__dot"></span>' +
            '<span class="loading-dots__dot"></span>' +
            '<span class="loading-dots__dot"></span>' +
            '</div>';

        var realSel = '.full-start-new__rate-line:not([data-lqe-fake]), .full-start__rate-line:not([data-lqe-fake])';
        var rateLine = $(realSel, render).first();

        if (rateLine.length) {
            rateLine.append(loaderHtml).addClass('lqe-is-loading');
            return;
        }

        // якщо реального рядка ще немає — ставимо тимчасовий
        var fake = $(
            '<div class="full-start-new__rate-line" id="lqe-loader-fake" data-lqe-fake="1" ' +
            '     style="min-height:28px; display:flex; align-items:center;"></div>'
        );
        var anchor = $('.full-start-new__title, .full-start__title', render).first();
        if (anchor.length) anchor.after(fake); else render.append(fake);
        fake.append(loaderHtml);

        try { if (__lqeRateLineObs) __lqeRateLineObs.disconnect(); } catch (_) { }
        __lqeRateLineObs = new MutationObserver(function () {
            var rl = $(realSel, render).first();
            var loader = $('#lqe-search-loader', render);
            if (rl.length && loader.length) {
                rl.append(loader).addClass('lqe-is-loading');
                $('#lqe-loader-fake', render).remove();
                try { __lqeRateLineObs.disconnect(); } catch (_) { }
                __lqeRateLineObs = null;
            }
        });
        if (render[0]) __lqeRateLineObs.observe(render[0], { childList: true, subtree: true });

        setTimeout(function () {
            if (__lqeRateLineObs) {
                try { __lqeRateLineObs.disconnect(); } catch (_) { }
                __lqeRateLineObs = null;
            }
        }, 6000);
    }

    function removeLoadingAnimation(cardId, renderElement) {
        if (!renderElement) return;
        var render = $(renderElement);
        if (!render.length) return;

        $('#lqe-search-loader', render).remove();
        $('#lqe-loader-fake', render).remove();

        var rl = $('.full-start-new__rate-line:not([data-lqe-fake]), .full-start__rate-line:not([data-lqe-fake])', render).first();
        if (rl.length) rl.removeClass('lqe-is-loading');

        try { if (__lqeRateLineObs) __lqeRateLineObs.disconnect(); } catch (_) { }
        __lqeRateLineObs = null;
    }
    // ===================== УТІЛІТИ =====================
    /**
     * Визначає тип контенту (фільм/серіал)
     * @param {object} cardData - Дані картки
     * @returns {string} - 'movie' або 'tv'
     */
    function getCardType(cardData) {
        var type = cardData.media_type || cardData.type; // Отримуємо тип з даних
        if (type === 'movie' || type === 'tv') return type; // Якщо тип визначено
        return cardData.name || cardData.original_name ? 'tv' : 'movie'; // Визначаємо по наявності назви
    }
    /**
     * Очищує та нормалізує назву для пошуку
     * @param {string} title - Оригінальна назва
     * @returns {string} - Нормалізована назва
     */
    function sanitizeTitle(title) {
        if (!title) return ''; // Перевірка на пусту назву
        // Приводимо до нижнього регістру, замінюємо роздільники на пробіли, видаляємо зайві пробіли
        return title.toString().toLowerCase()
            .replace(/[\._\-\[\]\(\),]+/g, ' ') // Заміна роздільників на пробіли
            .replace(/\s+/g, ' ') // Видалення зайвих пробілів
            .trim(); // Обрізка пробілів по краях
    }

    // ===================== TS/TC CONTEXT HELPERS =====================
// Ідея: TS/TC беремо як "погану якість" лише коли це ВІДЕО-контекст,
// а не "звук с TS" (аудіо) або шматки слів/імен.

// "звук с TS", "звук из TS", "audio from TS", "sound from TS"
function lqeHasAudioTSContext(s) {
    if (!s) return false;
    return /(?:звук\s*(?:с|из|із)\s*ts\b|audio\s*(?:from|of)\s*ts\b|sound\s*(?:from|of)\s*ts\b)/i.test(s);
}

// TS як відео-джерело: "(2025) TS", "/ 2025 / TS", "TS [H.264/1080p]" і т.п.
function lqeHasVideoTSContext(s) {
    if (!s) return false;
    return /(?:\(\s*\d{4}\s*\)\s*ts\b|\b\d{4}\s*\/\s*ts\b|\bts\b\s*\[(?:h\.?264|h\.?265|hevc|avc|x264|x265|1080p|720p))/i.test(s);
}

// TC як відео-джерело: "(2025) TC", "/ 2025 / TC", "TC [H.264/1080p]" і т.п.
function lqeHasVideoTCContext(s) {
    if (!s) return false;
    return /(?:\(\s*\d{4}\s*\)\s*tc\b|\b\d{4}\s*\/\s*tc\b|\btc\b\s*\[(?:h\.?264|h\.?265|hevc|avc|x264|x265|1080p|720p))/i.test(s);
}

    /**
     * Генерує ключ для кешу
     * @param {number} version - Версія кешу
     * @param {string} type - Тип контенту
     * @param {string} id - ID картки
     * @returns {string} - Ключ кешу
     */
    function makeCacheKey(version, type, id) {
        return version + '_' + (type === 'tv' ? 'tv' : 'movie') + '_' + id; // Форматуємо ключ
    }

    // ===================== ПАРСИНГ ЯКОСТІ =====================
    /**
     * Спрощує повну назву якості до короткого формату 
     * @param {string} fullLabel - Повна назва якості (вибрана з найкращого релізу JacRed)
     * @param {string} originalTitle - Оригінальна назва торренту
     * @returns {string} - Спрощена назва для відображення на мітці
     */
    function simplifyQualityLabel(fullLabel, originalTitle) {
        if (!fullLabel) return ''; // Перевірка на пусту назву

        var lowerLabel = fullLabel.toLowerCase(); // Нижній регістр для порівняння
        // var lowerTitle = (originalTitle || '').toLowerCase(); // ❌ БІЛЬШЕ НЕ ВИКОРИСТОВУЄМО (перебиває якісний реліз)

        // Якщо в уже сформованій мітці є TS/TC — це ТОЧНО відео-тип релізу
        // (бо translateQualityLabel формує "1080p TS", а не "звук с TS").
        // Але на всякий випадок відсікаємо аудіо-контекст.
        if (!lqeHasAudioTSContext(lowerLabel)) {
            if (/\bts\b/.test(lowerLabel)) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TS (label contains TS)");
                return "TS";
            }
            if (/\btc\b/.test(lowerLabel)) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TC (label contains TC)");
                return "TC";
            }
        }
        
        // --- Крок 1: Погані якості (найвищий пріоритет) ---
        // Якщо JacRed вибрав реліз з поганою якістю - показуємо тип якості
        // Це означає що кращих варіантів немає

        // CamRip - найгірша якість (запис з кінотеатру камерою)
        if (/(camrip|камрип|cam\b)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to CamRip");
            return "CamRip";
        }

        // TS (Telesync) - погана якість (запис з проектора)
        /*if (/(telesync|телесинк|\bts\b|hdts)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TS");
            return "TS";
        }*/
        

        // TC (Telecine) - погана якість (запис з кіноплівки)
        /*if (/(telecine|телесин|\btc\b|hdtc)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TC");
            return "TC";
        }*/

        // TS (Telesync) - погана якість (відео-джерело)
        if (/(telesync|телесинк|hdts)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TS (telesync/hdts)");
            return "TS";
        }

        // "голий" TS як токен — тільки якщо є відео-контекст
        if (/\bts\b/.test(lowerLabel) && lqeHasVideoTSContext(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TS (token, video-context)");
            return "TS";
        }

        // TC (Telecine) - погана якість (відео-джерело)
        if (/(telecine|телесин|hdtc)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TC (telecine/hdtc)");
            return "TC";
        }

        // "голий" TC як токен — тільки якщо є відео-контекст
        if (/\btc\b/.test(lowerLabel) && lqeHasVideoTCContext(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to TC (token, video-context)");
            return "TC";
        }


        // SCR (DVD Screener) - погана якість (промо-копія)
        if (/(dvdscr|scr\b)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to SCR");
            return "SCR";
        }

        // --- Крок 2: Якісні джерела (тільки якщо немає поганих якостей) ---
        // Якщо JacRed вибрав якісний реліз - показуємо роздільність

        // 4K (Ultra HD) - найвища якість
        if (/(2160p|4k|uhd|ultra hd)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to 4K");
            return "4K";
        }

        // 2К (QHD) - висока якість
        if (/(1440p|1440|2k|qhd)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to QHD");
            return "QHD";
        }

        // FHD (Full HD) - висока якість
        if (/(1080p|1080|fullhd|fhd)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to FHD");
            return "FHD";
        }

        // HD (High Definition) - середня якість
        if (/(720p|720|hd\b)/.test(lowerLabel)) {
            var hdRegex = /(720p|720|^hd$| hd |hd$)/;
            if (hdRegex.test(lowerLabel)) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to HD");
                return "HD";
            }
        }

        // Крок WEB-DLRip без роздільності → HD (ДОДАНО)
        if (/(web-dlrip|webdlrip)\b/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to HD");
            return "HD";
        }

        // SD (Standard Definition) - базова якість
        if (/(480p|480|sd\b)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to SD");
            return "SD";
        }

        // LQ (Low Quality) - дуже низька якість
        if (/(360p|360|low quality|lq\b)/.test(lowerLabel)) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified to LQ");
            return "LQ";
        }

        // --- Крок 3: Fallback ---
        // Якщо нічого з вищеперерахованого не знайдено, повертаємо оригінальну повну назву
        if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "No simplification rules matched, keeping original:", fullLabel);
        return fullLabel;
    }

    /**
     * Перетворює технічну назву якості на читабельну
     * @param {number} qualityCode - Код якості
     * @param {string} fullTorrentTitle - Повна назва торренту
     * @returns {string} - Відформатована назва якості
     */
    function translateQualityLabel(qualityCode, fullTorrentTitle) {
        if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "translateQualityLabel:", qualityCode, fullTorrentTitle);
        var title = sanitizeTitle(fullTorrentTitle || ''); // Нормалізуємо назву
        var titleForSearch = ' ' + title + ' '; // Додаємо пробіли для точного пошуку

        // Пошук роздільності в назві
        var resolution = '';
        var bestResKey = '';
        var bestResLen = 0;
        for (var rKey in RESOLUTION_MAP) {
            if (!RESOLUTION_MAP.hasOwnProperty(rKey)) continue; // Перевірка власної властивості
            var lk = rKey.toString().toLowerCase(); // Нижній регістр ключа
            // Шукаємо повне слово в назві
            if (titleForSearch.indexOf(' ' + lk + ' ') !== -1 || title.indexOf(lk) !== -1) {
                // Вибираємо найдовший збіг (найточніший)
                if (lk.length > bestResLen) {
                    bestResLen = lk.length;
                    bestResKey = rKey;
                }
            }
        }
        if (bestResKey) resolution = RESOLUTION_MAP[bestResKey]; // Отримуємо роздільність


        // Пошук джерела в назві
        var source = '';
        var bestSrcKey = '';
        var bestSrcLen = 0;
        for (var sKey in SOURCE_MAP) {
            if (!SOURCE_MAP.hasOwnProperty(sKey)) continue;
            var lk2 = sKey.toString().toLowerCase();
            if (titleForSearch.indexOf(' ' + lk2 + ' ') !== -1 || title.indexOf(lk2) !== -1) {
                if (lk2.length > bestSrcLen) {
                    bestSrcLen = lk2.length;
                    bestSrcKey = sKey;
                }
            }
        }
        if (bestSrcKey) source = SOURCE_MAP[bestSrcKey]; // Отримуємо джерело

        // --- TS/TC як відео-джерело (коли це просто токен) ---
        // Не тримаємо "ts"/"tc" у SOURCE_MAP, щоб не ловити "звук с TS".
        // Тому: якщо source не визначився або визначився як "TV"/інше,
        // пробуємо витягнути TS/TC через контекст.

        var t = title; // title вже sanitizeTitle(...)
        if (!source) {
            // відсікаємо "звук с TS", "audio from TS" тощо
            if (!lqeHasAudioTSContext(t)) {
                if (/\btc\b/.test(t) && lqeHasVideoTCContext(t)) {
                    source = "TC";
                } else if (/\bts\b/.test(t) && lqeHasVideoTSContext(t)) {
                    source = "TS";
                }
            }
        }

        /*
        // --- ДОДАТКОВО: TS/TC як відео-джерело (коли це просто токен) ---
        // Ми НЕ тримаємо "ts"/"tc" у SOURCE_MAP, щоб не ловити "звук с TS".
        // Тому визначаємо TS/TC через контекст-хелпери.
        if (!source) {
            // спершу відсікаємо "звук с TS", "audio from TS" і т.п.
            if (!lqeHasAudioTSContext(title)) {
                if (lqeHasVideoTCContext(title)) {
                    source = "TC";
                } else if (lqeHasVideoTSContext(title)) {
                    source = "TS";
                }
            }
        }
        */
        
        // Комбінуємо роздільність та джерело
        var finalLabel = '';
        if (resolution && source) {
            if (source.toLowerCase().includes(resolution.toLowerCase())) {
                finalLabel = source; // Якщо джерело вже містить роздільність
            } else {
                finalLabel = resolution + ' ' + source; // Комбінуємо
            }
        } else if (resolution) {
            finalLabel = resolution; // Тільки роздільність
        } else if (source) {
            finalLabel = source; // Тільки джерело
        }

        // Fallback на пряму мапу
        if (!finalLabel || finalLabel.trim() === '') {
            var bestDirectKey = '';
            var maxDirectLen = 0;
            for (var qk in QUALITY_DISPLAY_MAP) {
                if (!QUALITY_DISPLAY_MAP.hasOwnProperty(qk)) continue;
                var lkq = qk.toString().toLowerCase();
                if (title.indexOf(lkq) !== -1) {
                    if (lkq.length > maxDirectLen) {
                        maxDirectLen = lkq.length;
                        bestDirectKey = qk;
                    }
                }
            }
            if (bestDirectKey) {
                finalLabel = QUALITY_DISPLAY_MAP[bestDirectKey]; // Використовуємо пряму мапу
            }
        }

        // Останній fallback
        if (!finalLabel || finalLabel.trim() === '') {
            if (qualityCode) {
                var qc = String(qualityCode).toLowerCase();
                finalLabel = QUALITY_DISPLAY_MAP[qc] || qualityCode; // По коду або оригіналу
            } else {
                finalLabel = fullTorrentTitle || ''; // Оригінальна назва
            }
        }

        // Автоматичне спрощення якості (якщо увімкнено в конфігурації)
        if (LQE_CONFIG.USE_SIMPLE_QUALITY_LABELS) {
            var simplifiedLabel = simplifyQualityLabel(finalLabel, fullTorrentTitle);
            if (simplifiedLabel && simplifiedLabel !== finalLabel) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Simplified quality:", finalLabel, "→", simplifiedLabel);
                finalLabel = simplifiedLabel;
            }
        }

        if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Final quality label:", finalLabel);
        return finalLabel;
    }

    // ===================== ЧЕРГА ЗАПИТІВ (Lite-черга) =====================

    var requestQueue = []; // Масив для зберігання завдань у черзі
    var activeRequests = 0; // Лічильник активних запитів

    /**
     * Додає завдання до черги та запускає обробку
     * @param {function} fn - Функція завдання (приймає callback done)
     */
    function enqueueTask(fn) {
        requestQueue.push(fn); // Додаємо завдання в кінець черги
        processQueue(); // Запускаємо обробку черги
    }

    /**
     * Обробляє чергу завдань з дотриманням обмеження паралельності
     */
    function processQueue() {
        // Перевіряємо, чи не перевищено ліміт паралельних запитів
        if (activeRequests >= LQE_CONFIG.MAX_PARALLEL_REQUESTS) return;
        var task = requestQueue.shift(); // Беремо перше завдання з черги
        if (!task) return; // Якщо черга порожня - виходимо

        activeRequests++; // Збільшуємо лічильник активних запитів

        try {
            // Виконуємо завдання з callback-функцією завершення
            task(function onTaskDone() {
                activeRequests--; // Зменшуємо лічильник
                setTimeout(processQueue, 0); // Запускаємо наступне завдання
            });
        } catch (e) {
            // Обробляємо помилки виконання завдання
            console.error("LQE-LOG", "Queue task error:", e);
            activeRequests--; // Все одно зменшуємо лічильник
            setTimeout(processQueue, 0); // Продовжуємо обробку
        }
    }
// ===================== 429 COOLDOWN + RETRY (A+B) =====================

// cooldown по проксі-хосту: { "myfinder.kozak-bohdan.workers.dev": timestamp_ms }
var LQE_HOST_COOLDOWN = {};

// pending повтори по cardId: { "123": { nextAt, tries } }
var LQE_PENDING = {};
var LQE_PENDING_TIMER = null;

function lqeNow() { return Date.now(); }

function lqeRand(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
}

function lqeGetHost(u) {
    try { return (new URL(u)).hostname; } catch (e) { return ''; }
}

function lqeHostInCooldown(host) {
    var t = LQE_HOST_COOLDOWN[host] || 0;
    return t > lqeNow();
}

function lqeSetHostCooldown(host, ms) {
    if (!host) return;
    var dur = ms || lqeRand(30000, 120000); // 30–120s
    var until = lqeNow() + dur;

    // не зменшуємо існуючий cooldown, тільки продовжуємо
    if ((LQE_HOST_COOLDOWN[host] || 0) < until) LQE_HOST_COOLDOWN[host] = until;

    if (LQE_CONFIG.LOGGING_GENERAL) {
        console.log("LQE-LOG", "Cooldown set for host:", host, "ms:", dur);
    }
}

function lqeFindCardRootById(cardId) {
    // шукаємо DOM-картку, яка має card_data.id
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
        var cd = cards[i].card_data;
        if (cd && String(cd.id) === String(cardId)) return cards[i];
    }
    return null;
}

function lqeSchedulePendingRetry(cardId) {
    if (!cardId) return;

    var p = LQE_PENDING[cardId] || { tries: 0, nextAt: 0 };
    if (p.tries >= 2) return; // щоб не крутити безкінечно (можеш підняти до 3)

    p.tries++;
    p.nextAt = lqeNow() + lqeRand(30000, 120000);
    LQE_PENDING[cardId] = p;

    if (LQE_CONFIG.LOGGING_GENERAL) {
        console.log("LQE-LOG", "Pending retry scheduled for card:", cardId, "tries:", p.tries, "in(ms):", (p.nextAt - lqeNow()));
    }

    if (!LQE_PENDING_TIMER) {
        LQE_PENDING_TIMER = setInterval(function () {
            var now = lqeNow();
            var any = false;

            for (var id in LQE_PENDING) {
                if (!LQE_PENDING.hasOwnProperty(id)) continue;
                any = true;

                var st = LQE_PENDING[id];
                if (!st || now < st.nextAt) continue;

                // якщо картка є в DOM — пробуємо оновити (B)
                var root = lqeFindCardRootById(id);
                if (root) {
                    // updateCardListQuality вже вміє приймати DOM element
                    updateCardListQuality(root);
                }

                // прибираємо pending незалежно від того, вдалось чи ні:
                // якщо не вдалось або картки нема — доб’є onVisible (A)
                delete LQE_PENDING[id];
            }

            if (!any) {
                clearInterval(LQE_PENDING_TIMER);
                LQE_PENDING_TIMER = null;
            }
        }, 1500);
    }
}

    // ===================== ПОШУК В JACRED =====================
    /**
     * Визначає якість з назви торренту
     * @param {string} title - Назва торренту
     * @returns {number} - Числовий код якості (2160, 1440, 1080, 720, 480, 3, 2, 1)
     */
    function extractNumericQualityFromTitle(title) {
        if (!title) return 0;
        var lower = title.toLowerCase();

        // 1) Погані якості — ПЕРШІ (але тільки у відео-контексті)
        if (/(?:\btelecine\b|hdtc)/.test(lower)) return 3;
        if (/(?:\btelesync\b|hdts)/.test(lower)) return 2;

        if (/\btc\b/.test(lower) && lqeHasVideoTCContext(lower)) return 3;
        if (/\bts\b/.test(lower) && lqeHasVideoTSContext(lower)) return 2;

        if (/camrip|камрип/.test(lower)) return 1;

        // 2) Далі — роздільність (для нормальних релізів)
        if (/2160p|4k/.test(lower)) return 2160;
        if (/1440p|qhd|2k/.test(lower)) return 1440;
        if (/1080p/.test(lower)) return 1080;
        if (/720p/.test(lower)) return 720;
        if (/480p/.test(lower)) return 480;

        return 0;
    }

    /*function extractNumericQualityFromTitle(title) {
        if (!title) return 0; // Перевірка на пусту назву
        var lower = title.toLowerCase(); // Нижній регістр для порівняння

        // ✅ ПРАВИЛЬНІ ПРІОРИТЕТИ:
        if (/2160p|4k/.test(lower)) return 2160; // Найвищий пріоритет - 4K
        if (/1440p|qhd|2k/.test(lower)) return 1440; // QHD
        if (/1080p/.test(lower)) return 1080; // Full HD
        if (/720p/.test(lower)) return 720; // HD
        if (/480p/.test(lower)) return 480; // SD
        
        // Погані якості - правильний порядок (TC > TS > CamRip):
        
        //if (/(?:\btelecine\b|\btc\b)/.test(lower)) return 3;
                //if (/tc|telecine/.test(lower)) return 3; // TC краще за TS (Old)
        //if (/(?:\btelesync\b|\bts\b)/.test(lower)) return 2;
                //if (/ts|telesync/.test(lower)) return 2; // TS краще за CamRip (Old)
        
        // Погані якості - правильний порядок (TC > TS > CamRip):
        // Явні маркери - без контексту
        if (/(?:\btelecine\b|hdtc)/.test(lower)) return 3;
        if (/(?:\btelesync\b|hdts)/.test(lower)) return 2;
        // "голий" TC/TS — тільки у відео-контексті
        if (/\btc\b/.test(lower) && lqeHasVideoTCContext(lower)) return 3;
        if (/\bts\b/.test(lower) && lqeHasVideoTSContext(lower)) return 2;

        if (/camrip|камрип/.test(lower)) return 1; // CamRip - найгірше

        return 0; // Якість не визначена
    }*/

    /**
     * Знаходить найкращий реліз в JacRed API
     * @param {object} normalizedCard - Нормалізовані дані картки
     * @param {string} cardId - ID картки
     * @param {function} callback - Callback функція
     */
    function getBestReleaseFromJacred(normalizedCard, cardId, callback) {
        enqueueTask(function (done) {
            // === ЗМІНА 1: Додано перевірку на майбутній реліз ===
            var releaseDate = normalizedCard.release_date ? new Date(normalizedCard.release_date) : null;
            if (releaseDate && releaseDate.getTime() > Date.now()) {
                if (LQE_CONFIG.LOGGING_QUALITY) {
                    console.log("LQE-QUALITY", "card: " + cardId + ", Future release. Skipping JacRed search.");
                }
                callback(null);
                done();
                return;
            }
            // === КІНЕЦЬ ЗМІНИ 1 ===

            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Searching JacRed...");

            // Перевірка налаштувань JacRed
            if (!LQE_CONFIG.JACRED_URL) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", JacRed URL not configured");
                callback(null);
                done();
                return;
            }

            // Витягуємо рік з дати релізу
            var year = '';
            if (normalizedCard.release_date && normalizedCard.release_date.length >= 4) {
                year = normalizedCard.release_date.substring(0, 4);
            }
            if (!year || isNaN(year)) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Invalid year");
                callback(null);
                done();
                return;
            }

            var searchYearNum = parseInt(year, 10);
            // Допоміжна функція для витягування року з назви
            function extractYearFromTitle(title) {
                var regex = /(?:^|[^\d])(\d{4})(?:[^\d]|$)/g;
                var match, lastYear = 0;
                var currentYear = new Date().getFullYear();
                while ((match = regex.exec(title)) !== null) {
                    var extractedYear = parseInt(match[1], 10);
                    if (extractedYear >= 1900 && extractedYear <= currentYear + 1) {
                        lastYear = extractedYear;
                    }
                }
                return lastYear;
            }

            // Функція пошуку в JacRed API
            function searchJacredApi(searchTitle, searchYear, exactMatch, strategyName, apiCallback) {
                var userId = Lampa.Storage.get('lampac_unic_id', '');
                var apiUrl = LQE_CONFIG.JACRED_PROTOCOL + LQE_CONFIG.JACRED_URL + '/api/v1.0/torrents?search=' +
                    encodeURIComponent(searchTitle) +
                    '&year=' + searchYear +
                    (exactMatch ? '&exact=true' : '') +
                    '&uid=' + userId;
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", JacRed: " + strategyName + " URL: " + apiUrl);
                // Таймаут для запиту
                var timeoutId = setTimeout(function () {
                    if (LQE_CONFIG.LOGGING_GENERAL) console.log("LQE-LOG", "card: " + cardId + ", JacRed: " + strategyName + " request timed out.");
                    apiCallback(null);
                }, LQE_CONFIG.PROXY_TIMEOUT_MS * LQE_CONFIG.PROXY_LIST.length + 1000);

                // Виконуємо запит через проксі
                fetchWithProxy(apiUrl, cardId, function (error, responseText) {
                    clearTimeout(timeoutId);

    // якщо всі проксі дали 429/cooldown — плануємо повтор (A+B)
    if (error && error.message === 'LQE_COOLDOWN') {
        if (LQE_CONFIG.LOGGING_GENERAL) {
            console.log("LQE-LOG", "card: " + cardId + ", 429 cooldown. Schedule retry.");
        }
        lqeSchedulePendingRetry(cardId);
        apiCallback(null);
        return;
    }

    if (error || !responseText) {
        if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", JacRed fetch error:", error);
        apiCallback(null);
        return;
    }

                    try {
                        var parsed = JSON.parse(responseText);
                        var torrents = [];

                            if (Array.isArray(parsed)) torrents = parsed;
                            else if (parsed && Array.isArray(parsed.Results)) torrents = parsed.Results;
                            else if (parsed && Array.isArray(parsed.results)) torrents = parsed.results;

                                    if (!torrents.length) {
                                    apiCallback(null);
                                    return;
                                    }


                        var bestNumericQuality = -1; // Найкраща знайдена якість
                        var bestFoundTorrent = null; // Найкращий знайдений торрент

                        // Аналізуємо кожен торрент
                        for (var i = 0; i < torrents.length; i++) {
                            var currentTorrent = torrents[i];
                            
                            // === ДОДАНО: Пропускаємо трейлери, тизери та промо-матеріали ===
                            var tTitleLower = currentTorrent.title.toLowerCase();
                            
                            // 1. Беремо офіційні назви, щоб випадково не зреагувати на них
                            var origTitle = (normalizedCard.original_title || '').toLowerCase();
                            var locTitle = (normalizedCard.title || '').toLowerCase();
                            
                            // 2. Тимчасово "вирізаємо" ці назви з назви торренту для безпечної перевірки
                            var stringToCheck = tTitleLower;
                            if (origTitle) stringToCheck = stringToCheck.replace(origTitle, '');
                            if (locTitle) stringToCheck = stringToCheck.replace(locTitle, '');

                            // 3. Шукаємо слова-маркери як окремі слова (з пробілами або в дужках)
                            if (/(^|[\s\[\(\-_])(trailer|трейлер|teaser|тизер|promo|промо)([\s\]\)\-_]|$)/.test(stringToCheck)) {
                                if (LQE_CONFIG.LOGGING_QUALITY) {
                                    console.log(
                                        "LQE-QUALITY", 
                                        "card: " + cardId + ", Пропускаємо трейлер/тизер:", currentTorrent.title
                                    );
                                }
                                continue;
                            }
                            // === КІНЕЦЬ ДОДАНОГО БЛОКУ ===

                            // Якщо картка - це серіал (tv)
                            if (normalizedCard.type === 'tv') {
                                var tTitle = currentTorrent.title.toLowerCase(); // назву приводимо до нижнього регістру
                                // Перевірка: у назві має бути "сезон", "season", "s01", "s1", "серии" тощо
                                if (!/(сезон|season|s\d{1,2}|\d{1,2}\s*из\s*\d{1,2}|серии)/.test(tTitle)) {
                                    if (LQE_CONFIG.LOGGING_QUALITY) {
                                        console.log(
                                            "LQE-QUALITY",
                                            "card: " + cardId + ", Пропускаємо торрент без ознаки сезону:", currentTorrent.title
                                        );
                                    }
                                    continue; // пропускаємо реліз, якщо це серіал, але немає сезону в назві
                                }
                            }

                            // Якщо картка - це фільм (movie)
                            if (normalizedCard.type === 'movie') {
                                var tTitleMovie = currentTorrent.title.toLowerCase();
                                // Якщо в назві є ознаки серіалу – пропускаємо (щоб не брати якість від серіалів)
                                if (/(сезон|season|s\d{1,2}|\d{1,2}\s*из\s*\d{1,2}|серии)/.test(tTitleMovie)) {
                                    if (LQE_CONFIG.LOGGING_QUALITY) {
                                        console.log(
                                            "LQE-QUALITY",
                                            "card: " + cardId + ", Пропускаємо реліз із ознаками серіалу для фільму:",
                                            currentTorrent.title
                                        );
                                    }
                                    continue; // пропускаємо цей торрент
                                }
                            }

                            // Визначаємо якість (спочатку з поля, потім з назви)
                            var currentNumericQuality = currentTorrent.quality;

                            // завжди пробуємо витягнути з назви
                            var extractedQuality = extractNumericQualityFromTitle(currentTorrent.title);

                            // якщо з назви витягнули TS/TC/CAM — воно має пріоритет навіть над API quality
                            if (extractedQuality > 0 && extractedQuality <= 3) {
                                currentNumericQuality = extractedQuality;
                            } else {
                                // інакше — якщо API quality нема/0, тоді беремо з назви
                                if (typeof currentNumericQuality !== 'number' || currentNumericQuality === 0) {
                                    if (extractedQuality > 0) currentNumericQuality = extractedQuality;
                                    else continue; // якщо нічого не визначили — пропускаємо
                                }
                            }

                            
                            /*var currentNumericQuality = currentTorrent.quality;
                            if (typeof currentNumericQuality !== 'number' || currentNumericQuality === 0) {
                                var extractedQuality = extractNumericQualityFromTitle(currentTorrent.title);
                                if (extractedQuality > 0) {
                                    currentNumericQuality = extractedQuality;
                                } else {
                                    continue; // Пропускаємо якщо якість не визначена
                                }
                            }*/

                            // === ЗМІНА 2: Покращена валідація року ===
                            var torrentYearRaw = currentTorrent.relased || currentTorrent.released;
                            var parsedYear = 0;
                            if (torrentYearRaw && !isNaN(torrentYearRaw)) {
                                parsedYear = parseInt(torrentYearRaw, 10);
                            }
                            // Якщо рік не знайдено в полі 'relased', спробуємо витягнути з назви
                            if (parsedYear < 1900) {
                                parsedYear = extractYearFromTitle(currentTorrent.title);
                            }

                            // ✅✅✅ Дозволяємо різницю в 1 рік (наприклад, реліз в грудні, а торрент з'явився в січні)
                            var yearDifference = Math.abs(parsedYear - searchYearNum);
                            if (parsedYear > 1900 && yearDifference > 1) {
                                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Torrent year mismatch, skipping. Torrent: " + currentTorrent.title + ", Searched: " + searchYearNum + ", Found: " + parsedYear);
                                continue;
                            }
                            // === КІНЕЦЬ ЗМІНИ 2 ===

                            if (LQE_CONFIG.LOGGING_QUALITY) {
                                console.log(
                                    "LQE-QUALITY",
                                    "card: " + cardId +
                                    ", Torrent: " + currentTorrent.title +
                                    " | Quality: " + currentNumericQuality + "p" +
                                    " | Year: " + (parsedYear || "unknown") +
                                    " | Strategy: " + strategyName
                                );
                            }

                            // ✅ ЛОГІКА ВИБОРУ ТОРРЕНТУ
                            if (currentNumericQuality > bestNumericQuality) {
                                // Знайшли торрент з кращою якістю
                                bestNumericQuality = currentNumericQuality;
                                bestFoundTorrent = currentTorrent;
                            }
                            else if (currentNumericQuality === bestNumericQuality && bestFoundTorrent &&
                                currentTorrent.title.length > bestFoundTorrent.title.length) {
                                // Якість рівна - беремо торрент з довшою назвою (більше деталей)
                                bestFoundTorrent = currentTorrent;
                            }
                        }

                        if (bestFoundTorrent) {
                            var result = {
                                quality: bestFoundTorrent.quality || bestNumericQuality,
                                full_label: bestFoundTorrent.title
                            };
                            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Best torrent found:", result, "Quality:", bestNumericQuality);
                            apiCallback(result);
                        } else {
                            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", No suitable torrent found");
                            apiCallback(null);
                        }

                    } catch (e) {
                        console.error("LQE-LOG", "card: " + cardId + ", JacRed API parse error:", e);
                        apiCallback(null);
                    }
                });
            }

            // ✅ СТРАТЕГІЇ ПОШУКУ
            var searchStrategies = [];
            // Стратегія 1: Оригінальна назва + точний рік
            if (normalizedCard.original_title && (/[a-zа-яё]/i.test(normalizedCard.original_title) || /^\d+$/.test(normalizedCard.original_title))) {
                searchStrategies.push({
                    title: normalizedCard.original_title.trim(),
                    year: year,
                    exact: true,
                    name: "OriginalTitle Exact Year"
                });
            }

            // Стратегія 2: Локалізована назва + точний рік (вимкнено)  
            /*if (normalizedCard.title && (/[a-zа-яё]/i.test(normalizedCard.title) || /^\d+$/.test(normalizedCard.title))) {
                searchStrategies.push({
                    title: normalizedCard.title.trim(),
                    year: year,
                    exact: true,
                    name: "Title Exact Year"
                });
            }
            */

// ✅ fallback якщо original_title пустий
if (searchStrategies.length === 0 && normalizedCard.title) {
    searchStrategies.push({
        title: normalizedCard.title.trim(),
        year: year,
        exact: true,
        name: "Fallback Title Exact Year"
    });
}
            
            // Рекурсивна функція виконання стратегій
            function executeNextStrategy(index) {
                if (index >= searchStrategies.length) {
                    if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", All strategies failed. No quality found.");
                    callback(null);
                    done();
                    return;
                }

                var s = searchStrategies[index];
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Trying strategy", index + 1, ":", s.name);
                searchJacredApi(s.title, s.year, s.exact, s.name, function (result) {
                    if (result !== null) {
                        callback(result);
                        done();
                    } else {
                        executeNextStrategy(index + 1); // Наступна стратегія
                    }
                });
            }

            if (searchStrategies.length > 0) {
                executeNextStrategy(0);
            } else {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", No valid search titles or strategies defined.");
                callback(null);
                done();
            }
        });
    }

    // ===================== КЕШУВАННЯ =====================
    // In-memory кеш для швидкого доступу та мінімізації звернень до Storage.
    var memoryCache = {};
    var storageCache = null;

    function getStorageCache() {
        if (!storageCache) storageCache = Lampa.Storage.get(LQE_CONFIG.CACHE_KEY) || {};
        return storageCache;
    }

    // Захист від дубльованих мережевих запитів по одному ключу.
    var inflightRequests = {};

    /**
     * Отримує дані з кешу
     * @param {string} key - Ключ кешу
     * @returns {object|null} - Дані кешу або null
     */
    function getQualityCache(key) {
        var memoryItem = memoryCache[key];
        if (memoryItem && (Date.now() - memoryItem.timestamp < LQE_CONFIG.CACHE_VALID_TIME_MS)) {
            return memoryItem;
        }

        var cache = getStorageCache(); // Отримуємо кеш або пустий об'єкт
        var item = cache[key]; // Отримуємо елемент по ключу
        var isCacheValid = item && (Date.now() - item.timestamp < LQE_CONFIG.CACHE_VALID_TIME_MS); // Перевіряємо валідність

        if (LQE_CONFIG.LOGGING_QUALITY) {
            console.log("LQE-QUALITY", "Cache: Checking quality cache for key:", key, "Found:", !!item, "Valid:", isCacheValid);
        }

        if (isCacheValid) memoryCache[key] = item;
        return isCacheValid ? item : null; // Повертаємо елемент або null
    }

    /**
     * Зберігає дані в кеш
     * @param {string} key - Ключ кешу
     * @param {object} data - Дані для зберігання
     * @param {string} cardId - ID картки для логування
     */
    function saveQualityCache(key, data, cardId) {
        if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Cache: Saving quality cache for key:", key, "Data:", data);
        var cache = getStorageCache();
        var payload = {
            quality_code: data.quality_code,
            full_label: data.full_label,
            timestamp: Date.now() // Поточний час
        };
        cache[key] = payload;
        memoryCache[key] = payload;
        Lampa.Storage.set(LQE_CONFIG.CACHE_KEY, cache); // Зберігаємо в LocalStorage
    }

    /**
     * Видаляє застарілі записи кешу
     */
    function removeExpiredCacheEntries() {
        var cache = getStorageCache();
        var changed = false;
        var now = Date.now();

        for (var k in cache) {
            if (!cache.hasOwnProperty(k)) continue;
            var item = cache[k];
            if (!item || !item.timestamp || (now - item.timestamp) > LQE_CONFIG.CACHE_VALID_TIME_MS) {
                delete cache[k]; // Видаляємо застарілий запис
                changed = true;
            }
        }

        if (changed) {
            Lampa.Storage.set(LQE_CONFIG.CACHE_KEY, cache);
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "Cache: Removed expired entries");
        }
    }

    /**
     * Повне очищення кешу (для налаштувань)
     */
    function clearQualityCache() {
        storageCache = {};
        memoryCache = {};
        Lampa.Storage.set(LQE_CONFIG.CACHE_KEY, storageCache);
    }

    // Очищаємо застарілий кеш при ініціалізації
    removeExpiredCacheEntries();
    // ===================== UI ДОПОМІЖНІ ФУНКЦІЇ =====================
    /**
     * Очищає елементи якості на повній картці
     * @param {string} cardId - ID картки
     * @param {Element} renderElement - DOM елемент
     */
    function clearFullCardQualityElements(cardId, renderElement) {
        if (renderElement) {
            var existingElements = $('.full-start__status.lqe-quality', renderElement);
            if (existingElements.length > 0) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Clearing existing quality elements on full card.");
                existingElements.remove(); // Видаляємо існуючі елементи
            }
        }
    }

    /**
     * Оновлює елемент якості на повній картці
     * @param {number} qualityCode - Код якості
     * @param {string} fullTorrentTitle - Назва торренту
     * @param {string} cardId - ID картки
     * @param {Element} renderElement - DOM елемент
     * @param {boolean} bypassTranslation - Пропустити переклад
     */
    function updateFullCardQualityElement(qualityCode, fullTorrentTitle, cardId, renderElement, bypassTranslation) {
        if (!renderElement) return;
        var element = $('.full-start__status.lqe-quality', renderElement);
        var rateLine = $('.full-start-new__rate-line, .full-start__rate-line', renderElement).first();
        if (!rateLine.length) return;
        //var rateLine = $('.full-start-new__rate-line', renderElement);
        //if (!rateLine.length) return;

        var displayQuality = bypassTranslation ? fullTorrentTitle : translateQualityLabel(qualityCode, fullTorrentTitle);

        // ✅ Якщо це ручне перевизначення і увімкнено спрощення - беремо спрощену мітку
        if (bypassTranslation && LQE_CONFIG.USE_SIMPLE_QUALITY_LABELS) {
            var manualData = LQE_CONFIG.MANUAL_OVERRIDES[cardId];
            if (manualData && manualData.simple_label) {
                displayQuality = manualData.simple_label;
            }
        }

        if (element.length) {
            // Оновлюємо існуючий елемент
            if (LQE_CONFIG.LOGGING_QUALITY) console.log('LQE-QUALITY', 'card: ' + cardId + ', Updating existing element with quality "' + displayQuality + '" on full card.');
            element.text(displayQuality).css('opacity', '1').addClass('show');
        } else {
            // Створюємо новий елемент
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Creating new element with quality '" + displayQuality + "' on full card.");
            var div = document.createElement('div');
            div.className = 'full-start__status lqe-quality';
            div.textContent = displayQuality;
            rateLine.append(div);
            // Додаємо клас для анімації
            setTimeout(function () {
                $('.full-start__status.lqe-quality', renderElement).addClass('show');
            }, 20);
        }
    }

    function lqeIsDomNode(n) {
        return !!(n && typeof n === 'object' && n.nodeType === 1);
    }


    /**
     * Визначає CSS клас для кольору фону залежно від тексту якості
     */
    function getQualityColorClass(qualityText) {
        // Якщо кольори вимкнені в налаштуваннях - завжди повертаємо базовий зелений
        if (!LQE_CONFIG.USE_COLORED_LABELS) return 'lqe-bg-premium'; 
        
        var lower = (qualityText || '').toLowerCase();
        
        // 1. Погані якості (М'який червоний)
        if (/(ts|tc|camrip|cam|scr|telesync|telecine)/.test(lower)) {
            return 'lqe-bg-poor';
        }
        
        // 2. Топ якості (Зелений - залишаємо як є)
        if (/(4k|2160|qhd|1440|2k)/.test(lower)) {
            return 'lqe-bg-premium';
        }
        
        // 3. Всі інші: FHD, HD, SD, WEB-DL тощо (М'який синій)
        return 'lqe-bg-standard';
    }

    
    /**
     * Оновлює елемент якості на списковій картці
     * @param {Element} cardView - DOM елемент картки
     * @param {number} qualityCode - Код якості
     * @param {string} fullTorrentTitle - Назва торренту
     * @param {boolean} bypassTranslation - Пропустити переклад
     */
function updateCardListQualityElement(cardView, qualityCode, fullTorrentTitle, bypassTranslation) {
        var displayQuality = bypassTranslation ? fullTorrentTitle : translateQualityLabel(qualityCode, fullTorrentTitle);

        // Старі WebView не мають optional chaining, тому робимо руками
        if (bypassTranslation && LQE_CONFIG.USE_SIMPLE_QUALITY_LABELS) {
            var detectedCardId = null;

            // cardView.card_data.id ?
            if (cardView && cardView.card_data && cardView.card_data.id) {
                detectedCardId = cardView.card_data.id;
            } else {
                // або cardView.closest('.card').card_data.id ?
                var closestCard = (cardView && cardView.closest) ? cardView.closest('.card') : null;
                if (closestCard && closestCard.card_data && closestCard.card_data.id) {
                    detectedCardId = closestCard.card_data.id;
                }
            }

            if (detectedCardId && LQE_CONFIG.MANUAL_OVERRIDES[detectedCardId]) {
                var manualData = LQE_CONFIG.MANUAL_OVERRIDES[detectedCardId];
                if (manualData && manualData.simple_label) {
                    displayQuality = manualData.simple_label;
                }
            }
        }

        // ✅ ДОДАНО: Отримуємо клас кольору на основі тексту мітки
        var colorClass = getQualityColorClass(displayQuality);

        // прибираємо старий .card__quality, якщо він уже є
        var existing = cardView.querySelector('.card__quality');
        if (existing) {
            var inner = existing.querySelector('div');
            // ✅ ЗМІНЕНО: тепер перевіряємо, чи збігається текст І чи правильний колір стоїть
            if (inner && inner.textContent === displayQuality && existing.classList.contains(colorClass)) {
                return; // вже оновлено і колір правильний, нічого не робимо
            } else {
                existing.remove();
            }
        }

        // якщо елемента немає або ми його щойно зняли — ставимо свіжий
        if (!cardView.querySelector('.card__quality')) {
            var qualityDiv = document.createElement('div');
            // ✅ ЗМІНЕНО: Додаємо наш клас кольору до базового класу
            qualityDiv.className = 'card__quality ' + colorClass;

            var innerElement = document.createElement('div');
            innerElement.textContent = displayQuality;
            qualityDiv.appendChild(innerElement);

            cardView.appendChild(qualityDiv);

            // плавне з'явлення, з поліфілом requestAnimationFrame це працюватиме навіть у старому WebView
            requestAnimationFrame(function () {
                qualityDiv.classList.add('show');
            });
        }
    }

    // ===================== ОБРОБКА ПОВНОЇ КАРТКИ =====================
    /**
     * Обробляє якість для повної картки
     * @param {object} cardData - Дані картки
     * @param {Element} renderElement - DOM елемент
     */
    function processFullCardQuality(cardData, renderElement) {
        // Захист від некоректного виклику
        if (!renderElement) {
            console.error("LQE-LOG", "Render element is null in processFullCardQuality. Aborting.");
            return;
        }

        var cardId = cardData && cardData.id;

        if (LQE_CONFIG.LOGGING_GENERAL) {
            console.log("LQE-LOG", "card: " + cardId + ", Processing full card. Data: ", cardData);
        }

        // Нормалізуємо дані картки (єдине джерело правди для пошуку/кешу)
        var normalizedCard = {
            id: cardData.id,
            title: cardData.title || cardData.name || '',
            original_title: cardData.original_title || cardData.original_name || '',
            type: getCardType(cardData),
            release_date: cardData.release_date || cardData.first_air_date || ''
        };

        if (LQE_CONFIG.LOGGING_GENERAL) {
            console.log("LQE-LOG", "card: " + cardId + ", Normalized full card data: ", normalizedCard);
        }

        // Рядок із рейтингами та статусами (НЕ ховаємо його ніколи)

        var rateLine = $('.full-start-new__rate-line', renderElement);
        if (rateLine.length) {
            rateLine.addClass('done');
        } else {
            if (LQE_CONFIG.LOGGING_GENERAL) {
                console.log("LQE-LOG", "card: " + cardId + ", .full-start-new__rate-line not found, skipping loading animation.");
            }
        }

        // Якщо вимкнено показ мітки якості у повній картці:
        // - прибираємо можливі попередні мітки
        // - знімаємо анімацію завантаження
        // - і виходимо (рядок із IMDb/віком/статусом лишається)
        if (window.LQE_CONFIG && LQE_CONFIG.SHOW_FULL_CARD_LABEL === false) {
            if (LQE_CONFIG.LOGGING_GENERAL) {
                console.log("LQE-LOG", "Full-card quality label disabled by setting");
            }
            clearFullCardQualityElements(cardId, renderElement);
            removeLoadingAnimation(cardId, renderElement);
            return;
        }

        // Тип контенту та ключ кешу
        var isTvSeries = (normalizedCard.type === 'tv' || normalizedCard.name);
        var cacheKey = makeCacheKey(LQE_CONFIG.CACHE_VERSION, normalizedCard.type, normalizedCard.id);

        // Ручне перевизначення має найвищий пріоритет
        var manualOverrideData = LQE_CONFIG.MANUAL_OVERRIDES[cardId];
        if (manualOverrideData) {
            if (LQE_CONFIG.LOGGING_QUALITY) {
                console.log("LQE-QUALITY", "card: " + cardId + ", Found manual override:", manualOverrideData);
            }
            // bypassTranslation=true — показати саме наш напис (із можливим спрощенням через apply())
            updateFullCardQualityElement(null, manualOverrideData.full_label, cardId, renderElement, true);
            removeLoadingAnimation(cardId, renderElement);
            return;
        }

        // Якщо вимкнено мітки для серіалів — прибираємо лише нашу мітку/анімацію і виходимо
        if (isTvSeries && LQE_CONFIG.SHOW_QUALITY_FOR_TV_SERIES === false) {
            if (LQE_CONFIG.LOGGING_QUALITY) {
                console.log('LQE-QUALITY', 'card: ' + cardId + ', Quality feature disabled for TV series (as configured), skipping quality fetch.');
            }
            clearFullCardQualityElements(cardId, renderElement);
            removeLoadingAnimation(cardId, renderElement);
            return;
        }

        // Спроба взяти дані з кешу
        var cachedQualityData = getQualityCache(cacheKey);
        if (cachedQualityData) {
            if (LQE_CONFIG.LOGGING_QUALITY) {
                console.log("LQE-QUALITY", "card: " + cardId + ", Quality data found in cache:", cachedQualityData);
            }

            // Миттєво малюємо мітку з кешу
            updateFullCardQualityElement(
                cachedQualityData.quality_code,
                cachedQualityData.full_label,
                cardId,
                renderElement
            );

// Якщо кеш застаріває — тихо оновимо у фоні, без впливу на інші елементи рядка
if (Date.now() - cachedQualityData.timestamp > LQE_CONFIG.CACHE_REFRESH_THRESHOLD_MS) {
    if (LQE_CONFIG.LOGGING_QUALITY) {
        console.log("LQE-QUALITY", "card: " + cardId + ", Cache is old, scheduling background refresh AND UI update.");
    }

    // ✅ inflight-захист і для фонового оновлення full card
    if (inflightRequests[cacheKey]) return;
    inflightRequests[cacheKey] = true;
    // ✅ failsafe: якщо callback не повернеться — не блокуємо ключ назавжди
    var __lqeInflightKill_bg = setTimeout(function () {
        if (inflightRequests[cacheKey]) delete inflightRequests[cacheKey];
    }, LQE_CONFIG.PROXY_TIMEOUT_MS * LQE_CONFIG.PROXY_LIST.length + 3000);


    getBestReleaseFromJacred(normalizedCard, cardId, function (jrResult) {
         clearTimeout(__lqeInflightKill_bg);
        
        if (jrResult && jrResult.quality && jrResult.quality !== 'NO') {
            saveQualityCache(cacheKey, {
                quality_code: jrResult.quality,
                full_label: jrResult.full_label
            }, cardId);

            updateFullCardQualityElement(
                jrResult.quality,
                jrResult.full_label,
                cardId,
                renderElement
            );

            if (LQE_CONFIG.LOGGING_QUALITY) {
                console.log("LQE-QUALITY", "card: " + cardId + ", Background cache and UI refresh completed.");
            }
        }

        // ✅ звільняємо inflight
        delete inflightRequests[cacheKey];
    });
}


            // Анімацію прибираємо (рядок рейтингу завжди видимий)
            removeLoadingAnimation(cardId, renderElement);
            return;
        }

// ✅ inflight-захист для full card (щоб не було дубль-запитів)
// ВАЖЛИВО: перевіряємо ДО будь-яких очисток, щоб не було флікера
if (inflightRequests[cacheKey]) {
    if (LQE_CONFIG.LOGGING_QUALITY) {
        console.log("LQE-QUALITY", "card: " + cardId + ", Full card request already in-flight:", cacheKey);
    }
    // якщо перший запит уже показав лоадер — ок, якщо ні — можемо додати
    addLoadingAnimation(cardId, renderElement);
    return;
}
inflightRequests[cacheKey] = true;
// ✅ failsafe: якщо JacRed завис/впав — прибираємо лоадер і знімаємо inflight
var __lqeInflightKill_full = setTimeout(function () {
    if (inflightRequests[cacheKey]) delete inflightRequests[cacheKey];
    removeLoadingAnimation(cardId, renderElement);
}, LQE_CONFIG.PROXY_TIMEOUT_MS * LQE_CONFIG.PROXY_LIST.length + 3000);


// Кешу нема — робимо свіжий пошук
clearFullCardQualityElements(cardId, renderElement);

// показуємо лоадер рівно на час запиту
addLoadingAnimation(cardId, renderElement);


getBestReleaseFromJacred(normalizedCard, cardId, function (jrResult) {
    clearTimeout(__lqeInflightKill_full);
    var qualityCode = (jrResult && jrResult.quality) || null;
    var fullTorrentTitle = (jrResult && jrResult.full_label) || null;

    if (qualityCode && qualityCode !== 'NO') {
        saveQualityCache(cacheKey, { quality_code: qualityCode, full_label: fullTorrentTitle }, cardId);
        updateFullCardQualityElement(qualityCode, fullTorrentTitle, cardId, renderElement);
    } else {
        clearFullCardQualityElements(cardId, renderElement);
    }

    removeLoadingAnimation(cardId, renderElement);

    // ✅ звільняємо inflight
    delete inflightRequests[cacheKey];
});


        if (LQE_CONFIG.LOGGING_GENERAL) {
            console.log("LQE-LOG", "card: " + cardId + ", Full card quality processing initiated.");
        }
    }

    // ===================== ОБРОБКА СПИСКОВИХ КАРТОК =====================
    /**
     * Оновлює якість для спискової картки
     * @param {object|Element} cardInstance - інстанс картки Lampa або DOM елемент
     */
function updateCardListQuality(cardInstance) {
    if (LQE_CONFIG.LOGGING_CARDLIST) console.log("LQE-CARDLIST", "Processing list card");

    var cardRoot = cardInstance && cardInstance.html
        ? (cardInstance.html[0] || cardInstance.html)
        : cardInstance;

    // ✅ головний захист
    if (!lqeIsDomNode(cardRoot)) return;
    if (document.body && !document.body.contains(cardRoot)) return;

    var cardView = cardRoot.querySelector('.card__view');
    var cardData = cardInstance && cardInstance.data ? cardInstance.data : cardRoot.card_data;

    if (!cardData || !cardView) {
        if (LQE_CONFIG.LOGGING_CARDLIST) console.log("LQE-CARDLIST", "Invalid card data or view");
        return;
    }

        var isTvSeries = (getCardType(cardData) === 'tv');
        if (isTvSeries && LQE_CONFIG.SHOW_QUALITY_FOR_TV_SERIES === false) {
            if (LQE_CONFIG.LOGGING_CARDLIST) console.log("LQE-CARDLIST", "Skipping TV series");
            return;
        }

        // Нормалізуємо дані
        var normalizedCard = {
            id: cardData.id || '',
            title: cardData.title || cardData.name || '',
            original_title: cardData.original_title || cardData.original_name || '',
            type: getCardType(cardData),
            release_date: cardData.release_date || cardData.first_air_date || ''
        };

        var cardId = normalizedCard.id;
        if (!cardId) return;
        var cacheKey = makeCacheKey(LQE_CONFIG.CACHE_VERSION, normalizedCard.type, cardId);

        // Перевіряємо ручні перевизначення
        var manualOverrideData = LQE_CONFIG.MANUAL_OVERRIDES[cardId];
        if (manualOverrideData) {
            if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Manual override for list");
            updateCardListQualityElement(cardView, null, manualOverrideData.full_label, true);
            return;
        }

        // Перевіряємо кеш
        var cachedQualityData = getQualityCache(cacheKey);
        if (cachedQualityData) {
            if (LQE_CONFIG.LOGGING_CARDLIST) console.log('LQE-CARDLIST', 'card: ' + cardId + ', Using cached quality');
            updateCardListQualityElement(cardView, cachedQualityData.quality_code, cachedQualityData.full_label);

            // Фонове оновлення застарілого кешу
            if (Date.now() - cachedQualityData.timestamp > LQE_CONFIG.CACHE_REFRESH_THRESHOLD_MS) {
                if (LQE_CONFIG.LOGGING_QUALITY) console.log("LQE-QUALITY", "card: " + cardId + ", Background refresh for list");
                if (inflightRequests[cacheKey]) return;
                inflightRequests[cacheKey] = true;
                    var __lqeInflightKill_list_bg = setTimeout(function () {
                        if (inflightRequests[cacheKey]) delete inflightRequests[cacheKey];
                    }, LQE_CONFIG.PROXY_TIMEOUT_MS * LQE_CONFIG.PROXY_LIST.length + 3000);

                getBestReleaseFromJacred(normalizedCard, cardId, function (jrResult) {
                    clearTimeout(__lqeInflightKill_list_bg);
                    if (jrResult && jrResult.quality && jrResult.quality !== 'NO') {
                        saveQualityCache(cacheKey, {
                            quality_code: jrResult.quality,
                            full_label: jrResult.full_label
                        }, cardId);
                        if (lqeIsDomNode(cardRoot) && document.body.contains(cardRoot)) {
                        //if (document.body.contains(cardRoot)) {
                            updateCardListQualityElement(cardView, jrResult.quality, jrResult.full_label);
                        }
                    }
                    delete inflightRequests[cacheKey];
                });
            }
            return;
        }

        // Завантажуємо нові дані
        if (inflightRequests[cacheKey]) return;
        inflightRequests[cacheKey] = true;
            var __lqeInflightKill_list = setTimeout(function () {
                if (inflightRequests[cacheKey]) delete inflightRequests[cacheKey];
            }, LQE_CONFIG.PROXY_TIMEOUT_MS * LQE_CONFIG.PROXY_LIST.length + 3000);

        getBestReleaseFromJacred(normalizedCard, cardId, function (jrResult) {
            clearTimeout(__lqeInflightKill_list);

            if (LQE_CONFIG.LOGGING_CARDLIST) console.log('LQE-CARDLIST', 'card: ' + cardId + ', JacRed result for list');

            if (!lqeIsDomNode(cardRoot) || !document.body.contains(cardRoot)) {
            //if (!document.body.contains(cardRoot)) {
                if (LQE_CONFIG.LOGGING_CARDLIST) console.log('LQE-CARDLIST', 'Card removed from DOM');
                delete inflightRequests[cacheKey];
                return;
            }

            var qualityCode = (jrResult && jrResult.quality) || null;
            var fullTorrentTitle = (jrResult && jrResult.full_label) || null;

            if (qualityCode && qualityCode !== 'NO') {
                if (LQE_CONFIG.LOGGING_CARDLIST) console.log('LQE-CARDLIST', 'card: ' + cardId + ', Quality found for list');
                saveQualityCache(cacheKey, {
                    quality_code: qualityCode,
                    full_label: fullTorrentTitle
                }, cardId);
                updateCardListQualityElement(cardView, qualityCode, fullTorrentTitle);
            } else {
                if (LQE_CONFIG.LOGGING_CARDLIST) console.log('LQE-CARDLIST', 'card: ' + cardId + ', No quality for list');
            }

            delete inflightRequests[cacheKey];
        });
    }

    // ===================== LIST CARD HOOK (onVisible) ===================
    // ======================= ІНІЦІАЛІЗАЦІЯ ПЛАГІНА ======================
    /**
     * Ініціалізує плагін якості
     */
    function initializeLampaQualityPlugin() {
        if (LQE_CONFIG.LOGGING_GENERAL) console.log("LQE-LOG", "Lampa Quality Enhancer: Initializing...");
        window.lampaQualityPlugin = true; // Позначаємо плагін як ініціалізований
        var card = Lampa.Maker.map('Card');
        if (!card || !card.Card) {
            if (LQE_CONFIG.LOGGING_GENERAL) console.log('LQE-LOG: Card module недоступний, плагін не ініціалізовано');
            return;
        }

        // Підписуємось на lifecycle картки, щоб працювати лише з видимими елементами.
        if (!card.Card.__lqe_onVisible_patched) {
            card.Card.__lqe_onVisible_patched = true;
            var originalOnVisible = card.Card.onVisible;
                card.Card.onVisible = function () {
                if (typeof originalOnVisible === 'function') originalOnVisible.apply(this, arguments);
                updateCardListQuality(this);
                };
        }

        /*var originalOnVisible = card.Card.onVisible;
        card.Card.onVisible = function () {
            var self = this;
            if (typeof originalOnVisible === 'function') originalOnVisible.apply(self, arguments);
            updateCardListQuality(self);
        };*/
        // Підписуємося на події повної картки
        Lampa.Listener.follow('full', function (event) {
            if (event.type == 'complite') {
                var renderElement = event.object.activity.render();
                currentGlobalMovieId = event.data.movie.id;


                if (LQE_CONFIG.LOGGING_GENERAL) {
                    console.log("LQE-LOG", "Full card completed for ID:", currentGlobalMovieId);
                }

                processFullCardQuality(event.data.movie, renderElement);
            }
        });
        if (LQE_CONFIG.LOGGING_GENERAL) console.log("LQE-LOG", "Lampa Quality Enhancer: Initialized successfully!");
    }

    // Ініціалізуємо плагін якщо ще не ініціалізовано
    if (!window.lampaQualityPlugin) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initializeLampaQualityPlugin); // Чекаємо завантаження DOM
        } else {
            initializeLampaQualityPlugin(); // Ініціалізуємо негайно
        }
    }

    /* LQE: Settings (Interface -> "Мітки якості") */
    (function () {
        'use strict';

        var SETTINGS_KEY = 'lqe_user_settings_v1';
        var st;
        // Простий тост з fallback, якщо Lampa.Noty недоступний
        function lqeToast(msg) {
            try {
                if (Lampa && typeof Lampa.Noty === 'function') { Lampa.Noty(msg); return; }
                if (Lampa && Lampa.Noty && Lampa.Noty.show) { Lampa.Noty.show(msg); return; }
            } catch (e) { }
            var id = 'lqe_toast';
            var el = document.getElementById(id);
            if (!el) {
                el = document.createElement('div');
                el.id = id;
                el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:2rem;padding:.6rem 1rem;background:rgba(0,0,0,.85);color:#fff;border-radius:.5rem;z-index:9999;font-size:14px;transition:opacity .2s;opacity:0';
                document.body.appendChild(el);
            }
            el.textContent = msg;
            el.style.opacity = '1';
            setTimeout(function () { el.style.opacity = '0'; }, 1300);
        }

        function load() {
            var s = (Lampa.Storage.get(SETTINGS_KEY) || {});
            return {
                show_tv: (typeof s.show_tv === 'boolean') ? s.show_tv : !!LQE_CONFIG.SHOW_QUALITY_FOR_TV_SERIES,
                show_full_card: (typeof s.show_full_card === 'boolean') ? s.show_full_card : !!LQE_CONFIG.SHOW_FULL_CARD_LABEL,
                label_style: s.label_style || 'short',
                colored_labels: (typeof s.colored_labels === 'boolean') ? s.colored_labels : !!LQE_CONFIG.USE_COLORED_LABELS // ✅ ДОДАНО: Читаємо налаштування кольорів
            };
        }

        function apply() {
            LQE_CONFIG.SHOW_QUALITY_FOR_TV_SERIES = !!st.show_tv;
            if (typeof LQE_CONFIG.SHOW_FULL_CARD_LABEL !== 'boolean') LQE_CONFIG.SHOW_FULL_CARD_LABEL = true;
            LQE_CONFIG.SHOW_FULL_CARD_LABEL = !!st.show_full_card;
            // Відображення саме повної мітки (не всього рядка)
            if (document && document.body) {
                document.body.classList.toggle('lqe-hide-full', !LQE_CONFIG.SHOW_FULL_CARD_LABEL);
            }

            LQE_CONFIG.USE_SIMPLE_QUALITY_LABELS = (st.label_style === 'short');
            LQE_CONFIG.USE_COLORED_LABELS = !!st.colored_labels; // ✅ ДОДАНО: Застосовуємо налаштування кольорів
        }

        function save() {
            Lampa.Storage.set(SETTINGS_KEY, st);
            apply();
            lqeToast('Збережено');
        }

        
        
        // Кнопка "Очистити кеш"
        function lqeClearCache() {
            try {
                if (typeof clearQualityCache === 'function') clearQualityCache();
                else {
                    var key = (window.LQE_CONFIG && LQE_CONFIG.CACHE_KEY) ? LQE_CONFIG.CACHE_KEY : 'lampa_quality_cache';
                    Lampa.Storage.set(key, {}); // повне очищення кеш-об’єкта
                }
                lqeToast('Кеш очищено');
            } catch (e) {
                console.error('LQE clear cache error:', e);
            }
        }

        function registerUI() {
            // 1) Кнопка в «Інтерфейс», що відкриває нашу сторінку
            Lampa.Template.add('settings_lqe', '<div></div>');
            Lampa.SettingsApi.addParam({
                component: 'interface',
                param: { type: 'button', component: 'lqe' },
                field: {
                    name: 'Мітки якості',
                    description: 'Керування відображенням міток якості'
                },
                onChange: function () {
                    Lampa.Settings.create('lqe', {
                        template: 'settings_lqe',
                        onBack: function () { Lampa.Settings.create('interface'); }
                    });
                }
            });

            // 2) Перемикач (через select): мітки для серіалів
            Lampa.SettingsApi.addParam({
                component: 'lqe',
                param: {
                    name: 'lqe_show_tv',
                    type: 'select',
                    values: { 'true': 'Увімкнено', 'false': 'Вимкнено' },
                    default: String(st.show_tv)
                },
                field: { name: 'Відображати мітки якості для серіалів' },
                onChange: function (v) { st.show_tv = (String(v) === 'true'); save(); }
            });

            // 3) Перемикач (через select): мітка у повній картці
            Lampa.SettingsApi.addParam({
                component: 'lqe',
                param: {
                    name: 'lqe_show_full_card',
                    type: 'select',
                    values: { 'true': 'Увімкнено', 'false': 'Вимкнено' },
                    default: String(st.show_full_card)
                },
                field: { name: 'Відображати мітку якості у повній картці' },
                onChange: function (v) { st.show_full_card = (String(v) === 'true'); save(); }
            });

            // 4) Селектор стилю мітки
            Lampa.SettingsApi.addParam({
                component: 'lqe',
                param: {
                    name: 'lqe_label_style',
                    type: 'select',
                    values: {
                        short: 'Скорочене відображення (4K, FHD)',
                        full: 'Повне відображення (4K WEB-DL, 1080P BRRIP)'
                    },
                    default: st.label_style
                },
                field: { name: 'Стиль мітки якості' },
                onChange: function (v) { st.label_style = v; save(); }
            });


            // ✅ 5) ДОДАНО: Перемикач кольорових міток
            Lampa.SettingsApi.addParam({
                component: 'lqe',
                param: {
                    name: 'lqe_colored_labels',
                    type: 'select',
                    values: { 'true': 'Увімкнено', 'false': 'Вимкнено' },
                    default: String(st.colored_labels)
                },
                field: { 
                    name: 'Кольорові мітки якості', 
                    description: 'Різні кольори для 4K, FHD/HD та екранок TS/Cam' 
                },
                onChange: function (v) { st.colored_labels = (String(v) === 'true'); save(); }
            });

            // 6) Кнопка "Очистити кеш" (була 5-ю)
            Lampa.SettingsApi.addParam({
                component: 'lqe',
                param: { type: 'button', component: 'lqe_clear_cache' },
                field: { name: 'Очистити кеш' },
                onChange: function () { lqeClearCache(); }
            });
            
        }

        function start() {
            st = load();
            apply();

            if (Lampa && Lampa.SettingsApi && typeof Lampa.SettingsApi.addParam === 'function') {
                // !!! ЗАСТОСУВАТИ ЗМІНУ ТУТ: обгортаємо виклик у setTimeout(..., 0)
                setTimeout(registerUI, 0);
            }
        }

        // Реєструємо після готовності застосунку
        if (window.appready) start();
        else if (Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });

        // при застосуванні/збереженні:
        //LQE_CONFIG.SHOW_FULL_CARD_LABEL = !!st.show_full_card;

    })();

})();
