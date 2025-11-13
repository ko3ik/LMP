(function () {
    'use strict';

    // ============================================================
    // ===      ЗАХИСТ ВІД ПОВТОРНОГО ЗАПУСКУ ПЛАГІНА           ===
    // ============================================================
    //
    if (window.SeasonBadgePlugin && window.SeasonBadgePlugin.__initialized) return;

    // Створюємо глобальний об'єкт плагіна (якщо його ще нема)
    window.SeasonBadgePlugin = window.SeasonBadgePlugin || {};
    window.SeasonBadgePlugin.__initialized = true;

    // ============================================================
    // ===  ПОЛІФІЛИ ДЛЯ СТАРИХ ANDROID TV / WEBVIEW            ===
    // ============================================================
    // --- [1] Promise (спрощений поліфіл) ---
    if (typeof window.Promise === 'undefined') {
        (function () {
            function SimplePromise(executor) {
                var self = this;
                self._state = 'pending';
                self._value = undefined;
                self._handlers = [];

                function fulfill(result) {
                    if (self._state !== 'pending') return;
                    self._state = 'fulfilled';
                    self._value = result;
                    runHandlers();
                }

                function reject(err) {
                    if (self._state !== 'pending') return;
                    self._state = 'rejected';
                    self._value = err;
                    runHandlers();
                }

                function runHandlers() {
                    // Викликаємо then/catch обробники асинхронно
                    setTimeout(function () {
                        var handlers = self._handlers.slice();
                        self._handlers = [];
                        for (var i = 0; i < handlers.length; i++) {
                            handle(handlers[i]);
                        }
                    }, 0);
                }

                function handle(handler) {
                    if (self._state === 'pending') {
                        self._handlers.push(handler);
                        return;
                    }

                    var cb = self._state === 'fulfilled' ? handler.onFulfilled : handler.onRejected;

                    if (!cb) {
                        if (self._state === 'fulfilled') {
                            handler.resolve(self._value);
                        } else {
                            handler.reject(self._value);
                        }
                        return;
                    }

                    try {
                        var ret = cb(self._value);
                        handler.resolve(ret);
                    } catch (e) {
                        handler.reject(e);
                    }
                }

                self.then = function (onFulfilled, onRejected) {
                    return new SimplePromise(function (resolve, reject) {
                        handle({
                            onFulfilled: typeof onFulfilled === 'function' ? onFulfilled : null,
                            onRejected: typeof onRejected === 'function' ? onRejected : null,
                            resolve: resolve,
                            reject: reject
                        });
                    });
                };

                self.catch = function (onRejected) {
                    return self.then(null, onRejected);
                };

                try {
                    executor(fulfill, reject);
                } catch (e) {
                    reject(e);
                }
            }

            window.Promise = SimplePromise;
        })();
    }

    // --- [2] requestAnimationFrame ---
    if (typeof window.requestAnimationFrame === 'undefined') {
        window.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 16); // ~60fps
        };
    }
    // --- [3] Element.matches / Element.closest ---
    (function () {
        if (!Element.prototype.matches) {
            Element.prototype.matches =
                Element.prototype.msMatchesSelector ||
                Element.prototype.webkitMatchesSelector ||
                function (selector) {
                    var node = this;
                    var matches = (node.document || node.ownerDocument).querySelectorAll(selector);
                    var i = matches.length;
                    while (i-- > 0 && matches.item(i) !== node) { }
                    return i > -1;
                };
        }

        if (!Element.prototype.closest) {
            Element.prototype.closest = function (selector) {
                var el = this;
                while (el && el.nodeType === 1) {
                    if (el.matches(selector)) return el;
                    el = el.parentElement || el.parentNode;
                }
                return null;
            };
        }
    })();
    // --- [4] safeStorage ---
    // safeStorage поводиться як localStorage, але:
    //  - спочатку пробує справжній localStorage;
    //  - якщо не вийшло — тримає дані в оперативній пам'яті (об'єкт).
    //
    var safeStorage = (function () {
        var memoryStore = {};
        try {
            if (typeof window.localStorage !== 'undefined') {
                var testKey = '__season_test__';
                window.localStorage.setItem(testKey, '1');
                window.localStorage.removeItem(testKey);
                return window.localStorage;
            }
        } catch (e) {
            // нічого, впадемо назад на пам'ять
        }

        return {
            getItem: function (k) {
                return memoryStore.hasOwnProperty(k) ? memoryStore[k] : null;
            },
            setItem: function (k, v) {
                memoryStore[k] = String(v);
            },
            removeItem: function (k) {
                delete memoryStore[k];
            }
        };
    })();

    // --- [5] safeFetch(url) ---
    //   - якщо є нормальний fetch -> використовуємо його
    //   - інакше -> XMLHttpRequest, але повертаємо "схожий" об'єкт з .json() і .text()
    function safeFetch(url) {
        if (typeof window.fetch === 'function') {
            return window.fetch(url);
        }

        return new Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        var status = xhr.status;
                        var respText = xhr.responseText;

                        var responseObj = {
                            ok: status >= 200 && status < 300,
                            status: status,
                            json: function () {
                                return new Promise(function (res, rej) {
                                    try {
                                        res(JSON.parse(respText));
                                    } catch (err) {
                                        rej(err);
                                    }
                                });
                            },
                            text: function () {
                                return new Promise(function (res) {
                                    res(respText);
                                });
                            }
                        };

                        if (status >= 200 && status < 300) {
                            resolve(responseObj);
                        } else {
                            reject(new Error('HTTP ' + status));
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
    // --- [6] createObserver(callback) ---
    // Якщо MutationObserver немає — повертаємо об'єкт-заглушку,
    // у якого є методи observe()/disconnect(), але які нічого не роблять.
    var NativeMutationObserver = window.MutationObserver ||
        window.WebKitMutationObserver ||
        window.MozMutationObserver;

    function createObserver(callback) {
        if (NativeMutationObserver) {
            return new NativeMutationObserver(callback);
        }
        return {
            observe: function () { /* no-op */ },
            disconnect: function () { /* no-op */ }
        };
    }

    // ============================================================
    // ===  НАЛАШТУВАННЯ ПЛАГІНА                                ===
    // ============================================================
    //
    // Тут зберігається вся конфігурація.
    // - tmdbApiKey: ключ TMDB (використовується і нашим XMLHttpRequest, і Lampa.TMDB.*)
    // - cacheTime:   скільки тримати дані в кеші (мілісекунди)
    // - enabled:     чи вмикати логіку взагалі
    // - language:    мова запитів до TMDB (наприклад 'uk', 'ru', 'en')
    //
    var CONFIG = {
        tmdbApiKey: '',     //✅ API ключ для доступу до TMDB
        cacheTime: 20 * 60 * 60 * 1000,                     //✅ Час зберігання кешу (20 годин)
        enabled: true,                                      // Активувати/деактивувати плагін
        language: 'uk'                                      // Мова для запитів до TMDB
    };

    // ============================================================
    // ===  ДОСТУП ДО TMDB З УРАХУВАННЯМ ОБМЕЖЕНИХ ТВ-БОКСІВ    ===
    // ============================================================
    // Ця функція не повертає значення напряму. Вона асинхронна через колбеки
    // resolve(data) / reject(err), бо нам треба працювати і в середовищах без async/await.
    //
    function tmdbGet(tvId, resolve, reject) {
        try {
            if (window.Lampa && Lampa.TMDB) {
                // ВАРІАНТ А: (id, success, error, params)
                if (typeof Lampa.TMDB.tv === 'function') {
                    Lampa.TMDB.tv(
                        tvId,
                        function (data) {
                            resolve(data);
                        },
                        function (err) {
                            reject(err || new Error('TMDB error via Lampa.TMDB.tv'));
                        },
                        { language: CONFIG.language }
                    );
                    return;
                }

                // ВАРІАНТ Б: ('tv/'+id, params, success, error)
                if (typeof Lampa.TMDB.get === 'function') {
                    Lampa.TMDB.get(
                        'tv/' + tvId,
                        {
                            language: CONFIG.language,
                            api_key: CONFIG.tmdbApiKey
                        },
                        function (data) {
                            resolve(data);
                        },
                        function (err) {
                            reject(err || new Error('TMDB error via Lampa.TMDB.get'));
                        }
                    );
                    return;
                }
            }
        } catch (e) {
            // Якщо всередині Lampa щось впало - спробуємо HTTP нижче
        }

        // ВАРІАНТ В: fallback = прямий HTTP-запит у TMDB
        var url =
            'https://api.themoviedb.org/3/tv/' + tvId +
            '?api_key=' + CONFIG.tmdbApiKey +
            '&language=' + CONFIG.language;

        safeFetch(url)
            .then(function (response) {
                return response.json();
            })
            .then(function (data) {
                resolve(data);
            })
            .catch(function (err) {
                reject(err);
            });
    }

    // ============================================================
    // ===  СТИЛІ ДЛЯ МІТОК СЕЗОНУ                              ===
    // ============================================================
    // Тут ми створюємо <style> і підклеюємо його в <head>.
    // У стилях є ДВА типи бейджів:
    //   .card--season-complete  – зелена мітка (сезон завершився)
    //   .card--season-progress  – червона/жовта мітка (сезон ще виходить)
    // Важливо:
    //  - ми позиціонуємо мітку біля лівого краю картки
    //  - тримаємо її над якістю (card__quality), щоб не перекривались
    //
    var style = document.createElement('style');
    style.textContent =
        "    /* Стиль для ЗАВЕРШЕНИХ сезонів (зелена мітка) */\n" +
        "    .card--season-complete {\n" +
        "        position: absolute;\n" +
        "        left: 0;\n" +
        "        margin-left: -0.65em; /*ВІДСТУП за лівий край*/\n" +
        "        bottom: 0.50em;\n" +
        "        background-color: rgba(61, 161, 141, 0.9);  /* Зелений фон (0.9 = трохи прозорий) */\n" +
        "        z-index: 12;\n" +
        "        width: fit-content;\n" +
        "        max-width: calc(100% - 1em);\n" +
        "        border-radius: 0.3em 0.3em 0.3em 0.3em;\n" +
        "        overflow: hidden;\n" +
        "        opacity: 0; /* спочатку приховано, потім .show зробить opacity:1 */\n" +
        "        transition: opacity 0.22s ease-in-out;\n" +
        "    }\n" +
        "\n" +
        "    /* Стиль для НЕЗАВЕРШЕНИХ сезонів (червона/жовта мітка) */\n" +
        "    .card--season-progress {\n" +
        "        position: absolute;\n" +
        "        left: 0;\n" +
        "        margin-left: -0.65em; /*ВІДСТУП за лівий край*/\n" +
        "        bottom: 0.50em;\n" +
        "        background-color: rgba(255, 66, 66, 1); /* Яскраво-червоний фон */\n" +
        "        z-index: 12;\n" +
        "        width: fit-content;\n" +
        "        max-width: calc(100% - 1em);\n" +
        "        border-radius: 0.3em 0.3em 0.3em 0.3em;\n" +
        "        overflow: hidden;\n" +
        "        opacity: 0; /* спочатку приховано */\n" +
        "        transition: opacity 0.22s ease-in-out;\n" +
        "    }\n" +
        "\n" +
        "    /* Спільні стилі тексту для обох типів міток */\n" +
        "    .card--season-complete div,\n" +
        "    .card--season-progress div {\n" +
        "        text-transform: uppercase;\n" +
        "        font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;  \n" +
        "        font-weight: 700;   /* жирний шрифт */\n" +
        "        font-size: 1.0em;   /* базовий розмір тексту мітки */\n" +
        "        padding: 0.39em 0.39em;  /* внутрішні відступи */\n" +
        "        white-space: nowrap;     /* не переносити рядок */\n" +
        "        display: flex;           /* flex для акуратного вирівнювання */\n" +
        "        align-items: center;     /* вертикальне вирівнювання контенту */\n" +
        "        gap: 4px;                /* відстань між частинами тексту */\n" +
        "        text-shadow: 0.5px 0.5px 1px rgba(0,0,0,0.3);\n" +
        "    }\n" +
        "\n" +
        "    /* Білий текст на зеленому фоні для завершених сезонів */\n" +
        "    .card--season-complete div {\n" +
        "        color: #ffffff;  /* контрастний текст */\n" +
        "    }\n" +
        "\n" +
        "    /* Білий текст на червоному тлі для сезону, що триває */\n" +
        "    .card--season-progress div {\n" +
        "        color: #ffffff;  /* можна змінити на #000000 якщо фон зробити світлим */\n" +
        "    }\n" +
        "\n" +
        "    /* Клас .show (додається з JS) робить мітку видимою */\n" +
        "    .card--season-complete.show,\n" +
        "    .card--season-progress.show {\n" +
        "        opacity: 1;  /* Повна видимість при показі */\n" +
        "    }\n" +
        "\n" +
        "    /* Адаптація для телевізорів / маленьких екранів */\n" +
        "    @media (max-width: 768px) {\n" +
        "        .card--season-complete div,\n" +
        "        .card--season-progress div {\n" +
        "            font-size: 0.95em;  /* трішки менший шрифт на малих екранах */\n" +
        "            padding: 0.35em 0.40em; /* менші відступи для маленьких карток */\n" +
        "        }\n" +
        "    }\n";
    document.head.appendChild(style);

    // ============================================================
    // ===  ДОПОМІЖНІ ФУНКЦІЇ                                   ===
    // ============================================================
    /* Визначає тип медіа (серіал / фільм / невідомо) на основі card_data,
     * яке Lampa підсовує картці .card як cardEl.card_data.
     *
     * @param {Object} cardData - дані картки від Lampa
     * @returns {string} - 'tv', 'movie' або 'unknown'
     */
    function getMediaType(cardData) {
        // Якщо даних немає — не ризикуємо
        if (!cardData) return 'unknown';

        // Серіал: зазвичай має name або first_air_date
        if (cardData.name || cardData.first_air_date) return 'tv';

        // Фільм: зазвичай має title або release_date
        if (cardData.title || cardData.release_date) return 'movie';

        // Інакше не ясно
        return 'unknown';
    }

    // ============================================================
    // ===  КЕШ ДАНИХ TMDB                                      ===
    // ============================================================
    // Щоб не ходити в TMDB кожен раз для одного і того ж серіалу,
    // ми кешуємо результат в safeStorage (або localStorage, якщо він робочий).
    // Потім у fetchSeriesData() ми перевіряємо, чи кеш ще "свіжий".
    //
    var cacheRaw = safeStorage.getItem('seasonBadgeCache') || '{}';
    var cache;
    try {
        cache = JSON.parse(cacheRaw) || {};
    } catch (e) {
        cache = {};
    }

    // ============================================================
    // ===  ЗАВАНТАЖЕННЯ ДАНИХ СЕРІАЛУ З TMDB З УРАХУВАННЯМ КЕШУ ===
    // ============================================================
    /*
     * Завантажує дані серіалу з TMDB,
     * з урахуванням кешу щоб зменшити кількість запитів.
     * @param {number} tmdbId - ID серіалу в TMDB
     * @returns {Promise} - проміс, що поверне об'єкт з даними серіалу
     */
    function fetchSeriesData(tmdbId) {
        return new Promise(function (resolve, reject) {
            var now = (new Date()).getTime();

            // 1. Перевіряємо кеш
            if (cache[tmdbId] && (now - cache[tmdbId].timestamp < CONFIG.cacheTime)) {
                resolve(cache[tmdbId].data);
                return;
            }

            // 2. Перевіряємо, чи є валідний ключ TMDB
            if (!CONFIG.tmdbApiKey || CONFIG.tmdbApiKey === 'ваш_tmdb_api_key_тут') {
                reject(new Error('Будь ласка, вставте коректний TMDB API ключ'));
                return;
            }

            // 3. Робимо реальний запит (через Lampa або напряму)
            tmdbGet(
                tmdbId,
                function (data) {
                    // TMDB іноді повертає { success:false, status_message:"..." } якщо помилка
                    if (data && data.success === false) {
                        reject(new Error(data.status_message || 'TMDB API error'));
                        return;
                    }

                    // 4. Оновлюємо кеш
                    cache[tmdbId] = {
                        data: data,
                        timestamp: now
                    };
                    try {
                        safeStorage.setItem('seasonBadgeCache', JSON.stringify(cache));
                    } catch (e) {
                        // На дуже кривих пристроях safeStorage може бути тільки-пам'ять,
                        // тоді setItem нічого страшного не зробить.
                    }

                    resolve(data);
                },
                function (err) {
                    reject(err);
                }
            );
        });
    }

    // ============================================================
    // ===  ОБЧИСЛЕННЯ ПРОГРЕСУ ОСТАННЬОГО СЕЗОНУ               ===
    // ============================================================
    /*
     * На основі відповіді TMDB ми дізнаємось:
     *  - який зараз актуальний сезон
     *  - скільки серій вже вийшло
     *  - скільки заплановано всього
     *  - чи сезон вже повністю вийшов
     *
     * @param {Object} tmdbData - повна інформація про серіал з TMDB
     * @returns {Object|false}  - об'єкт формату:
     *    {
     *       seasonNumber: <номер сезону>,
     *       airedEpisodes: <к-сть випущених епізодів>,
     *       totalEpisodes: <к-сть всього епізодів>,
     *       isComplete: <true/false>
     *    }
     *    або false, якщо не вдалося визначити.
     */
    function getSeasonProgress(tmdbData) {
        if (!tmdbData || !tmdbData.seasons || !tmdbData.last_episode_to_air) return false;

        // last_episode_to_air = остання серія, що реально вийшла в ефір
        var lastEpisode = tmdbData.last_episode_to_air;

        // Шукаємо повний опис сезону серед tmdbData.seasons
        // (важливо: ігноруємо сезон 0 — зазвичай це "specials")
        var currentSeason = null;
        for (var i = 0; i < tmdbData.seasons.length; i++) {
            var s = tmdbData.seasons[i];
            if (s.season_number === lastEpisode.season_number && s.season_number > 0) {
                currentSeason = s;
                break;
            }
        }

        if (!currentSeason) return false;

        // Кількість серій у всьому сезоні (за даними TMDB)
        var totalEpisodes = currentSeason.episode_count || 0;

        // Номер останньої випущеної серії
        var airedEpisodes = lastEpisode.episode_number || 0;

        return {
            seasonNumber: lastEpisode.season_number,         // Номер сезону (наприклад 1)
            airedEpisodes: airedEpisodes,                    // Скільки серій вийшло (наприклад 5)
            totalEpisodes: totalEpisodes,                    // Скільки серій всього (наприклад 10)
            isComplete: airedEpisodes >= totalEpisodes       // true якщо сезон завершений
        };
    }

    // ============================================================
    // ===  СТВОРЕННЯ DOM-ЕЛЕМЕНТА МІТКИ                        ===
    // ============================================================
    /*
     * Створює HTML-елемент мітки сезону.
     *
     * @param {string} content   - текст усередині мітки ("S1 5/10" або "S1")
     * @param {boolean} isComplete - чи завершений сезон
     * @param {boolean} loading    - тимчасова мітка очікування (поки вантажимо)
     * @returns {HTMLElement}
     */
    function createBadge(content, isComplete, loading) {
        // 1. Створюємо сам контейнер <div>
        var badge = document.createElement('div');

        // 2. Визначаємо потрібний базовий клас:
        //    - .card--season-complete  (зелений, завершено)
        //    - .card--season-progress  (червоний/жовтий, ще виходить)
        var badgeClass = isComplete ? 'card--season-complete' : 'card--season-progress';

        // 3. Ставимо className (додаємо 'loading', якщо це тимчасова заглушка)
        badge.className = badgeClass + (loading ? ' loading' : '');

        // 4. Вставляємо внутрішній <div> з текстом
        badge.innerHTML = '<div>' + content + '</div>';

        return badge;
    }

    // ============================================================
    // ===  ПОЗИЦІОНУВАННЯ МІТКИ В КАРТЦІ                      ===
    // ============================================================
    /*
     * Виставляє .style.bottom для мітки сезону так, щоб:
     *  - якщо є .card__quality (HD/4K і т.д.) — ми розміщуємо наш бейдж вище неї
     *  - якщо ні — ставимо стандартний відступ віднизу
     *
     * @param {HTMLElement} cardEl - елемент .card (картка)
     * @param {HTMLElement} badge  - елемент нашої мітки
     */
    function adjustBadgePosition(cardEl, badge) {
        if (!cardEl || !badge) return;

        // Шукаємо блок якості відео, який Lampa вставляє у картку (.card__quality)
        var quality = cardEl.querySelector('.card__quality');

        if (quality) {
            // ВИПАДОК 1: у картки є мітка якості (наприклад "1080p")
            //
            // Нам треба підняти мітку сезону так, щоб вона була вище якості
            // і не перекривала її.
            var qHeight = quality.offsetHeight;
            var qBottom = 0;

            // Дізнаємося відступ .card__quality знизу (css може рухати її)
            if (window.getComputedStyle) {
                var styleVal = window.getComputedStyle(quality).bottom;
                if (styleVal) {
                    qBottom = parseFloat(styleVal) || 0;
                }
            }

            // Тепер ставимо .bottom для нашого бейджа = висота якості + її відступ
            badge.style.bottom = (qHeight + qBottom) + 'px';
        } else {
            // ВИПАДОК 2: в картки взагалі немає мітки якості
            //
            // У такому випадку нашу мітку можна розмістити просто біля низу картки.
            badge.style.bottom = '0.50em'; // Стандартний нижній відступ
        }
    }

    /**
     * Оновлює позицію КОЖНОЇ мітки сезону всередині однієї картки.
     * Викликається, коли змінюється .card__quality (додали / видалили / оновили).
     *
     * @param {HTMLElement} cardEl - елемент .card
     */
    function updateBadgePositions(cardEl) {
        if (!cardEl) return;

        // Збираємо ВСІ наші мітки в картці (зелена і червона)
        var badgesNodeList = cardEl.querySelectorAll('.card--season-complete, .card--season-progress');
        var badgesArr = Array.prototype.slice.call(badgesNodeList, 0);

        // Для кожної мітки перерахуємо правильну позицію
        for (var i = 0; i < badgesArr.length; i++) {
            adjustBadgePosition(cardEl, badgesArr[i]);
        }
    }

    // ============================================================
    // ===  СПОСТЕРЕЖЕННЯ ЗА МІТКОЮ ЯКОСТІ В КАРТЦІ             ===
    // ============================================================
    //
    // Цей observer підписується на .card__view (всередині конкретної картки)
    // і стежить за тим, чи з'явилась або зникла мітка якості .card__quality.
    var qualityObserver = createObserver(function (mutations) {
        // Перебираємо всі зміни в DOM усередині однієї картки
        for (var i = 0; i < mutations.length; i++) {
            var mutation = mutations[i];

            // --- Випадок: додані вузли (наприклад, з'явилась нова .card__quality)
            if (mutation.addedNodes && mutation.addedNodes.length) {
                for (var j = 0; j < mutation.addedNodes.length; j++) {
                    var addedNode = mutation.addedNodes[j];
                    if (addedNode.classList && addedNode.classList.contains('card__quality')) {
                        var parentCardA = addedNode.closest('.card');
                        if (parentCardA) {
                            // Трошки зачекаємо, щоб розміри DOM устаканилися
                            setTimeout(
                                (function (cardCopyA) {
                                    return function () {
                                        updateBadgePositions(cardCopyA);
                                    };
                                })(parentCardA),
                                100
                            );
                        }
                    }
                }
            }

            // --- Випадок: видалені вузли (наприклад, якість перестала показуватись)
            if (mutation.removedNodes && mutation.removedNodes.length) {
                for (var k = 0; k < mutation.removedNodes.length; k++) {
                    var removedNode = mutation.removedNodes[k];
                    if (removedNode.classList && removedNode.classList.contains('card__quality')) {
                        var parentCardB = removedNode.closest('.card');
                        if (parentCardB) {
                            setTimeout(
                                (function (cardCopyB) {
                                    return function () {
                                        updateBadgePositions(cardCopyB);
                                    };
                                })(parentCardB),
                                100
                            );
                        }
                    }
                }
            }
        }
    });

    // ============================================================
    // ===  ДОДАЄМО МІТКУ СЕЗОНУ В КОНКРЕТНУ КАРТКУ .card       ===
    // ============================================================
    /**
     * Основна функція, яка:
     *  1. перевіряє, чи це взагалі серіал (бо для фільмів сезони не потрібні)
     *  2. створює тимчасову мітку "..." поки ми вантажимо інфу з TMDB
     *  3. після завантаження оновлює мітку з реальними даними
     *
     * @param {HTMLElement} cardEl - DOM-елемент картки .card
     */
    function addSeasonBadge(cardEl) {
        // Перевірка на сторонній випадок: немає самої картки або вже оброблено
        if (!cardEl) return;
        if (cardEl.hasAttribute('data-season-processed')) return;

        // Інколи Lampa ще не встигла підкласти card_data в картку.
        // У такому випадку ми дочекаємось наступного кадру і повторимо.
        if (!cardEl.card_data) {
            requestAnimationFrame(function () {
                addSeasonBadge(cardEl);
            });
            return;
        }

        // Дані картки від Lampa
        var data = cardEl.card_data;

        // Працюємо ТІЛЬКИ з серіалами
        if (getMediaType(data) !== 'tv') return;

        // Знаходимо внутрішній контейнер, куди будемо клеїти мітку сезону
        var view = cardEl.querySelector('.card__view');
        if (!view) return;

        // 1. Прибираємо старі мітки, щоб не плодити дублікатів
        var oldBadgesNodeList = view.querySelectorAll('.card--season-complete, .card--season-progress');
        var oldBadgesArr = Array.prototype.slice.call(oldBadgesNodeList, 0);
        for (var i = 0; i < oldBadgesArr.length; i++) {
            if (oldBadgesArr[i] && oldBadgesArr[i].parentNode) {
                oldBadgesArr[i].parentNode.removeChild(oldBadgesArr[i]);
            }
        }

        // 2. Створюємо тимчасову мітку "..." поки вантажимо дані
        //    (використовуємо стиль "progress", але з контентом '...')
        var badge = createBadge('...', false, true);
        view.appendChild(badge);

        // --- ВИКЛИК 1: одразу пробуємо вирівняти мітку відносно card__quality
        adjustBadgePosition(cardEl, badge);

        // 3. Підписуємося на зміни в цій картці (плюс/мінус card__quality)
        //    Це дозволяє динамічно піднімати нашу мітку вище.
        try {
            qualityObserver.observe(view, {
                childList: true,
                subtree: true
            });
        } catch (e) {
            // Якщо MutationObserver відсутній (дуже старий WebView),
            // createObserver() вернув no-op, тож сюди можемо навіть не доходити.
        }

        // Позначаємо картку як "в процесі"
        cardEl.setAttribute('data-season-processed', 'loading');

        // 4. Тягнемо дані з TMDB (через кеш і tmdbGet)
        fetchSeriesData(data.id)
            .then(function (tmdbData) {
                var progressInfo = getSeasonProgress(tmdbData);

                // Якщо вдалося порахувати прогрес
                if (progressInfo) {
                    var isComplete = progressInfo.isComplete;
                    var content = '';

                    if (isComplete) {
                        // ДЛЯ ЗАВЕРШЕНИХ СЕЗОНІВ:
                        // приклад: "S1"
                        content = "S" + progressInfo.seasonNumber;
                    } else {
                        // ДЛЯ ПОТОЧНИХ / НЕЗАВЕРШЕНИХ СЕЗОНІВ:
                        // приклад: "S1 5/10"
                        content =
                            "S" + progressInfo.seasonNumber + " " +
                            progressInfo.airedEpisodes + "/" +
                            progressInfo.totalEpisodes;
                    }

                    // Оновлюємо клас мітки (зелена або червона)
                    badge.className = isComplete ? 'card--season-complete' : 'card--season-progress';

                    // Оновлюємо вміст мітки
                    badge.innerHTML = '<div>' + content + '</div>';

                    // --- ВИКЛИК 2: після зміни тексту ще раз підрівнюємо позицію
                    adjustBadgePosition(cardEl, badge);

                    // 5. Робимо плавну появу (додаємо .show з невеликою затримкою)
                    setTimeout(function () {
                        if (badge.classList) {
                            badge.classList.add('show');
                        } else {
                            // (на дуже старих WebView classList може не бути)
                            badge.className += ' show';
                        }

                        // --- ВИКЛИК 3: фінальне вирівнювання, коли мітка вже видима
                        adjustBadgePosition(cardEl, badge);
                    }, 50);

                    // Ставимо фінальний статус картці
                    cardEl.setAttribute(
                        'data-season-processed',
                        isComplete ? 'complete' : 'in-progress'
                    );
                } else {
                    // Якщо не вдалося отримати інформацію
                    if (badge && badge.parentNode) {
                        badge.parentNode.removeChild(badge);
                    }
                    cardEl.setAttribute('data-season-processed', 'error');
                }
            })
            .catch(function (error) {
                // Помилка отримання даних (немає інтернету / CORS / немає TMDB тощо)
                try {
                    console.log('SeasonBadgePlugin помилка:', error && error.message ? error.message : error);
                } catch (eLog) { }

                if (badge && badge.parentNode) {
                    badge.parentNode.removeChild(badge);
                }
                cardEl.setAttribute('data-season-processed', 'error');
            });
    }

    // ============================================================
    // ===  ГЛОБАЛЬНИЙ OBSERVER ДЛЯ DOM (ВИЯВЛЕННЯ НОВИХ КАРТОК) ===
    // ============================================================
    //
    // Цей observer слідкує за тим, коли Lampa додає нові елементи .card
    // (наприклад, при прокрутці або зміні екранів).
    var observer = createObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var mutation = mutations[i];

            // Перебираємо всі додані DOM-вузли
            if (mutation.addedNodes && mutation.addedNodes.length) {
                for (var j = 0; j < mutation.addedNodes.length; j++) {
                    var node = mutation.addedNodes[j];

                    // Переконуємось, що це елемент (nodeType === 1), не текстовий вузол
                    if (!node || node.nodeType !== 1) continue;

                    // ВИПАДОК 1: безпосередньо додали .card
                    if (node.classList && node.classList.contains('card')) {
                        addSeasonBadge(node);
                    }

                    // ВИПАДОК 2: додали контейнер, всередині якого вже є кілька .card
                    if (typeof node.querySelectorAll === 'function') {
                        var innerCardsNodeList = node.querySelectorAll('.card');
                        var innerCardsArr = Array.prototype.slice.call(innerCardsNodeList, 0);

                        for (var k = 0; k < innerCardsArr.length; k++) {
                            addSeasonBadge(innerCardsArr[k]);
                        }
                    }
                }
            }
        }
    });

    // ============================================================
    // ===  РЕАКЦІЯ НА ЗМІНУ РОЗМІРУ ВІКНА/ЕКРАНУ               ===
    // ============================================================
    // Тому на події resize() проходимо по всіх існуючих бейджах
    // і перевиставляємо їм bottom.
    //
    window.addEventListener('resize', function () {
        var allBadgesNodeList = document.querySelectorAll('.card--season-complete, .card--season-progress');
        var allBadgesArr = Array.prototype.slice.call(allBadgesNodeList, 0);

        for (var i = 0; i < allBadgesArr.length; i++) {
            var badge = allBadgesArr[i];
            var cardEl = badge.closest('.card');
            if (cardEl) {
                adjustBadgePosition(cardEl, badge);
            }
        }
    });

    // ============================================================
    // ===  INIT PLUGIN (ПЕРВИННИЙ ЗАПУСК)                      ===
    // ============================================================
    /**
     * Ця функція:
     *  1. включає глобальний DOM-спостерігач (observer)
     *  2. одразу обробляє всі вже наявні картки .card на екрані
     */
    function initPlugin() {
        if (!CONFIG.enabled) return; // якщо в конфізі вимкнено - нічого не робимо

        // Ми намагаємось підписатися на всі контейнери,
        // щоб обробляти догрузку контенту без повної перезагрузки сторінки.
        //
        var containersNodeList = document.querySelectorAll(
            '.cards, .card-list, .content, .main, .cards-list, .preview__list'
        );
        var containersArr = Array.prototype.slice.call(containersNodeList, 0);

        if (containersArr.length > 0) {
            for (var i = 0; i < containersArr.length; i++) {
                var containerEl = containersArr[i];
                try {
                    observer.observe(containerEl, {
                        childList: true,
                        subtree: true
                    });
                } catch (e) {
                    // Якщо MutationObserver у цій збірці не працює (дуже старий WebView),
                    // createObserver повернув заглушку - тоді .observe може кинути.
                    // У такому випадку просто падаємо назад на спостереження за body.
                    try {
                        observer.observe(document.body, {
                            childList: true,
                            subtree: true
                        });
                    } catch (e2) { }
                }
            }
        } else {
            // Якщо ми не знайшли специфічних контейнерів,
            // просто дивимось за всім документом.
            try {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            } catch (e3) { }
        }

        // --- 2. Обробляємо картки, які ВЖЕ є на сторінці ---
        var existingCardsNodeList = document.querySelectorAll('.card:not([data-season-processed])');
        var existingCardsArr = Array.prototype.slice.call(existingCardsNodeList, 0);

        for (var idx = 0; idx < existingCardsArr.length; idx++) {
            (function (card, delay) {
                setTimeout(function () {
                    addSeasonBadge(card);
                }, delay);
            })(existingCardsArr[idx], idx * 300);
        }
    }

    // ============================================================
    // ===  СИСТЕМА ЗАПУСКУ ПЛАГІНА                             ===
    // ============================================================
    // 1) Якщо глобальний прапор window.appready вже true — Lampa повністю
    //    ініціалізована, можна викликати initPlugin() прямо зараз.
    //
    // 2) Якщо Lampa підтримує Lampa.Listener.follow('app', ...) —
    //    тоді чекаємо подію { type: 'ready' } і тільки потім стартуємо.
    //
    // 3) Резерв: якщо ми ні про що не знаємо — пробуємо стартонуть через ~2с.
    //
    if (window.appready) {
        // ВАРІАНТ 1: додаток вже готовий
        initPlugin();
    } else if (window.Lampa && Lampa.Listener) {
        // ВАРІАНТ 2: Lampa сама кине подію 'ready'
        try {
            Lampa.Listener.follow('app', function (e) {
                if (e && e.type === 'ready') initPlugin();
            });
        } catch (e) {
            // Якщо щось не так з Listener — застосуємо резерв
            setTimeout(initPlugin, 2000);
        }
    } else {
        // ВАРІАНТ 3: РЕЗЕРВ
        setTimeout(initPlugin, 2000);
    }




