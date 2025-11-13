/**
 * Lampa: Enhanced Ratings (MDBList + OMDb) + Poster Badges
 * --------------------------------------------------------
 * - Працює на старих WebView: локальні шими/поліфіли (localStorage, Promise, fetch, DOM-методи)
 * - Бере рейтинги з MDBList (+ OMDb для віку/нагород) і малює їх у деталці
 * - Додає опційні “стікери” (badges) рейтингів прямо на постери у грідах/детальці
 * - Має секцію налаштувань “Рейтинги”, живе застосування стилів без перезавантаження
 *
 * - $poster → тепер $cardView
 * - Підчистка стилю/порядку коду, вирівняні коментарі, дрібні захисти
 */

(function() {
  'use strict';

  /*
  |==========================================================================
  | localStorage shim
  | (Фолбек, якщо localStorage вимкнено або недоступний)
  |==========================================================================
  */
  (function() {
    var ok = true;
    try {
      var t = '__lmp_test__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
    } catch (e) {
      ok = false;
    }

    if (!ok) {
      var mem = {};
      window.localStorage = {
        getItem: function(k) {
          return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
        },
        setItem: function(k, v) {
          mem[k] = String(v);
        },
        removeItem: function(k) {
          delete mem[k];
        },
        clear: function() {
          mem = {};
        }
      };
    }
  })();

  /*
  |==========================================================================
  | Promise (мінімальний поліфіл)
  | (Достатньо для then/catch/all)
  |==========================================================================
  */
  (function(global) {
    if (global.Promise) return; // Вже є
    var PENDING = 0,
      FULFILLED = 1,
      REJECTED = 2;

    function asap(fn) {
      setTimeout(fn, 0);
    }

    function MiniPromise(executor) {
      if (!(this instanceof MiniPromise)) return new MiniPromise(executor);
      var self = this;
      self._state = PENDING;
      self._value = void 0;
      self._handlers = [];

      function resolve(value) {
        if (self._state !== PENDING) return;
        if (value && (typeof value === 'object' || typeof value === 'function')) {
          var then;
          try {
            then = value.then;
          } catch (e) {
            return reject(e);
          }
          if (typeof then === 'function') return then.call(value, resolve, reject);
        }
        self._state = FULFILLED;
        self._value = value;
        finale();
      }

      function reject(reason) {
        if (self._state !== PENDING) return;
        self._state = REJECTED;
        self._value = reason;
        finale();
      }

      function finale() {
        asap(function() {
          var q = self._handlers;
          self._handlers = [];
          for (var i = 0; i < q.length; i++) handle(q[i]);
        });
      }

      function handle(h) {
        if (self._state === PENDING) {
          self._handlers.push(h);
          return;
        }
        var cb = self._state === FULFILLED ? h.onFulfilled : h.onRejected;
        if (!cb) {
          (self._state === FULFILLED ? h.resolve : h.reject)(self._value);
          return;
        }
        try {
          var ret = cb(self._value);
          h.resolve(ret);
        } catch (e) {
          h.reject(e);
        }
      }
      this.then = function(onFulfilled, onRejected) {
        return new MiniPromise(function(resolve, reject) {
          handle({
            onFulfilled: onFulfilled,
            onRejected: onRejected,
            resolve: resolve,
            reject: reject
          });
        });
      };
      this.catch = function(onRejected) {
        return this.then(null, onRejected);
      };
      try {
        executor(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }
    MiniPromise.resolve = function(v) {
      return new MiniPromise(function(res) {
        res(v);
      });
    };
    MiniPromise.reject = function(r) {
      return new MiniPromise(function(_, rej) {
        rej(r);
      });
    };
    MiniPromise.all = function(arr) {
      return new MiniPromise(function(resolve, reject) {
        if (!arr || !arr.length) return resolve([]);
        var out = new Array(arr.length),
          left = arr.length;
        for (var i = 0; i < arr.length; i++)(function(i) {
          MiniPromise.resolve(arr[i]).then(function(v) {
            out[i] = v;
            if (--left === 0) resolve(out);
          }, reject);
        })(i);
      });
    };
    global.Promise = MiniPromise;
  })(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

  /*
  |==========================================================================
  | fetch polyfill
  | (З урахуванням Lampa.Reguest для обходу CORS)
  |==========================================================================
  */
  (function(global) {
    if (global.fetch) return; // Вже є

    function Response(body, init) {
      this.status = init && init.status || 200;
      this.ok = this.status >= 200 && this.status < 300;
      this._body = body == null ? '' : String(body);
      this.headers = (init && init.headers) || {};
    }
    Response.prototype.text = function() {
      var self = this;
      return Promise.resolve(self._body);
    };
    Response.prototype.json = function() {
      var self = this;
      return Promise.resolve().then(function() {
        return JSON.parse(self._body || 'null');
      });
    };

    global.fetch = function(input, init) {
      init = init || {};
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = (init.method || 'GET').toUpperCase();
      var headers = init.headers || {};
      var body = init.body || null;

      // Якщо є Lampa.Reguest — використовуємо його (обхід CORS)
      if (global.Lampa && Lampa.Reguest) {
        return new Promise(function(resolve) {
          new Lampa.Reguest().native(
            url,
            function(data) {
              var text = (typeof data === 'string') ? data : (data != null ? JSON.stringify(data) : '');
              resolve(new Response(text, {
                status: 200,
                headers: headers
              }));
            },
            function() {
              resolve(new Response('', {
                status: 500,
                headers: headers
              }));
            },
            false, {
              dataType: 'text',
              method: method,
              headers: headers,
              data: body
            }
          );
        });
      }

      // Звичайний XMLHttpRequest-фолбек
      return new Promise(function(resolve, reject) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open(method, url, true);
          for (var k in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, k)) xhr.setRequestHeader(k, headers[k]);
          }
          xhr.onload = function() {
            resolve(new Response(xhr.responseText, {
              status: xhr.status,
              headers: headers
            }));
          };
          xhr.onerror = function() {
            reject(new TypeError('Network request failed'));
          };
          xhr.send(body);
        } catch (e) {
          reject(e);
        }
      });
    };
  })(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

})();