/* ===== Seasons Progress Badges — Settings (Інтерфейс → "Мітки прогресу серій/сезонів") ===== */
(function(){
  'use strict';

  var SETTINGS_KEY='sbadger_settings_v1';
  var st;

  function sbToast(msg){
    try{ if (Lampa && Lampa.Noty) return Lampa.Noty(msg); }catch(e){}
    var id='sbadger_toast', el=document.getElementById(id);
    if(!el){
      el=document.createElement('div');
      el.id=id;
      el.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:2rem;padding:.6rem 1rem;background:rgba(0,0,0,.85);color:#fff;border-radius:.5rem;z-index:9999;font-size:14px;transition:opacity .2s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent=msg; el.style.opacity='1';
    setTimeout(function(){ el.style.opacity='0'; },1300);
  }

  function load(){ var s=Lampa.Storage.get(SETTINGS_KEY)||{}; return { tmdb_key: s.tmdb_key || '' }; }
  function apply(){ if (st.tmdb_key) CONFIG.tmdbApiKey = String(st.tmdb_key).trim(); }
  function save(){ Lampa.Storage.set(SETTINGS_KEY, st); apply(); sbToast('Збережено'); }

  function clearCache(){
    try{
      if (window.safeStorage?.removeItem) safeStorage.removeItem('seasonBadgeCache');
      else if (window.localStorage) localStorage.removeItem('seasonBadgeCache');
    }catch(e){}
    sbToast('Кеш очищено');
  }

  // ❗ Порожній шаблон
  Lampa.Template.add('settings_sbadger','<div></div>');

  function registerUI(){
    // Кнопка-вхід у підменю
    Lampa.SettingsApi.addParam({
      component:'interface',
      param:{ type:'button', component:'sbadger' },
      field:{ name:'Мітки прогресу серій/сезонів', description:'Налаштування бейджів прогресу серій та сезонів' },
      onChange:function(){
        Lampa.Settings.create('sbadger', {
          template:'settings_sbadger',
          onBack:function(){ Lampa.Settings.create('interface'); }
        });
      }
    });

    // Поле TMDB API ключа — одразу зберігає й застосовує
    Lampa.SettingsApi.addParam({
      component:'sbadger',
      param:{ name:'sbadger_tmdb_key', type:'input', values:'', "default": (st.tmdb_key||'') },
      field:{ name:'TMDB API ключ', description:'Потрібен для отримання даних про сезони. Можна отримати на themoviedb.org' },
      onRender:function(item){ try{ $(item).find('input').attr('placeholder','встав ключ TMDB'); }catch(e){} },
      onChange:function(v){ st.tmdb_key = String(v||'').trim(); save(); }
    });

    // Очистити кеш
    Lampa.SettingsApi.addParam({
      component:'sbadger',
      param:{ type:'button', component:'sbadger_clear_cache' },
      field:{ name:'Очистити кеш' },
      onChange: clearCache
    });
  }  
  function start(){ 
      st=load(); 
      apply(); 
      
      if (Lampa?.SettingsApi?.addParam) {
          // !!! ЗАСТОСУВАТИ ЗМІНУ ТУТ: обгортаємо виклик у setTimeout(..., 0)
          setTimeout(registerUI, 0); 
      }
  }
  
  if (window.appready) start();
  else if (Lampa?.Listener) Lampa.Listener.follow('app', e=>{ if(e.type==='ready') start(); });
})();



    
    
})();