(function() {
  'use strict';

  /*
  |==========================================================================
  | 1. ШИМИ / ПОЛІФІЛИ
  | (Для старих Android Webview)
  |==========================================================================
  */

  // NodeList.forEach
  if (window.NodeList && !NodeList.prototype.forEach) {
    NodeList.prototype.forEach = function(callback, thisArg) {
      thisArg = thisArg || window;
      for (var i = 0; i < this.length; i++) {
        callback.call(thisArg, this[i], i, this);
      }
    };
  }

  // Element.matches
  if (!Element.prototype.matches) {
    Element.prototype.matches =
      Element.prototype.msMatchesSelector ||
      Element.prototype.webkitMatchesSelector ||
      function(selector) {
        var node = this;
        var nodes = (node.parentNode || document).querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i] === node) return true;
        }
        return false;
      };
  }

  // Element.closest
  if (!Element.prototype.closest) {
    Element.prototype.closest = function(selector) {
      var el = this;
      while (el && el.nodeType === 1) {
        if (el.matches(selector)) return el;
        el = el.parentElement || el.parentNode;
      }
      return null;
    };
  }

  /*
  |==========================================================================
  | 2. КОНСТАНТИ ТА КОНФІГУРАЦІЯ
  |==========================================================================
  */

  /**
   * Конфігурація API ключів
   * (Значення за замовчуванням, оновлюються з Lampa.Storage)
   */
  var LMP_ENH_CONFIG = {
    apiKeys: {
      mdblist: '', // ✅ ключ до MDBList
      omdb: '' // ✅ ключ до OMDb
    },
    // true  -> іконки стають монохромні через filter: grayscale(100%)
    // false -> кольорові логотипи як є
    monochromeIcons: false /*✅ Вкл./Викл. Ч/Б рейтинги */
  };

  /**
   * Джерела іконок
   */
  // Базовий шлях до іконок у репо
  var BASE_ICON = 'https://raw.githubusercontent.com/ko3ik/LMP/main/wwwroot/';

  var ICONS = {
    // середній рейтинг (TOTAL)
    total_star: BASE_ICON + 'star.png',
    // логотипи сервісів
    imdb: BASE_ICON + 'imdb.png',
    tmdb: BASE_ICON + 'tmdb.png',
    metacritic: BASE_ICON + 'metacritic.png',
    metascore:  BASE_ICON + 'metascore.png',
    // Rotten Tomatoes
    rotten_good: BASE_ICON + 'RottenTomatoes.png',
    rotten_bad: BASE_ICON + 'RottenBad.png',
    // PopcornMeter / Audience
    popcorn: BASE_ICON + 'PopcornGood.png',
    // Нагороди
    awards: BASE_ICON + 'awards.png',
    oscar: BASE_ICON + 'OscarGold.png',
    emmy: BASE_ICON + 'EmmyGold.png'
  };

  /**
   * Локалізація (Переклади)
   */
  Lampa.Lang.add({
    oscars_label: {
      uk: 'Оскар'
    },
    emmy_label: {
      uk: 'Еммі'
    },
    awards_other_label: {
      uk: 'Нагороди'
    },
    popcorn_label: {
      uk: 'Глядачі'
    },
    source_tmdb: {
      ru: 'TMDB',
      en: 'TMDB',
      uk: 'TMDB'
    },
    source_imdb: {
      ru: 'IMDb',
      en: 'IMDb',
      uk: 'IMDb'
    },
    source_mc: {
      ru: 'Metacritic',
      en: 'Metacritic',
      uk: 'Metacritic'
    },
    source_rt: {
      ru: 'Rotten',
      en: 'Rotten',
      uk: 'Rotten'
    }
  });

  /**
   * CSS стилі плагіну
   */
  var pluginStyles = "<style>" +
    /* --- Лоадер "Пошук..." --- */
    ".loading-dots-container {" +
    "    display: flex;" +
    "    align-items: center;" +
    "    font-size: 0.85em;" +
    "    color: #ccc;" +
    "    padding: 0.6em 1em;" +
    "    border-radius: 0.5em;" +
    "}" +
    ".loading-dots__text {" +
    "    margin-right: 1em;" +
    "}" +
    ".loading-dots__dot {" +
    "    width: 0.5em;" +
    "    height: 0.5em;" +
    "    border-radius: 50%;" +
    "    background-color: currentColor;" +
    "    animation: loading-dots-bounce 1.4s infinite ease-in-out both;" +
    "}" +
    ".loading-dots__dot:nth-child(1) {" +
    "    animation-delay: -0.32s;" +
    "}" +
    ".loading-dots__dot:nth-child(2) {" +
    "    animation-delay: -0.16s;" +
    "}" +
    "@keyframes loading-dots-bounce {" +
    "    0%, 80%, 100% { transform: translateY(0); opacity: 0.6; }" +
    "    40% { transform: translateY(-0.5em); opacity: 1; }" +
    "}" +

    /* --- CSS Змінні (розміри іконок) --- */
    ":root{" +
    "  --lmp-h-imdb:24px;" +
    "  --lmp-h-mc:24px;" +
    "  --lmp-h-rt:26px;" +
    "  --lmp-h-popcorn:26px;" +
    "  --lmp-h-tmdb:26px;" +
    "  --lmp-h-awards:20px;" + // іконка 'Awards' у rate--awards
    "  --lmp-h-avg:20px;" + // зірка 'TOTAL/AVG'
    "  --lmp-h-oscar:22px;" + // статуетка Оскара
    "  --lmp-h-emmy:24px;" + // статуетка Еммі
    "}" +

    /* --- Кольоровий режим (за замовчуванням) --- */
    ".rate--oscars, .rate--emmy, .rate--awards, .rate--gold {" +
    "    color: gold;" +
    "}" +

    /* --- Монохромний режим (активується класом 'lmp-enh--mono' на body) --- */
    "body.lmp-enh--mono .rate--oscars," +
    "body.lmp-enh--mono .rate--emmy," +
    "body.lmp-enh--mono .rate--awards," +
    "body.lmp-enh--mono .rate--gold," +
    "body.lmp-enh--mono .rating--green," +
    "body.lmp-enh--mono .rating--blue," +
    "body.lmp-enh--mono .rating--orange," +
    "body.lmp-enh--mono .rating--red," +
    "body.lmp-enh--mono .full-start__rate {" +
    "    color: inherit !important;" +
    "}" +

    /* --- Кольори оцінок (активні лише коли НЕ монохром) --- */
    "body:not(.lmp-enh--mono) .full-start__rate.rating--green  { color: #2ecc71; }" + /* ≥ 8.0  */
    "body:not(.lmp-enh--mono) .full-start__rate.rating--blue   { color: #60a5fa; }" + /* 6.0–7.9 */
    "body:not(.lmp-enh--mono) .full-start__rate.rating--orange { color: #f59e0b; }" + /* 4.0–5.9 */
    "body:not(.lmp-enh--mono) .full-start__rate.rating--red    { color: #ef4444; }" + /* < 4.0   */

    /* --- Ущільнення відступів --- */
    ".full-start-new__rate-line .full-start__rate {" +
    "    margin-right: 0.3em !important;" +
    "}" +
    ".full-start-new__rate-line .full-start__rate:last-child {" +
    "    margin-right: 0 !important;" +
    "}" +

    /* --- Приховування рядка під час завантаження --- */
    ".full-start-new__rate-line.lmp-is-loading-ratings > :not(#lmp-search-loader)," +
    ".full-start__rate-line.lmp-is-loading-ratings > :not(#lmp-search-loader) {" +
    "    opacity: 0 !important;" +
    "    pointer-events: none !important;" +
    "    transition: opacity 0.15s;" +
    "}" +

    /* --- Вирівнювання іконок нагород (Оскар / Еммі) --- */
    ".lmp-award-icon{" +
    "  display:inline-flex;" +
    "  align-items:center;" +
    "  justify-content:center;" +
    "  line-height:1;" +
    "  height:auto;" +
    "  width:auto;" +
    "  flex-shrink:0;" +
    "}" +
    ".lmp-award-icon img{" +
    "  height:auto;" +
    "  width:auto;" +
    "  display:block;" +
    "  object-fit:contain;" +
    "}" +
    ".lmp-award-icon--oscar img{height:var(--lmp-h-oscar);}" +
    ".lmp-award-icon--emmy  img{height:var(--lmp-h-emmy);}" +

    /* --- Базові розміри іконок сервісів --- */
    ".rate--imdb    .source--name img{height:var(--lmp-h-imdb);}" +
    ".rate--mc      .source--name img{height:var(--lmp-h-mc);}" +
    ".rate--rt      .source--name img{height:var(--lmp-h-rt);}" +
    ".rate--popcorn .source--name img{height:var(--lmp-h-popcorn);}" +
    ".rate--tmdb    .source--name img{height:var(--lmp-h-tmdb);}" +
    ".rate--awards  .source--name img{height:var(--lmp-h-awards);}" +
    ".rate--avg     .source--name img{height:var(--lmp-h-avg);}" +

    /* --- Вирівнювання іконок --- */
    ".full-start__rate .source--name{" +
    "  display:inline-flex;" +
    "  align-items:center;" +
    "  justify-content:center;" +
    "}" +

    /* --- Налаштування --- */
    ".settings-param__descr,.settings-param__subtitle{white-space:pre-line;}" +

    /* --- Адаптив (Mobile) --- */
    "@media (max-width: 600px){" +
    "  .full-start-new__rate-line{flex-wrap:wrap;}" +
    "  .full-start__rate{" +
    "    margin-right:.25em !important;" +
    "    margin-bottom:.25em;" +
    "    font-size:16px;" +
    "    min-width:unset;" +
    "  }" +
    "  :root{" +
    "    --lmp-h-imdb:14px; --lmp-h-mc:14px; --lmp-h-rt:16px;" +
    "    --lmp-h-popcorn:16px; --lmp-h-tmdb:16px; --lmp-h-awards:14px;" +
    "    --lmp-h-avg:14px; --lmp-h-oscar:14px; --lmp-h-emmy:16px;" +
    "  }" +
    "  .loading-dots-container{font-size:.8em; padding:.4em .8em;}" +
    "  .lmp-award-icon{height:16px;}" +
    "}" +

    /* --- Адаптив (Small Mobile) --- */
    "@media (max-width: 360px){" +
    "  .full-start__rate{font-size:14px;}" +
    "  :root{" +
    "    --lmp-h-imdb:12px; --lmp-h-mc:12px; --lmp-h-rt:14px;" +
    "    --lmp-h-popcorn:14px; --lmp-h-tmdb:14px; --lmp-h-awards:12px;" +
    "    --lmp-h-avg:12px; --lmp-h-oscar:12px; --lmp-h-emmy:14px;" +
    "  }" +
    "  .lmp-award-icon{height:12px;}" +
    "}" +
    "</style>";

  /**
   * Налаштування кешу
   */
  var CACHE_TIME = 3 * 24 * 60 * 60 * 1000; // 3 дні
  // var CACHE_TIME = 60 * 60 * 1000; // ✅ 1 година для перевірок
  var RATING_CACHE_KEY = 'lmp_enh_rating_cache'; // Кеш рейтингів
  var ID_MAPPING_CACHE = 'lmp_rating_id_cache'; // Кеш TMDB -> IMDb ID

  /**
   * Мапінг вікових рейтингів
   */
  var AGE_RATINGS = {
    'G': '3+',
    'PG': '6+',
    'PG-13': '13+',
    'R': '17+',
    'NC-17': '18+',
    'TV-Y': '0+',
    'TV-Y7': '7+',
    'TV-G': '3+',
    'TV-PG': '6+',
    'TV-14': '14+',
    'TV-MA': '17+'
  };

  /**
   * Налаштування за замовчуванням (для меню)
   */
  var RCFG_DEFAULT = {
    ratings_omdb_key: (LMP_ENH_CONFIG.apiKeys.omdb || ''),
    ratings_mdblist_key: (LMP_ENH_CONFIG.apiKeys.mdblist || ''),
    ratings_bw_logos: false,
    ratings_show_awards: true,
    ratings_show_average: true,
    ratings_logo_offset: 0,
    ratings_font_offset: 0,
    ratings_badge_alpha: 0.15,
    ratings_badge_tone: 0,
    ratings_gap_step: 0,
    // Нові тумблери
    ratings_colorize_all: false, // Кольорові оцінки рейтингів (усі плитки + нагороди + AVG)
    ratings_enable_imdb: true, // Вкл/Викл IMDb
    ratings_enable_tmdb: true, // Вкл/Викл TMDB
    ratings_enable_mc: true, // Вкл/Викл Metacritic
    ratings_enable_rt: true, // Вкл/Викл Rotten Tomatoes
    ratings_enable_popcorn: true, // Вкл/Викл PopcornMeter (Audience)
    ratings_poster_badges: false, // Вкл/Викл наклейки-рейтинги на постері
  };

  /*
  |==========================================================================
  | 3. ДОПОМІЖНІ ФУНКЦІЇ (HELPERS)
  |==========================================================================
  */

  /**
   * Внутрішній стан
   */
  var __lmpRateLineObs = null; // Спостерігач за DOM (для лоадера)
  var currentRatingsData = null; // Кеш рейтингів для поточної картки
  var __lmpLastReqToken = null; // Токен останнього запиту (для уникнення гонки)

  /**
   * Визначає тип картки (movie/tv)
   */
  function getCardType(card) {
    var type = card.media_type || card.type;
    if (type === 'movie' || type === 'tv') return type;
    return card.name || card.original_name ? 'tv' : 'movie';
  }

  /**
   * Приховує стандартний рейтинг Кінопошуку
   */
  (function() {
    try {
      var kpCss = '<style>.full-start__rate.rate--kp, .rate--kp{display:none!important;}</style>';
      Lampa.Template.add('lmp_hide_kp', kpCss);
      $('body').append(Lampa.Template.get('lmp_hide_kp', {}, true));
    } catch (e) {}
  })();

  /**
   * Повертає CSS-клас для кольору рейтингу
   */
  function getRatingClass(rating) {
    var r = parseFloat(rating);
    if (isNaN(r)) return 'rating--red';
    if (r >= 8.0) return 'rating--green'; // ≥ 8.0
    if (r >= 6.0) return 'rating--blue'; // 6.0–7.9
    if (r >= 4.0) return 'rating--orange'; // 4.0–5.9
    return 'rating--red'; // < 4.0
  }

  /**
   * Генерує ключ кешу для стікерів на постері
   */
  function posterCacheKeyForCard(card) {
    return 'poster_' + (card.type || getCardType(card)) + '_' + (card.imdb_id || card.id);
  }

  /**
   * Отримує "сире" значення рейтингу з об'єкта
   */
  function lmpRawVal(it) {
    if (!it || typeof it !== 'object') return null;
    var v = it.value;
    if (v == null) v = it.score;
    if (v == null) v = it.rating;
    if (v == null) v = it.percent;
    if (v == null && typeof it.display === 'string') v = it.display;
    return v == null ? null : v;
  }

  /**
   * Фільтр для стікерів на постері (типу MDBList/Enchanser)
   * Прибирає TMDB та (на cub) IMDb, а також порожні значення.
   */
  function filterMdblistLike(arr) {
    if (!Array.isArray(arr)) return [];
    var isCub = (Lampa.Storage.get('source') || '').toLowerCase() === 'cub';

    return arr.filter(function(x) {
      if (!x) return false;
      var val = lmpRawVal(x);
      if (val == null) return false;

      var s = String(x.source || '').toLowerCase();
      if (s === 'tmdb') return false;
      if (isCub && s === 'imdb') return false;
      return true;
    });
  }

  /**
   * Створює MDBList-подібний масив з наявних даних (для стікерів)
   */
  function buildMdblistLikeArray(data) {
    // Якщо є сирі дані MDBList - беремо їх
    if (data && Array.isArray(data._mdblist_ratings) && data._mdblist_ratings.length) {
      return data._mdblist_ratings.slice();
    }
    // Інакше синтезуємо з того, що є
    var a = [],
      d = data || {};
    if (d.imdb_display) a.push({
      source: 'imdb',
      value: d.imdb_display
    });
    if (d.mc_critic_display) a.push({
      source: 'metacritic',
      value: d.mc_critic_display
    });
    if (d.mc_user_display) a.push({
      source: 'metacritic_user',
      value: d.mc_user_display
    });
    if (d.rt_display) a.push({
      source: 'rottentomatoes',
      value: d.rt_display
    });
    if (d.popcorn_display) a.push({
      source: 'popcorn',
      value: d.popcorn_display
    });
    if (d.tmdb_display) a.push({
      source: 'tmdb',
      value: d.tmdb_display
    });
    return a;
  }

  /**
   * Додає CSS-стилі для стікерів на постері (одноразово)
   */
  function ensurePosterBadgeStylesOnce() {
    if (document.getElementById('lmp-poster-badges-css')) return;

    var css = `
    /* === Бейдж одного рейтингу на постері === */
    .card__lmerating{
      position:absolute;
      right:-0.8em;                     /* 👉 відступ від правого краю */
      padding:0.40em 0.60em;            /* 👉 внутрішні відступи */
      background:linear-gradient(90deg,#2c2c2c,#1a1a1a); /* 👉 фон бейджа */
      color:#fff;
      border-radius:0.35em;             /* 👉 скруглення */
      text-transform:uppercase;
      font-size:0.80em;                 /* 👉 розмір шрифту */
      line-height:1;
      box-shadow:0 2px 6px rgba(0,0,0,.35); /* 👉 тінь */
      z-index:5;
      pointer-events:none;
    }
    @media (max-width:768px){
      .card__lmerating{ right:.2em; font-size:.74em; }
    }
    @media (max-width:480px){
      .card__lmerating{ right:.2em; font-size:.66em; }
    }
    `.trim();

    var st = document.createElement('style');
    st.id = 'lmp-poster-badges-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /**
   * Генерує HTML для іконки сервісу
   */
  function iconImg(url, alt, sizePx, extraStyle) {
    return '<img style="' +
      'width:auto; display:inline-block; vertical-align:middle; ' +
      'object-fit:contain; ' +
      (extraStyle || '') + ' ' +
      '" ' +
      'src="' + url + '" alt="' + (alt || '') + '">';
  }

  /**
   * Генерує HTML для іконки Emmy
   */
  function emmyIconInline() {
    return '<span class="lmp-award-icon lmp-award-icon--emmy"><img src="' + ICONS.emmy + '" alt="Emmy"></span>';
  }

  /**
   * Генерує HTML для іконки Oscar
   */
  function oscarIconInline() {
    return '<span class="lmp-award-icon lmp-award-icon--oscar"><img src="' + ICONS.oscar + '" alt="Oscar"></span>';
  }

  /**
   * "Затемнює" рядок рейтингів
   */
  function dimRateLine(rateLine) {
    if (!rateLine || !rateLine.length) return;
    rateLine.addClass('lmp-is-loading-ratings');
  }

  /**
   * Відновлює видимість рядка рейтингів
   */
  function undimRateLine(rateLine) {
    if (!rateLine || !rateLine.length) return;
    rateLine.removeClass('lmp-is-loading-ratings');
  }

  /**
   * Додає анімацію завантаження ("Пошук...")
   */
  function addLoadingAnimation() {
    var render = Lampa.Activity.active().activity.render();
    if (!render || !render[0]) return;

    if ($('#lmp-search-loader', render).length) return; // Вже є

    var loaderHtml =
      '<div id="lmp-search-loader" class="loading-dots-container">' +
      '<div class="loading-dots__text">Пошук…</div>' +
      '<div class="loading-dots__dot"></div>' +
      '<div class="loading-dots__dot"></div>' +
      '<div class="loading-dots__dot"></div>' +
      '</div>';

    // 1) Шукаємо реальний rate-line
    var realSel = '.full-start-new__rate-line:not([data-lmp-fake]), .full-start__rate-line:not([data-lmp-fake])';
    var rateLine = $(realSel, render).first();
    if (rateLine.length) {
      rateLine.append(loaderHtml);
      dimRateLine(rateLine);
      return;
    }

    // 2) Створюємо фейковий rate-line, щоб лоадер був "на місці"
    var fake = $(
      '<div class="full-start-new__rate-line" ' +
      '     id="lmp-loader-fake" data-lmp-fake="1" ' +
      '     style="min-height:28px; display:flex; align-items:center;"></div>'
    );

    var anchor = $('.full-start-new__title, .full-start__title', render).first();
    if (anchor.length) anchor.after(fake);
    else $(render).append(fake);

    fake.append(loaderHtml);

    // 3) Спостерігаємо за появою реального rate-line
    try {
      if (__lmpRateLineObs) __lmpRateLineObs.disconnect();
    } catch (_) {}
    __lmpRateLineObs = new MutationObserver(function() {
      var rl = $(realSel, render).first();
      var loader = $('#lmp-search-loader', render);
      if (rl.length && loader.length) {
        rl.append(loader);
        dimRateLine(rl);
        $('#lmp-loader-fake', render).remove();
        try {
          __lmpRateLineObs.disconnect();
        } catch (_) {}
        __lmpRateLineObs = null;
      }
    });
    __lmpRateLineObs.observe(render[0], {
      childList: true,
      subtree: true
    });

    // Таймаут безпеки
    setTimeout(function() {
      if (__lmpRateLineObs) {
        try {
          __lmpRateLineObs.disconnect();
        } catch (_) {}
        __lmpRateLineObs = null;
      }
    }, 6000);
  }

  /**
   * Прибирає анімацію завантаження
   */
  function removeLoadingAnimation() {
    var render = Lampa.Activity.active().activity.render();
    if (!render || !render[0]) return;

    $('#lmp-search-loader', render).remove();
    $('#lmp-loader-fake', render).remove();

    var rl = $('.full-start-new__rate-line:not([data-lmp-fake]), .full-start__rate-line:not([data-lmp-fake])', render).first();
    if (rl.length) undimRateLine(rl);

    try {
      if (__lmpRateLineObs) __lmpRateLineObs.disconnect();
    } catch (_) {}
    __lmpRateLineObs = null;
  }

  /**
   * Отримує дані з кешу
   */
  function getCachedRatings(key) {
    var cache = Lampa.Storage.get(RATING_CACHE_KEY) || {};
    var item = cache[key];
    if (!item) return null;
    if (Date.now() - item.timestamp > CACHE_TIME) return null;
    return item.data || null;
  }

  /**
   * Зберігає дані в кеш
   */
  function saveCachedRatings(key, data) {
    if (!data) return;
    var cache = Lampa.Storage.get(RATING_CACHE_KEY) || {};
    cache[key] = {
      timestamp: Date.now(),
      data: data
    };
    Lampa.Storage.set(RATING_CACHE_KEY, cache);
  }

  /**
   * Парсить рядок нагород з OMDB
   */
  function parseAwards(awardsText) {
    if (typeof awardsText !== 'string') return {
      oscars: 0,
      emmy: 0,
      awards: 0
    };

    var result = {
      oscars: 0,
      emmy: 0,
      awards: 0
    };
    var oscarMatch = awardsText.match(/Won (\d+) Oscars?/i);
    if (oscarMatch && oscarMatch[1]) {
      result.oscars = parseInt(oscarMatch[1], 10);
    }
    var emmyMatch = awardsText.match(/Won (\d+) Primetime Emmys?/i);
    if (emmyMatch && emmyMatch[1]) {
      result.emmy = parseInt(emmyMatch[1], 10);
    }
    var otherMatch = awardsText.match(/Another (\d+) wins?/i);
    if (otherMatch && otherMatch[1]) {
      result.awards = parseInt(otherMatch[1], 10);
    }
    if (result.awards === 0) {
      var simpleMatch = awardsText.match(/(\d+) wins?/i);
      if (simpleMatch && simpleMatch[1]) {
        result.awards = parseInt(simpleMatch[1], 10);
      }
    }
    return result;
  }

  /**
   * FIX: Замінює "10.0" на "10"
   */
  (function() {
    function fixTenIn(el) {
      // Нормалізуємо пробіли (у т.ч. нерозривні)
      var t = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
      // 10 з будь-якою кількістю нульових десяткових: 10.0, 10.00, 10., 10,0
      if (/^10(?:[.,]0+)?$/.test(t)) {
        el.textContent = '10';
      }
    }

    function scan(root) {
      try {
        var nodes = root.querySelectorAll('.full-start__rate > div:first-child');
        for (var i = 0; i < nodes.length; i++) fixTenIn(nodes[i]);
      } catch (e) {}
    }

    // Запускаємо спостерігача
    window.__lmpTenFixStart = function() {
      try {
        var render = Lampa && Lampa.Activity && Lampa.Activity.active() &&
          Lampa.Activity.active().activity.render &&
          Lampa.Activity.active().activity.render();
        if (!render || !render[0]) return;

        var target =
          render[0].querySelector('.full-start-new__rate-line, .full-start__rate-line') ||
          render[0];

        // Одноразово виправляємо вже наявне
        scan(target);

        var MObs = window.MutationObserver || window.WebKitMutationObserver;
        if (!MObs) return;

        // Скидаємо попереднього, якщо був
        if (window.__lmpTenObs) {
          window.__lmpTenObs.disconnect();
          window.__lmpTenObs = null;
        }

        // Реагуємо на нові/змінені вузли
        var obs = new MObs(function(muts) {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.type === 'characterData') {
              var p = m.target && m.target.parentNode;
              if (p && p.nodeType === 1 && p.matches('.full-start__rate > div:first-child')) fixTenIn(p);
            } else if (m.type === 'childList') {
              var added = m.addedNodes || [];
              for (var j = 0; j < added.length; j++) {
                var n = added[j];
                if (!n || n.nodeType !== 1) continue;
                if (n.matches && n.matches('.full-start__rate > div:first-child')) fixTenIn(n);
                if (n.querySelectorAll) {
                  var inner = n.querySelectorAll('.full-start__rate > div:first-child');
                  for (var k = 0; k < inner.length; k++) fixTenIn(inner[k]);
                }
              }
            }
          }
        });

        obs.observe(target, {
          subtree: true,
          childList: true,
          characterData: true
        });
        window.__lmpTenObs = obs;
      } catch (e) {}
    };
  })();

  /* --- ДОДАНО: Функція для сповіщень (Toast) --- */
  /**
   * Показує коротке сповіщення (Toast)
   * @param {string} msg - Текст повідомлення
   */
  function lmpToast(msg) {
    try {
      if (Lampa && typeof Lampa.Noty === 'function') {
        Lampa.Noty(msg);
        return;
      }
      if (Lampa && Lampa.Noty && Lampa.Noty.show) {
        Lampa.Noty.show(msg);
        return;
      }
    } catch (e) {}
    var id = 'lmp_toast';
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:2rem;padding:.6rem 1rem;background:rgba(0,0,0,.85);color:#fff;border-radius:.5rem;z-index:9999;font-size:14px;transition:opacity .2s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(function() {
      el.style.opacity = '0';
    }, 1300);
  }

  /* --- ДОДАНО: Функція очищення кешу --- */
  /**
   * Очищує кеш рейтингів та ID
   */
  function lmpRatingsClearCache() {
    try {
      // RATING_CACHE_KEY та ID_MAPPING_CACHE визначені у Секції 2
      Lampa.Storage.set(RATING_CACHE_KEY, {});
      Lampa.Storage.set(ID_MAPPING_CACHE, {});
      lmpToast('Кеш рейтингів очищено');
    } catch (e) {
      console.error('LMP Ratings: clear cache error', e);
      lmpToast('Помилка очищення кешу');
    }
  }

  /*
  |==========================================================================
  | 4. МЕРЕЖА (NETWORK)
  |==========================================================================
  */

  /**
   * Отримує imdb_id з TMDB
   */
  function getImdbIdFromTmdb(tmdbId, type, callback) {
    if (!tmdbId) return callback(null);

    var preferredType = (type === 'movie') ? 'movie' : 'tv';
    var altType = preferredType === 'movie' ? 'tv' : 'movie';

    var cache = Lampa.Storage.get(ID_MAPPING_CACHE) || {};
    var now = Date.now();

    function fromCache(key) {
      var item = cache[key];
      if (!item) return null;
      if (!item.imdb_id) return null;
      if (now - item.timestamp > CACHE_TIME) return null;
      return item.imdb_id;
    }

    var keyPreferred = preferredType + '_' + tmdbId;
    var keyAlt = altType + '_' + tmdbId;

    // 1) Шукаємо в кеші
    var cachedId = fromCache(keyPreferred) || fromCache(keyAlt);
    if (cachedId) return callback(cachedId);

    var tmdbKey = Lampa.TMDB.key();
    // 2) Робимо запити
    var queue = [
      'https://api.themoviedb.org/3/' + preferredType + '/' + tmdbId + '/external_ids?api_key=' + tmdbKey,
      'https://api.themoviedb.org/3/' + preferredType + '/' + tmdbId + '?api_key=' + tmdbKey + '&append_to_response=external_ids',
      'https://api.themoviedb.org/3/' + altType + '/' + tmdbId + '/external_ids?api_key=' + tmdbKey,
      'https://api.themoviedb.org/3/' + altType + '/' + tmdbId + '?api_key=' + tmdbKey + '&append_to_response=external_ids'
    ];

    var makeRequest = function(u, success, error) {
      new Lampa.Reguest().silent(u, success, function() {
        new Lampa.Reguest().native(
          u,
          function(data) {
            try {
              success(typeof data === 'string' ? JSON.parse(data) : data);
            } catch (e) {
              error();
            }
          },
          error,
          false, {
            dataType: 'json'
          }
        );
      });
    };

    function extractImdbId(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.imdb_id && typeof obj.imdb_id === 'string') return obj.imdb_id;
      if (obj.external_ids && typeof obj.external_ids.imdb_id === 'string') return obj.external_ids.imdb_id;
      return null;
    }

    function saveAndReturn(id) {
      // Кешуємо під обома ключами
      var payload = {
        imdb_id: id,
        timestamp: Date.now()
      };
      cache[keyPreferred] = payload;
      cache[keyAlt] = payload;
      Lampa.Storage.set(ID_MAPPING_CACHE, cache);
      callback(id);
    }

    (function next() {
      var url = queue.shift();
      if (!url) return callback(null);

      makeRequest(url, function(data) {
        var imdbId = extractImdbId(data);
        if (imdbId) saveAndReturn(imdbId);
        else next();
      }, function() {
        next();
      });
    })();
  }

  /**
   * Завантажує рейтинги з MDBList
   */
  function fetchMdbListRatings(card, callback) {
    var key = LMP_ENH_CONFIG.apiKeys.mdblist;
    if (!key) {
      callback(null);
      return;
    }

    var typeSegment = (card.type === 'tv') ? 'show' : card.type;
    var url = 'https://api.mdblist.com/tmdb/' + typeSegment + '/' + card.id +
      '?apikey=' + encodeURIComponent(key);

    // Основний запит
    new Lampa.Reguest().silent(url, handleSuccess, handleFail);

    // Фолбек-запит
    function handleFail() {
      new Lampa.Reguest().native(
        url,
        function(data) {
          try {
            handleSuccess(typeof data === 'string' ? JSON.parse(data) : data);
          } catch (e) {
            callback(null);
          }
        },
        function() {
          callback(null);
        },
        false, {
          dataType: 'json'
        }
      );
    }

    // Обробка успішної відповіді
    function handleSuccess(response) {
      if (!response || !response.ratings || !response.ratings.length) {
        callback(null);
        return;
      }

      var res = {
        tmdb_display: null,
        tmdb_for_avg: null,
        imdb_display: null,
        imdb_for_avg: null,
        mc_user_display: null,
        mc_user_for_avg: null,
        mc_critic_display: null,
        mc_critic_for_avg: null,
        rt_display: null,
        rt_for_avg: null,
        rt_fresh: null,
        popcorn_display: null,
        popcorn_for_avg: null
      };

      function parseRawScore(rawVal) {
        if (rawVal === null || rawVal === undefined) return null;
        if (typeof rawVal === 'number') return rawVal;
        if (typeof rawVal === 'string') {
          if (rawVal.indexOf('%') !== -1) {
            return parseFloat(rawVal.replace('%', ''));
          }
          if (rawVal.indexOf('/') !== -1) {
            return parseFloat(rawVal.split('/')[0]);
          }
          return parseFloat(rawVal);
        }
        return null;
      }

      function isUserSource(src) {
        return (
          src.indexOf('user') !== -1 ||
          src.indexOf('users') !== -1 ||
          src.indexOf('metacriticuser') !== -1 ||
          src.indexOf('metacritic_user') !== -1
        );
      }

      response.ratings.forEach(function(r) {
        var src = (r.source || '').toLowerCase();
        var val = parseRawScore(r.value);
        if (val === null || isNaN(val)) return;

        // TMDB
        if (src.indexOf('tmdb') !== -1) {
          var tmdb10 = val > 10 ? (val / 10) : val;
          res.tmdb_display = tmdb10.toFixed(1);
          res.tmdb_for_avg = tmdb10;
        }
        // IMDb
        if (src.indexOf('imdb') !== -1) {
          var imdb10 = val > 10 ? (val / 10) : val;
          res.imdb_display = imdb10.toFixed(1);
          res.imdb_for_avg = imdb10;
        }
        // Metacritic (users)
        if (src.indexOf('metacritic') !== -1 && isUserSource(src)) {
          var user10 = val > 10 ? (val / 10) : val;
          res.mc_user_display = user10.toFixed(1);
          res.mc_user_for_avg = user10;
        }
        // Metacritic (critics)
        if (src.indexOf('metacritic') !== -1 && !isUserSource(src)) {
          var critic10 = val > 10 ? (val / 10) : val;
          res.mc_critic_display = critic10.toFixed(1);
          res.mc_critic_for_avg = critic10;
        }
        // Rotten Tomatoes
        if (src.indexOf('rotten') !== -1 || src.indexOf('tomato') !== -1) {
          res.rt_display = String(Math.round(val));
          res.rt_for_avg = val / 10;
          res.rt_fresh = val >= 60;
        }
        // PopcornMeter / Audience
        if (src.indexOf('popcorn') !== -1 || src.indexOf('audience') !== -1) {
          res.popcorn_display = String(Math.round(val));
          res.popcorn_for_avg = val / 10;
        }
      });

      // Збережемо "сирі" рейтинги для стікерів на постері
      res._mdblist_ratings = Array.isArray(response.ratings) ? response.ratings.slice() : [];

      callback(res);
    }
  }

  /**
   * Завантажує рейтинги з OMDB
   */
  function fetchOmdbRatings(card, callback) {
    var key = LMP_ENH_CONFIG.apiKeys.omdb;
    if (!key || !card.imdb_id) {
      callback(null);
      return;
    }

    var typeParam = (card.type === 'tv') ? '&type=series' : '';
    var url = 'https://www.omdbapi.com/?apikey=' + encodeURIComponent(key) +
      '&i=' + encodeURIComponent(card.imdb_id) + typeParam;

    new Lampa.Reguest().silent(url, function(data) {
      if (!data || data.Response !== 'True') {
        callback(null);
        return;
      }

      var awardsParsed = parseAwards(data.Awards || '');
      var rtScore = null;
      var mcScore = null;

      if (Array.isArray(data.Ratings)) {
        data.Ratings.forEach(function(r) {
          if (r.Source === 'Rotten Tomatoes') {
            var v = parseInt((r.Value || '').replace('%', ''));
            if (!isNaN(v)) rtScore = v;
          }
          if (r.Source === 'Metacritic') {
            var m = parseInt((r.Value || '').split('/')[0]);
            if (!isNaN(m)) mcScore = m;
          }
        });
      }

      var mc10 = (mcScore !== null && !isNaN(mcScore)) ?
        (mcScore > 10 ? mcScore / 10 : mcScore) :
        null;

      var res = {
        tmdb_display: null,
        tmdb_for_avg: null,
        imdb_display: data.imdbRating && data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating).toFixed(1) : null,
        imdb_for_avg: data.imdbRating && data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : null,
        mc_user_display: null,
        mc_user_for_avg: null,
        mc_critic_display: (mc10 !== null ? mc10.toFixed(1) : null),
        mc_critic_for_avg: (mc10 !== null ? mc10 : null),
        rt_display: (rtScore !== null && !isNaN(rtScore)) ? String(rtScore) : null,
        rt_for_avg: (rtScore !== null && !isNaN(rtScore)) ? (rtScore / 10) : null,
        rt_fresh: (rtScore !== null && !isNaN(rtScore)) ? (rtScore >= 60) : null,
        popcorn_display: null,
        popcorn_for_avg: null,
        ageRating: data.Rated || null,
        oscars: awardsParsed.oscars || 0,
        emmy: awardsParsed.emmy || 0,
        awards: awardsParsed.awards || 0
      };

      callback(res);
    }, function() {
      callback(null);
    });
  }

  /*
  |==========================================================================
  | 5. ОБ'ЄДНАННЯ ДАНИХ (MERGE)
  |==========================================================================
  */

  /**
   * Змерджує результати MDBList та OMDB
   */
  /**
   * Змерджує результати MDBList та OMDB
   */
  function mergeRatings(mdb, omdb) {
    mdb = mdb || {};
    omdb = omdb || {};

    var mc_display = null;
    var mc_for_avg = null;

    if (mdb.mc_user_display) {
      mc_display = mdb.mc_user_display;
      mc_for_avg = mdb.mc_user_for_avg;
    } else if (mdb.mc_critic_display) {
      mc_display = mdb.mc_critic_display;
      mc_for_avg = mdb.mc_critic_for_avg;
    } else if (omdb.mc_critic_display) {
      mc_display = omdb.mc_critic_display;
      mc_for_avg = omdb.mc_critic_for_avg;
    }

    var merged = {
      tmdb_display: mdb.tmdb_display || null,
      tmdb_for_avg: mdb.tmdb_for_avg || null,
      imdb_display: mdb.imdb_display || omdb.imdb_display || null,
      imdb_for_avg: mdb.imdb_for_avg || omdb.imdb_for_avg || null,

      // >>> ДОДАНО: зберігаємо обидві гілки Metacritic
      mc_user_display:   mdb.mc_user_display   || null,
      mc_user_for_avg:   (typeof mdb.mc_user_for_avg   === 'number' ? mdb.mc_user_for_avg   : null),
      mc_critic_display: mdb.mc_critic_display || omdb.mc_critic_display || null,
      mc_critic_for_avg: (typeof mdb.mc_critic_for_avg === 'number' ? mdb.mc_critic_for_avg : (typeof omdb.mc_critic_for_avg === 'number' ? omdb.mc_critic_for_avg : null)),

      // Поточне зведене поле (для сумісності з існ. логікою)
      mc_display: mc_display || null,
      mc_for_avg: (typeof mc_for_avg === 'number' ? mc_for_avg : null),

      rt_display: mdb.rt_display || omdb.rt_display || null,
      rt_for_avg: mdb.rt_for_avg || omdb.rt_for_avg || null,
      rt_fresh: (mdb.rt_display || omdb.rt_display) ?
        (mdb.rt_display ? mdb.rt_fresh : omdb.rt_fresh) :
        null,
      popcorn_display: mdb.popcorn_display || null,
      popcorn_for_avg: mdb.popcorn_for_avg || null,
      ageRating: omdb.ageRating || null,
      oscars: omdb.oscars || 0,
      emmy: omdb.emmy || 0,
      awards: omdb.awards || 0,
      // Не загубити сирі рейтинги для постера
      _mdblist_ratings: Array.isArray(mdb._mdblist_ratings) ? mdb._mdblist_ratings.slice() : []
    };

    return merged;
  }


  /*
  |==========================================================================
  | 6. РЕНДЕР (RENDER)
  |==========================================================================
  */

  /**
   * Прибирає стікери рейтингів з постера
   */
  function removePosterBadges(root) {
    var host = (root || document).querySelectorAll('.card__lmerating');
    host.forEach(function(x) {
      x.parentNode && x.parentNode.removeChild(x);
    });
  }

  /**
   * Рендерить стікери на постері в картці деталей
   */
  function renderPosterBadgesOnDetails(data, renderRoot) {
    var cfg = getCfg();
    if (!cfg.enablePosterBadges) {
      removePosterBadges(renderRoot && renderRoot[0]);
      return;
    }
    ensurePosterBadgeStylesOnce();

    var $render = renderRoot || (Lampa.Activity.active().activity.render && Lampa.Activity.active().activity.render());
    if (!$render || !$render.length) return;

    // Шукаємо постер
    var $poster = $('.full-start-new__poster, .full-start__poster', $render).first();
    if (!$poster.length) return;

    // Прибираємо дублікати
    $poster.find('.card__lmerating').remove();

    // Дані
    var raw = buildMdblistLikeArray(data);
    var items = filterMdblistLike(raw);
    if (!items.length) return;

    // Рендеримо "сходинками"
    var topStartEm = 0.8; // Початковий відступ зверху
    var stepEm = 2.0; // Крок між бейджами
    items.forEach(function(it, i) {
      var $b = $('<div class="card__lmerating"></div>');
      $b.css('top', 'calc(' + topStartEm + 'em + ' + (i * stepEm) + 'em)');
      $b.text(String(it.source || '').toUpperCase() + ': ' + String(it.value));
      $poster.append($b);
    });
  }

  /**
   * Рендерить стікери на постері в списку (гріді)
   */
  function renderPosterBadgesFromRaw(rawRatings, $cardView) {
    if (!$cardView || !$cardView.length) return;
    $cardView.find('.card__lmerating').remove();

    var items = filterMdblistLike(rawRatings);
    if (!items.length) return;

    ensurePosterBadgeStylesOnce();

    var topStartEm = 0.6,
      stepEm = 2.0;
    items.forEach(function(it, i) {
      var val = lmpRawVal(it);
      if (val == null) return;
      var txt = String((it.source || '').toUpperCase()) + ': ' + String(val);
      if (it.votes != null) txt += ' /' + String(it.votes);

      var $b = $('<div class="card__lmerating"></div>');
      $b.css('top', 'calc(' + topStartEm + 'em + ' + (i * stepEm) + 'em)').text(txt);
      $cardView.append($b); // $poster не визначено тут, міняємо на $cardView
    });
  }

  /**
   * Оновлює приховані елементи (вік, IMDb, TMDB)
   */
  function updateHiddenElements(data) {
    var render = Lampa.Activity.active().activity.render();
    if (!render || !render[0]) return;

    // Віковий рейтинг
    var pgElement = $('.full-start__pg.hide', render);
    if (pgElement.length && data.ageRating) {
      var invalidRatings = ['N/A', 'Not Rated', 'Unrated'];
      var isValid = invalidRatings.indexOf(data.ageRating) === -1;
      if (isValid) {
        var localized = AGE_RATINGS[data.ageRating] || data.ageRating;
        pgElement.removeClass('hide').text(localized);
      }
    }

    // IMDb блок
    var imdbContainer = $('.rate--imdb', render);
    if (imdbContainer.length) {
      var cfg = getCfg();
      if (!cfg.enableImdb || !data.imdb_display) {
        imdbContainer.addClass('hide')
          .removeClass('rating--green rating--blue rating--orange rating--red');
      } else {
        imdbContainer.removeClass('hide');
        var imdbDivs = imdbContainer.find('> div');
        if (imdbDivs.length >= 2) {
          imdbDivs.eq(0).text(parseFloat(data.imdb_display).toFixed(1));
          imdbDivs.eq(1).addClass('source--name').html(iconImg(ICONS.imdb, 'IMDb', 22));
        }
        imdbContainer.removeClass('rating--green rating--blue rating--orange rating--red');
        if (cfg.colorizeAll && data.imdb_for_avg && !isNaN(data.imdb_for_avg)) {
          imdbContainer.addClass(getRatingClass(parseFloat(data.imdb_for_avg)));
        }
      }
    }

    // TMDB блок
    var tmdbContainer = $('.rate--tmdb', render);
    if (tmdbContainer.length) {
      var cfg = getCfg();
      if (!cfg.enableTmdb || !data.tmdb_display) {
        tmdbContainer.addClass('hide')
          .removeClass('rating--green rating--blue rating--orange rating--red');
      } else {
        var tmdbDivs = tmdbContainer.find('> div');
        if (tmdbDivs.length >= 2) {
          tmdbDivs.eq(0).text(parseFloat(data.tmdb_display).toFixed(1));
          tmdbDivs.eq(1).addClass('source--name').html(iconImg(ICONS.tmdb, 'TMDB', 24));
        }
        tmdbContainer.removeClass('hide rating--green rating--blue rating--orange rating--red');
        if (cfg.colorizeAll && data.tmdb_for_avg && !isNaN(data.tmdb_for_avg)) {
          tmdbContainer.addClass(getRatingClass(parseFloat(data.tmdb_for_avg)));
        }
      }
    }
  }

  /**
   * Застосовує "золотий" колір до нагород (залежно від налаштувань)
   */
  function applyAwardsColor(rateLine, cfg) {
    var $tiles = rateLine.find('.rate--awards, .rate--oscars, .rate--emmy');
    $tiles.removeClass('rating--green rating--blue rating--orange rating--red');

    if (cfg && cfg.colorizeAll) {
      $tiles.addClass('rate--gold');
    } else {
      $tiles.removeClass('rate--gold');
    }
  }

  /**
   * Вставляє нові бейджі (MC, RT, Popcorn, Awards)
   */
  function insertRatings(data) {
    var render = Lampa.Activity.active().activity.render();
    if (!render) return;

    var rateLine = $('.full-start-new__rate-line:not([data-lmp-fake]), .full-start__rate-line:not([data-lmp-fake])', render);
    if (!rateLine.length) return;

    var cfg = (typeof getCfg === 'function') ? getCfg() : {
      enableImdb: true,
      enableTmdb: true,
      enableMc: true,
      enableRt: true,
      enablePop: true,
      mcMode: 'meta',
      colorizeAll: false
    };

    // ===== METACRITIC (Автовибір: User → Critic → Fallback) =====
    (function() {
      var cont = $('.rate--mc', rateLine);
      if (!cfg.enableMc) {
        cont.remove();
        return;
      }

      var mcVal = null;
      if (data.mc_user_for_avg && !isNaN(data.mc_user_for_avg)) {
        mcVal = parseFloat(data.mc_user_for_avg);
      } else if (data.mc_critic_for_avg && !isNaN(data.mc_critic_for_avg)) {
        mcVal = parseFloat(data.mc_critic_for_avg);
      } else if (data.mc_for_avg && !isNaN(data.mc_for_avg)) {
        mcVal = parseFloat(data.mc_for_avg);
      } else if (data.mc_display && !isNaN(parseFloat(data.mc_display))) {
        var md = parseFloat(data.mc_display);
        mcVal = (md > 10) ? (md / 10) : md;
      }

      if (mcVal == null || isNaN(mcVal)) {
        cont.remove();
        return;
      }

      var mcText = mcVal.toFixed(1);


      // Визначаємо джерело (user чи critic/загальне) і обираємо відповідну іконку
      var usedIsUser   = (data.mc_user_for_avg && !isNaN(data.mc_user_for_avg)) && Math.abs(mcVal - parseFloat(data.mc_user_for_avg)) < 0.051;
      var usedIsCritic = !usedIsUser && (data.mc_critic_for_avg && !isNaN(data.mc_critic_for_avg)) && Math.abs(mcVal - parseFloat(data.mc_critic_for_avg)) < 0.051;

      // за замовчуванням вважаємо Metascore (critics/generic) -> нове лого
      var mcIconUrl = ICONS.metascore;
      if (usedIsUser) mcIconUrl = ICONS.metacritic;
      if (usedIsCritic) mcIconUrl = ICONS.metascore;

      if (!cont.length) {
        cont = $(
          '<div class="full-start__rate rate--mc">' +
          '<div>' + mcText + '</div>' +
          '<div class="source--name"></div>' +
          '</div>'
        );
        cont.find('.source--name').html(iconImg(mcIconUrl, 'Metacritic', 22));

        var afterImdb = $('.rate--imdb', rateLine);
        if (afterImdb.length) cont.insertAfter(afterImdb);
        else rateLine.append(cont);
      } else {
        cont.find('> div').eq(0).text(mcText);
        cont.find('.source--name').html(iconImg(mcIconUrl, 'Metacritic', 22));
      }

      cont.removeClass('rating--green rating--blue rating--orange rating--red');
      if (cfg.colorizeAll) cont.addClass(getRatingClass(mcVal));
    })();


    // ===== ROTTEN TOMATOES (0–10) =====
    (function() {
      var cont = $('.rate--rt', rateLine);
      if (!cfg.enableRt) {
        cont.remove();
        return;
      }

      var rtVal = null;
      if (data.rt_for_avg && !isNaN(data.rt_for_avg)) rtVal = parseFloat(data.rt_for_avg);
      else if (data.rt_display && !isNaN(parseFloat(data.rt_display))) {
        var rtd = parseFloat(data.rt_display);
        rtVal = (rtd > 10) ? (rtd / 10) : rtd;
      }

      if (rtVal == null || isNaN(rtVal)) {
        cont.remove();
        return;
      }

      var rtText = rtVal.toFixed(1);
      var rtIconUrl = data.rt_fresh ? ICONS.rotten_good : ICONS.rotten_bad;
      var extra = data.rt_fresh ? 'border-radius:4px;' : '';

      if (!cont.length) {
        cont = $(
          '<div class="full-start__rate rate--rt">' +
          '<div>' + rtText + '</div>' +
          '<div class="source--name"></div>' +
          '</div>'
        );
        cont.find('.source--name').html(iconImg(rtIconUrl, 'Rotten Tomatoes', 22, extra));

        var afterMc = $('.rate--mc', rateLine);
        if (afterMc.length) cont.insertAfter(afterMc);
        else {
          var afterImdb2 = $('.rate--imdb', rateLine);
          if (afterImdb2.length) cont.insertAfter(afterImdb2);
          else rateLine.prepend(cont);
        }
      } else {
        cont.find('> div').eq(0).text(rtText);
        cont.find('.source--name').html(iconImg(rtIconUrl, 'Rotten Tomatoes', 22, extra));
      }

      cont.removeClass('rating--green rating--blue rating--orange rating--red');
      if (cfg.colorizeAll) cont.addClass(getRatingClass(rtVal));
    })();

    // ===== POPCORN / AUDIENCE (0–10) =====
    (function() {
      var cont = $('.rate--popcorn', rateLine);
      if (!cfg.enablePop) {
        cont.remove();
        return;
      }

      var pcVal = null;
      if (data.popcorn_for_avg && !isNaN(data.popcorn_for_avg)) pcVal = parseFloat(data.popcorn_for_avg);
      else if (data.popcorn_display && !isNaN(parseFloat(data.popcorn_display))) {
        var pcd = parseFloat(data.popcorn_display);
        pcVal = (pcd > 10) ? (pcd / 10) : pcd;
      }

      if (pcVal == null || isNaN(pcVal)) {
        cont.remove();
        return;
      }

      var pcText = pcVal.toFixed(1);

      if (!cont.length) {
        cont = $(
          '<div class="full-start__rate rate--popcorn">' +
          '<div>' + pcText + '</div>' +
          '<div class="source--name"></div>' +
          '</div>'
        );
        cont.find('.source--name').html(iconImg(ICONS.popcorn, 'Audience', 22));

        var anchors = rateLine.find('.rate--rt, .rate--mc, .rate--tmdb, .rate--imdb');
        if (anchors.length) cont.insertAfter(anchors.last());
        else rateLine.prepend(cont);
      } else {
        cont.find('> div').eq(0).text(pcText);
        cont.find('.source--name').html(iconImg(ICONS.popcorn, 'Audience', 22));
      }

      cont.removeClass('rating--green rating--blue rating--orange rating--red');
      if (cfg.colorizeAll) cont.addClass(getRatingClass(pcVal));
    })();

    // ===== Нагороди (Awards, Emmy, Oscars) =====
    if (data.awards && data.awards > 0 && !$('.rate--awards', rateLine).length) {
      var awardsElement = $(
        '<div class="full-start__rate rate--awards rate--gold">' +
        '<div>' + data.awards + '</div>' +
        '<div class="source--name"></div>' +
        '</div>'
      );
      awardsElement.find('.source--name')
        .html(iconImg(ICONS.awards, 'Awards', 20))
        .attr('title', Lampa.Lang.translate('awards_other_label'));
      rateLine.prepend(awardsElement);
    }

    if (data.emmy && data.emmy > 0 && !$('.rate--emmy', rateLine).length) {
      var emmyElement = $(
        '<div class="full-start__rate rate--emmy rate--gold">' +
        '<div>' + data.emmy + '</div>' +
        '<div class="source--name"></div>' +
        '</div>'
      );
      emmyElement.find('.source--name')
        .html(emmyIconInline())
        .attr('title', Lampa.Lang.translate('emmy_label'));
      rateLine.prepend(emmyElement);
    }

    if (data.oscars && data.oscars > 0 && !$('.rate--oscars', rateLine).length) {
      var oscarsElement = $(
        '<div class="full-start__rate rate--oscars rate--gold">' +
        '<div>' + data.oscars + '</div>' +
        '<div class="source--name"></div>' +
        '</div>'
      );
      oscarsElement.find('.source--name')
        .html(oscarIconInline())
        .attr('title', Lampa.Lang.translate('oscars_label'));
      rateLine.prepend(oscarsElement);
    }

    // Застосувати колір до нагород
    try {
      applyAwardsColor(rateLine, cfg);
    } catch (e) {}
  }

  /**
   * Розраховує та вставляє середній рейтинг (AVG)
   */
  function calculateAverageRating(data) {
    var render = Lampa.Activity.active().activity.render();
    if (!render) return;

    var rateLine = $('.full-start-new__rate-line:not([data-lmp-fake]), .full-start__rate-line:not([data-lmp-fake])', render);
    if (!rateLine.length) return;

    var cfg = (typeof getCfg === 'function') ? getCfg() : {
      enableImdb: true,
      enableTmdb: true,
      enableMc: true,
      enableRt: true,
      enablePop: true,
      colorizeAll: true,
      showAverage: true
    };

    $('.rate--avg', rateLine).remove();
    if (!cfg.showAverage) {
      try {
        applyAwardsColor(rateLine, cfg);
      } catch (e) {}
      removeLoadingAnimation();
      undimRateLine(rateLine);
      return;
    }

    var parts = [];
    if (cfg.enableTmdb && data.tmdb_for_avg && !isNaN(data.tmdb_for_avg)) parts.push(parseFloat(data.tmdb_for_avg));
    if (cfg.enableImdb && data.imdb_for_avg && !isNaN(data.imdb_for_avg)) parts.push(parseFloat(data.imdb_for_avg));

    if (cfg.enableMc) {
      if (data.mc_user_for_avg && !isNaN(data.mc_user_for_avg)) {
        parts.push(parseFloat(data.mc_user_for_avg));
      } else if (data.mc_critic_for_avg && !isNaN(data.mc_critic_for_avg)) {
        parts.push(parseFloat(data.mc_critic_for_avg));
      } else if (data.mc_for_avg && !isNaN(data.mc_for_avg)) {
        parts.push(parseFloat(data.mc_for_avg));
      }
    }

    if (cfg.enableRt && data.rt_for_avg && !isNaN(data.rt_for_avg)) parts.push(parseFloat(data.rt_for_avg));
    if (cfg.enablePop && data.popcorn_for_avg && !isNaN(data.popcorn_for_avg)) parts.push(parseFloat(data.popcorn_for_avg));

    if (!parts.length) {
      removeLoadingAnimation();
      undimRateLine(rateLine);
      return;
    }

    var sum = 0;
    for (var i = 0; i < parts.length; i++) sum += parts[i];
    var avg = sum / parts.length;
    var colorClass = cfg.colorizeAll ? getRatingClass(avg) : '';

    var avgElement = $(
      '<div class="full-start__rate rate--avg ' + colorClass + '">' +
      '<div>' + avg.toFixed(1) + '</div>' +
      '<div class="source--name"></div>' +
      '</div>'
    );

    var starHtml = iconImg(ICONS.total_star, 'AVG', 20);
    avgElement.find('.source--name').html(starHtml);

    var firstRate = $('.full-start__rate:first', rateLine);
    if (firstRate.length) firstRate.before(avgElement);
    else rateLine.prepend(avgElement);

    try {
      applyAwardsColor(rateLine, (typeof getCfg === 'function') ? getCfg() : null);
    } catch (e) {}

    removeLoadingAnimation();
    undimRateLine(rateLine);
  }

  /*
  |==========================================================================
  | 7. ГОЛОВНИЙ ПРОЦЕС (Orchestrator)
  |==========================================================================
  */

  /**
   * Головна функція, що запускає весь процес
   * (Отримання IMDb ID -> Запит -> Мердж -> Рендер)
   */
  function fetchAdditionalRatings(card) {
    var render = Lampa.Activity.active().activity.render();
    if (!render) return;

    // Синхронізуємо конфіг з налаштувань
    refreshConfigFromStorage();

    var normalizedCard = {
      id: card.id,
      imdb_id: card.imdb_id || card.imdb || null,
      title: card.title || card.name || '',
      original_title: card.original_title || card.original_name || '',
      type: getCardType(card),
      release_date: card.release_date || card.first_air_date || '',
      vote: card.vote_average || card.vote || null // Запасний рейтинг TMDB
    };

    var cardKeyForToken = (normalizedCard.type || getCardType(normalizedCard)) + '_' + (normalizedCard.imdb_id || normalizedCard.id || '');
    var reqToken = cardKeyForToken + '_' + Date.now();
    __lmpLastReqToken = reqToken;

    /**
     * Рендерить всі дані (викликається в кінці)
     */
    function renderAll() {
      if (reqToken !== __lmpLastReqToken) return; // Запит застарів
      if (!currentRatingsData) {
        removeLoadingAnimation();
        return;
      }

      updateHiddenElements(currentRatingsData);
      insertRatings(currentRatingsData);
      calculateAverageRating(currentRatingsData);

      // Стікери на постері в деталях
      try {
        renderPosterBadgesOnDetails(currentRatingsData);
      } catch (e) {}

      // Застосувати стилі з меню
      applyStylesToAll();
    }

    /**
     * Внутрішня логіка (після отримання IMDb ID)
     */
    function proceedWithImdbId() {
      // 1) Будуємо ключ кешу
      var cacheKeyBase = normalizedCard.imdb_id || normalizedCard.id;
      var cacheKey = cacheKeyBase ? (normalizedCard.type + '_' + cacheKeyBase) : null;

      // 2) Швидка гілка: дані є в кеші
      var cached = cacheKey ? getCachedRatings(cacheKey) : null;
      if (cached) {
        currentRatingsData = cached;
        renderAll(); // Малюємо одразу, БЕЗ лоадера
        return;
      }

      // 3) Кешу нема -> показуємо лоадер
      addLoadingAnimation();

      // 4) Тягнемо MDBList і OMDb паралельно
      var pending = 2;
      var mdbRes = null;
      var omdbRes = null;

      function oneDone() {
        pending--;
        if (pending !== 0) return;

        // 5) Змерджили відповіді
        currentRatingsData = mergeRatings(mdbRes, omdbRes);

        // 6) Fallback: якщо MDBList не дав TMDB-оцінку -> беремо з картки
        if (
          (!currentRatingsData.tmdb_display || !currentRatingsData.tmdb_for_avg) &&
          normalizedCard.vote != null
        ) {
          var tm = parseFloat(normalizedCard.vote);
          if (!isNaN(tm)) {
            if (tm > 10) tm = tm / 10;
            if (tm < 0) tm = 0;
            if (tm > 10) tm = 10;
            currentRatingsData.tmdb_for_avg = tm;
            currentRatingsData.tmdb_display = tm.toFixed(1);
          }
        }

        // 7) Кешуємо тільки не порожній результат
        if (
          cacheKey &&
          currentRatingsData && (
            currentRatingsData.tmdb_display ||
            currentRatingsData.imdb_display ||
            currentRatingsData.mc_display ||
            currentRatingsData.rt_display ||
            currentRatingsData.popcorn_display ||
            currentRatingsData.oscars ||
            currentRatingsData.emmy ||
            currentRatingsData.awards
          )
        ) {
          saveCachedRatings(cacheKey, currentRatingsData);
        }

        // 8) Фінальний рендер (всередині прибере лоадер)
        renderAll();
      }

      fetchMdbListRatings(normalizedCard, function(r1) {
        mdbRes = r1 || {};
        oneDone();
      });
      fetchOmdbRatings(normalizedCard, function(r2) {
        omdbRes = r2 || {};
        oneDone();
      });
    }

    // --- Точка входу в `fetchAdditionalRatings` ---
    // Якщо немає IMDb ID, спочатку отримуємо його
    if (!normalizedCard.imdb_id) {
      getImdbIdFromTmdb(normalizedCard.id, normalizedCard.type, function(imdb_id) {
        normalizedCard.imdb_id = imdb_id;
        proceedWithImdbId();
      });
    } else {
      // Якщо IMDb ID вже є, одразу запускаємо
      proceedWithImdbId();
    }
  }

  /*
  |==========================================================================
  | 8. НАЛАШТУВАННЯ (SETTINGS)
  | (Функції для меню налаштувань та застосування стилів)
  |==========================================================================
  */

  /**
   * Отримує актуальні налаштування з Lampa.Storage
   */
  function getCfg() {
    var omdbKey = Lampa.Storage.get('ratings_omdb_key', RCFG_DEFAULT.ratings_omdb_key);
    var mdblistKey = Lampa.Storage.get('ratings_mdblist_key', RCFG_DEFAULT.ratings_mdblist_key);
    var bwLogos = !!Lampa.Storage.field('ratings_bw_logos', RCFG_DEFAULT.ratings_bw_logos);
    var showAwards = !!Lampa.Storage.field('ratings_show_awards', RCFG_DEFAULT.ratings_show_awards);
    var showAverage = !!Lampa.Storage.field('ratings_show_average', RCFG_DEFAULT.ratings_show_average);
    var logoOffset = parseInt(Lampa.Storage.get('ratings_logo_offset', RCFG_DEFAULT.ratings_logo_offset), 10);
    if (isNaN(logoOffset)) logoOffset = 0;
    var fontOffset = parseInt(Lampa.Storage.get('ratings_font_offset', RCFG_DEFAULT.ratings_font_offset), 10);
    if (isNaN(fontOffset)) fontOffset = 0;
    var badgeAlpha = parseFloat(Lampa.Storage.get('ratings_badge_alpha', RCFG_DEFAULT.ratings_badge_alpha));
    if (isNaN(badgeAlpha)) badgeAlpha = RCFG_DEFAULT.ratings_badge_alpha;
    if (badgeAlpha < 0) badgeAlpha = 0;
    if (badgeAlpha > 1) badgeAlpha = 1;
    var badgeTone = parseInt(Lampa.Storage.get('ratings_badge_tone', RCFG_DEFAULT.ratings_badge_tone), 10);
    if (isNaN(badgeTone)) badgeTone = RCFG_DEFAULT.ratings_badge_tone;
    if (badgeTone < 0) badgeTone = 0;
    if (badgeTone > 255) badgeTone = 255;
    var gapStep = parseInt(Lampa.Storage.get('ratings_gap_step', RCFG_DEFAULT.ratings_gap_step), 10);
    if (isNaN(gapStep) || gapStep < 0) gapStep = 0;
    var colorizeAll = !!Lampa.Storage.field('ratings_colorize_all', RCFG_DEFAULT.ratings_colorize_all);
    var enIMDB = !!Lampa.Storage.field('ratings_enable_imdb', RCFG_DEFAULT.ratings_enable_imdb);
    var enTMDB = !!Lampa.Storage.field('ratings_enable_tmdb', RCFG_DEFAULT.ratings_enable_tmdb);
    var enMC = !!Lampa.Storage.field('ratings_enable_mc', RCFG_DEFAULT.ratings_enable_mc);
    var enRT = !!Lampa.Storage.field('ratings_enable_rt', RCFG_DEFAULT.ratings_enable_rt);
    var enPopcorn = !!Lampa.Storage.field('ratings_enable_popcorn', RCFG_DEFAULT.ratings_enable_popcorn);
    var posterBadges = !!Lampa.Storage.field('ratings_poster_badges', RCFG_DEFAULT.ratings_poster_badges);

    return {
      omdbKey: omdbKey || '',
      mdblistKey: mdblistKey || '',
      bwLogos: bwLogos,
      showAwards: showAwards,
      showAverage: showAverage,
      logoOffset: logoOffset,
      fontOffset: fontOffset,
      badgeAlpha: badgeAlpha,
      badgeTone: badgeTone,
      gapStep: gapStep,
      colorizeAll: colorizeAll,
      enableImdb: enIMDB,
      enableTmdb: enTMDB,
      enableMc: enMC,
      enableRt: enRT,
      enablePop: enPopcorn,
      enablePosterBadges: posterBadges
    };
  }

  /**
   * Синхронізує apiKeys + monochromeIcons у LMP_ENH_CONFIG
   */
  function refreshConfigFromStorage() {
    var cfg = getCfg();
    LMP_ENH_CONFIG.apiKeys.omdb = cfg.omdbKey || '';
    LMP_ENH_CONFIG.apiKeys.mdblist = cfg.mdblistKey || '';
    LMP_ENH_CONFIG.monochromeIcons = cfg.bwLogos;
    // Оновлюємо клас на body
    if (cfg.bwLogos) {
      $('body').addClass('lmp-enh--mono');
    } else {
      $('body').removeClass('lmp-enh--mono');
    }
    return cfg;
  }

  /**
   * Ховає/показує блоки з нагородами
   */
  function toggleAwards(showAwards) {
    var nodes = document.querySelectorAll('.rate--oscars, .rate--emmy, .rate--awards');
    nodes.forEach(function(n) {
      n.style.display = showAwards ? '' : 'none';
    });
  }

  /**
   * Ховає/показує блок середнього рейтингу
   */
  function toggleAverage(showAverage) {
    var nodes = document.querySelectorAll('.rate--avg');
    nodes.forEach(function(n) {
      n.style.display = showAverage ? '' : 'none';
    });
  }

  /**
   * Масштабує текстову частину рейтингу
   */
  function tuneRatingFont(offsetPx) {
    var off = parseFloat(offsetPx) || 0;
    var tiles = document.querySelectorAll('.full-start__rate');
    tiles.forEach(function(tile) {
      var prev = tile.style.fontSize;
      tile.style.fontSize = '';
      var basePx = parseFloat(getComputedStyle(tile).fontSize);
      if (isNaN(basePx)) basePx = 23;
      var finalPx = Math.max(1, basePx + off);
      tile.style.fontSize = finalPx + 'px';
    });
  }

  /**
   * Масштабує логотипи
   */
  function tuneLogos(offsetPx) {
    var REF_BASE = 28;
    var scale = (REF_BASE + (parseFloat(offsetPx) || 0)) / REF_BASE;
    if (scale < 0.1) scale = 0.1;

    var logos = document.querySelectorAll(
      '.full-start__rate .source--name img,' +
      '.rate--imdb > div:nth-child(2) img,' +
      '.rate--tmdb > div:nth-child(2) img,' +
      '.lmp-award-icon img'
    );

    function cssVarPx(name) {
      if (!name) return null;
      var raw = getComputedStyle(document.documentElement).getPropertyValue(name);
      var n = parseFloat(raw);
      return isNaN(n) ? null : n;
    }

    logos.forEach(function(img) {
      var varName = null;
      if (img.closest('.rate--imdb')) varName = '--lmp-h-imdb';
      else if (img.closest('.rate--tmdb')) varName = '--lmp-h-tmdb';
      else if (img.closest('.rate--mc')) varName = '--lmp-h-mc';
      else if (img.closest('.rate--rt')) varName = '--lmp-h-rt';
      else if (img.closest('.rate--popcorn')) varName = '--lmp-h-popcorn';
      else if (img.closest('.rate--awards')) varName = '--lmp-h-awards';
      else if (img.closest('.rate--avg')) varName = '--lmp-h-avg';
      else if (img.closest('.rate--oscars') || img.closest('.lmp-award-icon--oscar'))
        varName = '--lmp-h-oscar';
      else if (img.closest('.rate--emmy') || img.closest('.lmp-award-icon--emmy'))
        varName = '--lmp-h-emmy';

      var baseH = cssVarPx(varName);
      if (!baseH || baseH <= 0) baseH = 24; // Фолбек

      var finalH = Math.max(1, baseH * scale);
      img.style.height = finalH + 'px';
      img.style.maxHeight = finalH + 'px';
    });
  }

  /**
   * Оновлює прозорість та тон бекґраунду
   */
  function tuneBadgeBackground(tone, alpha) {
    var rgba = 'rgba(' + tone + ',' + tone + ',' + tone + ',' + alpha + ')';
    var tiles = document.querySelectorAll('.full-start__rate');
    tiles.forEach(function(tile) {
      tile.style.background = rgba;
      var firstDiv = tile.firstElementChild;
      if (firstDiv) {
        firstDiv.style.background = rgba;
      }
    });
  }

  /**
   * Задає відступи між плитками
   */
  function tuneGap(gapStep) {
    var lines = document.querySelectorAll('.full-start-new__rate-line');
    var totalEm = (0.3 + gapStep * 0.1); // 0.3 базово
    lines.forEach(function(line) {
      var kids = line.children;
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        child.style.setProperty('margin-right', totalEm + 'em', 'important');
      }
      if (line.lastElementChild) {
        line.lastElementChild.style.setProperty('margin-right', '0', 'important');
      }
    });
  }

  /**
   * Ч/Б логотипи (грейскейл)
   */
  function applyBwLogos(enabled) {
    var logos = document.querySelectorAll(
      '.full-start__rate .source--name img,' +
      '.rate--imdb > div:nth-child(2) img,' +
      '.rate--tmdb > div:nth-child(2) img,' +
      '.lmp-award-icon img'
    );
    var filterValue = enabled ? 'grayscale(100%)' : '';
    logos.forEach(function(node) {
      node.style.filter = filterValue;
    });
  }

  /**
   * Головна функція стилізації (застосовує все)
   */
  function applyStylesToAll() {
    var cfg = getCfg();
    // Оновлюємо body клас
    if (cfg.bwLogos) {
      $('body').addClass('lmp-enh--mono');
    } else {
      $('body').removeClass('lmp-enh--mono');
    }
    toggleAwards(cfg.showAwards);
    toggleAverage(cfg.showAverage);
    tuneRatingFont(cfg.fontOffset);
    tuneLogos(cfg.logoOffset);
    tuneBadgeBackground(cfg.badgeTone, cfg.badgeAlpha);
    tuneGap(cfg.gapStep);
    applyBwLogos(cfg.bwLogos);
  }

  /**
   * Патч Lampa.Storage для миттєвого застосування стилів
   */
  function patchStorageSetOnce() {
    if (window.__lmpRatingsPatchedStorage) return;
    window.__lmpRatingsPatchedStorage = true;

    var _set = Lampa.Storage.set;
    Lampa.Storage.set = function(k, v) {
      var out = _set.apply(this, arguments);
      if (typeof k === 'string' && k.indexOf('ratings_') === 0) {
        setTimeout(function() {
          applyStylesToAll();
        }, 0);
      }
      return out;
    };
  }

  /**
   * Debounce-обробник для resize
   */
  var reapplyOnResize = (function() {
    var t;
    return function() {
      clearTimeout(t);
      t = setTimeout(function() {
        applyStylesToAll();
      }, 150);
    };
  })();

  /**
   * Встановлює дефолтні значення для нових тумблерів
   */
  function ensureDefaultToggles() {
    if (typeof Lampa.Storage.get('ratings_show_awards') === 'undefined') {
      Lampa.Storage.set('ratings_show_awards', true);
    }
    if (typeof Lampa.Storage.get('ratings_show_average') === 'undefined') {
      Lampa.Storage.set('ratings_show_average', true);
    }
  }

  /**
   * "Живе" оновлення стилів при зміні в меню
   */
  function attachLiveSettingsHandlers() {
    var scheduleApply = (function() {
      var t;
      return function() {
        clearTimeout(t);
        t = setTimeout(function() {
          // 1) Спочатку оновлюємо дані/плитки (вкл/викл, кольори)
          try {
            if (typeof currentRatingsData === 'object' && currentRatingsData) {
              updateHiddenElements(currentRatingsData);
              insertRatings(currentRatingsData);
              calculateAverageRating(currentRatingsData);
            }
          } catch (e) {}
          // 2) Потім — стилі (шрифти, відступи, видимість)
          applyStylesToAll();
          // 3) Оновити/прибрати стікери на всіх картках
          try {
            refreshPosterBadgesGrid();
          } catch (e) {}
        }, 150);
      };
    })();

    function onDomChange(e) {
      var t = e.target;
      if (!t) return;
      var n = (t.getAttribute('name') || t.getAttribute('data-name') || '');
      if (n && n.indexOf('ratings_') === 0) scheduleApply();
    }

    document.addEventListener('input', onDomChange, true);
    document.addEventListener('change', onDomChange, true);
    document.addEventListener('click', function(e) {
      var el = e.target.closest('[data-name^="ratings_"],[name^="ratings_"]');
      if (el) scheduleApply();
    }, true);
    document.addEventListener('keyup', onDomChange, true);

    try {
      if (Lampa.SettingsApi && Lampa.SettingsApi.listener && Lampa.SettingsApi.listener.follow) {
        Lampa.SettingsApi.listener.follow('change', function(ev) {
          if (ev && ev.name && ev.name.indexOf('ratings_') === 0) scheduleApply();
        });
      }
    } catch (_) {}
  }

  /**
   * Оновлює стікери на всіх видимих картках (при зміні тумблера)
   */
  function refreshPosterBadgesGrid() {
    $('.card__view .card__lmerating').remove();
    var cfg = getCfg();
    if (!cfg.enablePosterBadges) return;

    $('.card').each(function() {
      var $card = $(this);
      var $view = $card.find('.card__view');
      var data = $card.data('card') || {};
      var type = data.number_of_seasons ? 'tv' : 'movie';
      var key = posterCacheKeyForCard({
        id: data.id,
        type: type,
        imdb_id: data.imdb_id
      });
      var cached = getCachedRatings(key);
      if (cached && cached._mdblist_ratings) {
        renderPosterBadgesFromRaw(cached._mdblist_ratings, $view);
      }
    });
  }

  /**
   * Слухач для рендеру стікерів на постерах у грідах
   */
  function wirePosterBadgesListener() {
    Lampa.Listener.follow('line', function(e) {
      if (e.type !== 'append') return;

      var cfg = getCfg();
      if (!cfg.enablePosterBadges) {
        // Вимкнули -> знімаємо з усіх
        e.items.forEach(function(it) {
          try {
            it.card.find('.card__view .card__lmerating').remove();
          } catch (_) {}
        });
        return;
      }

      e.items.forEach(function(it) {
        var data = it && it.data;
        var $view = it && it.card && it.card.find('.card__view');
        if (!data || !$view || !$view.length) return;

        var type = data.number_of_seasons ? 'tv' : 'movie';
        var key = posterCacheKeyForCard({
          id: data.id,
          type: type,
          imdb_id: data.imdb_id
        });

        // Є в кеші -> малюємо одразу
        var cached = getCachedRatings(key);
        if (cached && cached._mdblist_ratings) {
          renderPosterBadgesFromRaw(cached._mdblist_ratings, $view);
          return;
        }

        // Нема -> дотягуємо MDBList
        fetchMdbListRatings({
          id: data.id,
          type: type
        }, function(mdbRes) {
          if (mdbRes && mdbRes._mdblist_ratings) {
            saveCachedRatings(key, {
              _mdblist_ratings: mdbRes._mdblist_ratings
            });
            renderPosterBadgesFromRaw(mdbRes._mdblist_ratings, $view);
          }
        });
      });
    });
  }

  /**
   * Реєструє секцію "Рейтинги" у налаштуваннях
   */
  function addSettingsSection() {
    if (window.lmp_ratings_add_param_ready) return;
    window.lmp_ratings_add_param_ready = true;

    Lampa.SettingsApi.addComponent({
      component: 'lmp_ratings',
      name: 'Рейтинги',
      icon: '<svg width="24" height="24" viewBox="0 0 24 24" ' +
        'fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M12 3l3.09 6.26L22 10.27l-5 4.87L18.18 21 ' +
        '12 17.77 5.82 21 7 15.14l-5-4.87 6.91-1.01L12 3z" ' +
        'stroke="currentColor" stroke-width="2" ' +
        'fill="none" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>'
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_omdb_key',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_omdb_key
      },
      field: {
        name: 'API ключ (OMDb)',
        description: 'Введи свій ключ OMDb. Можна отримати на omdbapi.com'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_mdblist_key',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_mdblist_key
      },
      field: {
        name: 'API ключ (MDBList)',
        description: 'Введи свій ключ MDBList. Можна отримати на mdblist.com'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_bw_logos',
        type: 'trigger',
        values: '',
        "default": RCFG_DEFAULT.ratings_bw_logos
      },
      field: {
        name: 'Ч/Б логотипи',
        description: 'Чорно-білі логотипи рейтингів'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_show_awards',
        type: 'trigger',
        values: '',
        "default": RCFG_DEFAULT.ratings_show_awards
      },
      field: {
        name: 'Нагороди',
        description: 'Показувати Оскари, Еммі та інші нагороди.'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_show_average',
        type: 'trigger',
        values: '',
        "default": RCFG_DEFAULT.ratings_show_average
      },
      field: {
        name: 'Середній рейтинг',
        description: 'Показувати середній рейтинг'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_logo_offset',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_logo_offset
      },
      field: {
        name: 'Розмір логотипів рейтингів',
        description: 'Зміна висоти логотипів. \n"0" – стандарт, вводимо від "1" чи від "-1".'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_font_offset',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_font_offset
      },
      field: {
        name: 'Розмір числа рейтингу',
        description: 'Зміна розміру числа рейтингу та розміру фону. \n"0" – стандарт, вводимо від "1" чи від "-1".'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_badge_alpha',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_badge_alpha
      },
      field: {
        name: 'Прозорість фону під рейтингом',
        description: 'Прозорість фону. Стандартне значення: "0.15". \n"0" – прозорий, "1" – чорний.'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_badge_tone',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_badge_tone
      },
      field: {
        name: 'Яскравість плиток',
        description: 'Яскравість плиток. \n"0" – чорний. Від 0 до 255 (напр. "50" - темно-сірий).'
      },
      onRender: function(item) {}
    });

    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_gap_step',
        type: 'input',
        values: '',
        "default": RCFG_DEFAULT.ratings_gap_step
      },
      field: {
        name: 'Відступи між блоками (крок)',
        description: 'Додатковий відступ. "0" – стандарт (0.3em). \nЩоб збільшити - вводимо від "1"'
      },
      onRender: function(item) {}
    });

    // === Нові тумблери ===
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_colorize_all',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_colorize_all
      },
      field: {
        name: 'Кольорові оцінки рейтингів',
        description: 'Кольорове виділення оцінок рейтингів'
      },
      onRender: function() {}
    });
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_enable_imdb',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_enable_imdb
      },
      field: {
        name: 'IMDb',
        description: 'Показувати/ховати джерело'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_enable_tmdb',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_enable_tmdb
      },
      field: {
        name: 'TMDB',
        description: 'Показувати/ховати джерело'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_enable_mc',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_enable_mc
      },
      field: {
        name: 'Metacritic',
        description: 'Показувати/ховати джерело'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_enable_rt',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_enable_rt
      },
      field: {
        name: 'RottenTomatoes',
        description: 'Показувати/ховати джерело'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_enable_popcorn',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_enable_popcorn
      },
      field: {
        name: 'Popcornmeter',
        description: 'Показувати/ховати джерело'
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        name: 'ratings_poster_badges',
        type: 'trigger',
        "default": RCFG_DEFAULT.ratings_poster_badges
      },
      field: {
        name: 'Додаткові рейтинги на постері',
        description: 'Показувати наявні та додаткові рейтинги на постері'
      },
    });

    /* --- ДОДАНО: Кнопка очищення кешу --- */
    Lampa.SettingsApi.addParam({
      component: 'lmp_ratings',
      param: {
        type: 'button',
        component: 'lmp_clear_cache'
      },
      field: {
        name: 'Очистити кеш рейтингів'
      },
      onChange: function() {
        lmpRatingsClearCache();
      }
    });

  }

  /**
   * Ініціалізація UI налаштувань
   */
  function initRatingsPluginUI() {
    ensureDefaultToggles(); // Дефолтні значення для тумблерів
    addSettingsSection(); // Реєструємо секцію
    patchStorageSetOnce(); // Патч для миттєвого застосування
    attachLiveSettingsHandlers(); // "Живе" оновлення
    // Експорт утиліт
    window.LampaRatings = window.LampaRatings || {};
    window.LampaRatings.applyStyles = applyStylesToAll;
    window.LampaRatings.getConfig = getCfg;
    // Слухач для стікерів на постерах у грідах
    try {
      wirePosterBadgesListener();
    } catch (e) {}
    // Одразу застосувати стилі
    applyStylesToAll();
  }

  /*
  |==========================================================================
  | 9. ЗАПУСК (LAUNCH)
  |==========================================================================
  */

  /**
   * Ініціалізація (основний слухач)
   */
  function startPlugin() {
    window.combined_ratings_plugin = true;
    Lampa.Listener.follow('full', function(e) {
      if (e.type === 'complite') {
        setTimeout(function() {
          fetchAdditionalRatings(e.data.movie || e.object || {});
          __lmpTenFixStart(); // Запускаємо "фікс 10.0"
        }, 500);
      }
    });
  }

  // --- Початок виконання коду ---

  // 1. Додаємо CSS в DOM
  Lampa.Template.add('lmp_enh_styles', pluginStyles);
  $('body').append(Lampa.Template.get('lmp_enh_styles', {}, true));

  // 2. Ініціалізуємо UI налаштувань
  initRatingsPluginUI();

  // 3. Синхронізуємо конфіг (для Ч/Б класу на body)
  refreshConfigFromStorage();

  // 4. Додаємо слухачі на resize/orientation
  window.addEventListener('resize', reapplyOnResize);
  window.addEventListener('orientationchange', reapplyOnResize);

  // 5. Запускаємо основний слухач плагіну
  if (!window.combined_ratings_plugin) {
    startPlugin();
  }

})();
