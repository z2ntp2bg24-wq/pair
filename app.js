/* Pair PWA — offline-first · multi-deck */
(() => {
  "use strict";

  const BUILD = "v29";
  // index.html and app.js must be the same build. A mixed pair (stale cache) heals itself once: drop the
  // code caches (never the data) and reload. See also the inline recovery screen in index.html.
  if (window.__PAIR_BUILD && window.__PAIR_BUILD !== BUILD) {
    let tried = false;
    try {
      tried = sessionStorage.getItem("pair_heal") === BUILD;
      sessionStorage.setItem("pair_heal", BUILD);
    } catch (_) {}
    if (!tried && window.__pairClearCodeCaches) {
      window.__pairClearCodeCaches().then(() => location.reload());
    } else if (window.__pairRecovery) {
      window.__pairRecovery("页面文件版本不一致（" + window.__PAIR_BUILD + " / " + BUILD + "）", true);
    }
    return;
  }

  const DB_NAME = "ebbinghaus-pwa";
  const DB_VER = 2;
  const TIME_OPTIONS = [5, 10, 15, 20, 30, 60, 0]; // seconds per question; 0 = 不限时
  const TIME_DEFAULT = 10;
  const BAD_PAUSE_OPTIONS = [0, 1, 2, 3, 5, 8, 10]; // seconds to stay after wrong/timeout; 0 = almost immediate
  const BAD_PAUSE_DEFAULT = 5;
  const SETTINGS_KEY = "pair_settings_v1"; // { timeLimit, badPause, rand, t } — synced + in backups
  const CHANGELOG_KEY = "pair_seen_changelog"; // last BUILD the user dismissed
  const ROUND_KEY = "pair_round_v1"; // { practice|study: unfinished sequential round } — survives reload
  const ROUND_TTL_MS = 24 * 3600 * 1000;
  const RAND_QUICK = [50, 100, 200, 300, 500];
  const RAND_DEFAULT_N = 100;
  const RAND_MAX_N = 5000;
  const BANK_PAGE = 50;
  const PRELOAD_META_KEY = "preload_v1";
  const DEFAULT_DECK_NAME = "动车组机械师";
  const LEGACY_DEFAULT_NAME = "默认题库";
  const SESSION_DECK_KEY = "ebbinghaus_current_deck";
  const SEQ_META_KEY = "ebbinghaus_seq_meta"; // legacy single cursor (migrated once)
  const CURSORS_KEY = "ebbinghaus_cursors_v2"; // { deckId: { study, practice } }
  const CURSOR_KINDS = ["study", "practice"];
  const SYNC_BASE_KEY = "pair_sync_base_at"; // remote updatedAt we last synced with
  const SYNC_CODE_KEY = "pair_sync_code";
  const SYNC_UPDATED_AT_KEY = "pair_sync_updated_at";
  const SYNC_VERSION = 1;
  const SYNC_PUSH_DEBOUNCE_MS = 2000;

  const KEYS = "ABCDEF";
  const FLASH_MS_OK = 500;
  const EBBINGHAUS_LADDER = [1, 2, 4, 7, 15, 30];

  /** @type {IDBDatabase|null} */
  let idb = null;
  let route = "exams";
  /** @type {number|null} */
  let currentDeckId = null;
  /** @type {any[]} */
  let queue = [];
  let queueMode = "due";
  /** @type {number|null} last study/seq batch size; null = to end */
  let studyCount = 20;
  /** last sequential start options for 「再背/再刷一轮」 */
  let seqSession = { fromStart: false, useLast: false, n: 20 };
  /** true while the current sequential session should move its cursor (false for replays/redo) */
  let seqMove = false;
  /** true when current timed round is 「重做本轮错题」 */
  let roundIsRedo = false;
  /** current sequential batch info: { start, count, total } */
  let seqBatch = { start: 0, count: 0, total: 0 };
  const ACC_PASS = 75;
  const MORE_N = 50;
  let qIndex = 0;
  let timerLeft = 0;
  /** per-index answers of the current timed round: null | { r: "ok"|"bad"|"to", p: picked letter|null } */
  let roundAns = [];
  /** per-index 「已看」 flags of the current 背题 batch */
  let studySeen = [];
  let boardOpen = false;
  /** auto-advance that came due while the 题板 was open; runs when it closes */
  let pendingAdvance = null;
  let timerId = null;
  let advanceTimerId = null;
  let answering = false;
  let bankOffset = 0;
  let bankQuery = "";
  /** @type {any[]} */
  let bankCache = [];

  const $ = (sel, el = document) => el.querySelector(sel);
  const app = () => $("#app");

  // ---------- SM-2 ----------
  function ladderLabel(intervalDays) {
    if (intervalDays <= 0) return "今天 / 即将";
    for (const d of EBBINGHAUS_LADDER) {
      if (intervalDays <= d) return `${d}天`;
    }
    return "30天+";
  }

  function schedule(rating, easiness = 2.5, intervalDays = 0, repetitions = 0) {
    let ef = Number(easiness);
    let interval = Number(intervalDays) | 0;
    let reps = Number(repetitions) | 0;

    if (rating === "again") {
      reps = 0;
      interval = 0;
      ef = Math.max(1.3, ef - 0.2);
    } else if (rating === "hard") {
      interval = interval > 0 ? Math.max(1, Math.round(interval * 1.2)) : 1;
      ef = Math.max(1.3, ef - 0.15);
    } else if (rating === "good") {
      if (reps === 0) interval = 1;
      else if (reps === 1) interval = 3;
      else if (reps === 2) interval = 4;
      else if (reps === 3) interval = 7;
      else if (reps === 4) interval = 15;
      else if (reps === 5) interval = 30;
      else interval = Math.max(1, Math.round(interval * ef));
      reps += 1;
    } else if (rating === "easy") {
      if (reps === 0) interval = 2;
      else if (reps === 1) interval = 4;
      else interval = Math.max(1, Math.round(Math.max(interval, 1) * ef * 1.3));
      ef = ef + 0.15;
      reps += 1;
    } else {
      throw new Error("未知评分: " + rating);
    }

    const nextAt = new Date(Date.now() + interval * 86400000);
    return {
      easiness: Math.round(ef * 100) / 100,
      interval_days: interval | 0,
      repetitions: reps | 0,
      next_review_at: formatIso(nextAt),
      last_result: rating,
      ladder_label: ladderLabel(interval),
    };
  }

  function formatIso(d) {
    const pad = (n) => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const oh = pad(Math.floor(Math.abs(off) / 60));
    const om = pad(Math.abs(off) % 60);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `${sign}${oh}:${om}`
    );
  }
  function nowIso() {
    return formatIso(new Date());
  }

  // ---------- Dedupe ----------
  function normalizeWhitespace(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  }
  function dedupeKey(stem, answer) {
    return normalizeWhitespace(stem) + "\0" + normalizeWhitespace(answer).toLowerCase();
  }

  // ---------- IndexedDB ----------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;

        if (!db.objectStoreNames.contains("questions")) {
          const qs = db.createObjectStore("questions", { keyPath: "id" });
          qs.createIndex("stem", "stem", { unique: false });
          qs.createIndex("deck_id", "deck_id", { unique: false });
        } else if (event.oldVersion < 2) {
          const qs = tx.objectStore("questions");
          if (!qs.indexNames.contains("deck_id")) {
            qs.createIndex("deck_id", "deck_id", { unique: false });
          }
        }

        if (!db.objectStoreNames.contains("reviews")) {
          const rs = db.createObjectStore("reviews", { keyPath: "question_id" });
          rs.createIndex("next_review_at", "next_review_at", { unique: false });
        }
        if (!db.objectStoreNames.contains("wrong_book")) {
          db.createObjectStore("wrong_book", { keyPath: "question_id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("review_log")) {
          const ls = db.createObjectStore("review_log", { keyPath: "id", autoIncrement: true });
          ls.createIndex("question_id", "question_id", { unique: false });
        }
        if (!db.objectStoreNames.contains("decks")) {
          db.createObjectStore("decks", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** iOS can leave indexedDB.open() pending forever (or fail once with "connection lost"): time-box it and retry. */
  async function openDBRobust() {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await Promise.race([
          openDB(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("本机数据库打开超时")), attempt === 0 ? 6000 : 10000)),
        ]);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr || new Error("本机数据库无法打开");
  }

  // In-memory read caches. Every readwrite transaction invalidates the stores it touches (at start and again
  // on complete), so cached lists are never stale for longer than a write. Views read from here instead of
  // re-scanning IndexedDB (a 2465-question deck used to cost thousands of single-row reads per page switch).
  const allCache = Object.create(null); // store name -> Promise<rows[]>
  const derived = { sorted: new Map(), byDeck: new Map() };
  function invalidateStores(stores) {
    for (const n of [].concat(stores)) {
      delete allCache[n];
      if (n === "questions") {
        derived.sorted.clear();
        derived.byDeck.clear();
      }
    }
    memoStats.clear();
  }
  function tx(stores, mode = "readonly") {
    const t = idb.transaction(stores, mode);
    if (mode === "readwrite") {
      invalidateStores(stores);
      const inv = () => invalidateStores(stores);
      t.addEventListener("complete", inv);
      t.addEventListener("abort", inv);
    }
    return t;
  }
  function cachedAll(name) {
    if (!allCache[name]) {
      const p = getAll(name);
      allCache[name] = p;
      p.catch(() => {
        if (allCache[name] === p) delete allCache[name];
      });
    }
    return allCache[name];
  }
  const memoStats = new Map(); // deckId -> {t, v} (short-lived, cleared on any write)
  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function metaGet(key) {
    return reqToPromise(tx("meta").objectStore("meta").get(key));
  }
  async function metaSet(key, value) {
    return reqToPromise(tx("meta", "readwrite").objectStore("meta").put({ key, value }));
  }
  async function countStore(name) {
    return reqToPromise(tx(name).objectStore(name).count());
  }
  async function getAll(name) {
    return reqToPromise(tx(name).objectStore(name).getAll());
  }
  async function getQuestion(id) {
    return reqToPromise(tx("questions").objectStore("questions").get(Number(id)));
  }
  async function getReview(qid) {
    return reqToPromise(tx("reviews").objectStore("reviews").get(Number(qid)));
  }
  async function putQuestion(q) {
    return reqToPromise(tx("questions", "readwrite").objectStore("questions").put(q));
  }
  async function putReview(r) {
    return reqToPromise(tx("reviews", "readwrite").objectStore("reviews").put(r));
  }

  async function nextQuestionId() {
    const all = await getAll("questions");
    let maxId = 0;
    for (const q of all) if (Number(q.id) > maxId) maxId = Number(q.id);
    return maxId + 1;
  }

  async function listDecks() {
    const decks = (await cachedAll("decks")).slice();
    decks.sort((a, b) => Number(a.id) - Number(b.id));
    for (const d of decks) deckNames.set(Number(d.id), d.name);
    return decks;
  }

  async function getDeck(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return undefined; // a corrupt saved id must never throw (IDB DataError)
    return reqToPromise(tx("decks").objectStore("decks").get(n));
  }

  async function createDeck(name) {
    const now = nowIso();
    const id = await reqToPromise(
      tx("decks", "readwrite").objectStore("decks").add({ name: String(name || "").trim() || "未命名考试", created_at: now })
    );
    touchLocalSync();
    return Number(id);
  }

  async function renameDeck(id, name) {
    const d = await getDeck(id);
    if (!d) return;
    d.name = String(name || "").trim() || d.name;
    await reqToPromise(tx("decks", "readwrite").objectStore("decks").put(d));
    touchLocalSync();
  }

  async function getQuestionsByDeck(deckId) {
    const id = Number(deckId);
    let hit = derived.byDeck.get(id);
    if (!hit) {
      const all = await cachedAll("questions");
      hit = all.filter((q) => Number(q.deck_id) === id);
      derived.byDeck.set(id, hit);
    }
    return hit.slice();
  }

  async function deleteQuestionCascade(qid) {
    const id = Number(qid);
    await reqToPromise(tx("wrong_book", "readwrite").objectStore("wrong_book").delete(id));
    await reqToPromise(tx("reviews", "readwrite").objectStore("reviews").delete(id));
    // review_log: delete matching
    const logs = await getAll("review_log");
    for (const row of logs) {
      if (Number(row.question_id) === id && row.id != null) {
        await reqToPromise(tx("review_log", "readwrite").objectStore("review_log").delete(row.id));
      }
    }
    await reqToPromise(tx("questions", "readwrite").objectStore("questions").delete(id));
  }

  async function deleteDeck(deckId) {
    const qs = await getQuestionsByDeck(deckId);
    for (const q of qs) await deleteQuestionCascade(q.id);
    await reqToPromise(tx("decks", "readwrite").objectStore("decks").delete(Number(deckId)));
    touchLocalSync();
  }

  /** v24: 「默认题库」 → 「动车组机械师」, only the default deck and only while it still carries the old name */
  function renameLegacyDefaultInStores(stores) {
    try {
      if (!stores || !Array.isArray(stores.decks)) return stores;
      const m = (stores.meta || []).find((x) => x && x.key === "default_deck_id");
      const defId = m && m.value != null ? Number(m.value) : null;
      for (const d of stores.decks) {
        if (d && d.name === LEGACY_DEFAULT_NAME && (defId == null || Number(d.id) === defId)) d.name = DEFAULT_DECK_NAME;
      }
    } catch (_) {}
    return stores;
  }
  async function migrateDefaultDeckName(defaultId) {
    const d = await getDeck(defaultId);
    if (d && d.name === LEGACY_DEFAULT_NAME) {
      d.name = DEFAULT_DECK_NAME;
      await reqToPromise(tx("decks", "readwrite").objectStore("decks").put(d));
      touchLocalSync();
    }
  }

  async function ensureDecksMigrated() {
    let decks = await listDecks();
    let defaultId = null;
    if (!decks.length) {
      defaultId = await createDeck(DEFAULT_DECK_NAME);
      await metaSet("default_deck_id", defaultId);
    } else {
      const meta = await metaGet("default_deck_id");
      defaultId = meta && meta.value != null ? Number(meta.value) : Number(decks[0].id);
      if (!(await getDeck(defaultId))) defaultId = Number(decks[0].id);
    }

    const qs = await getAll("questions");
    const need = qs.filter((q) => q.deck_id == null || q.deck_id === "");
    if (need.length) {
      const CHUNK = 200;
      for (let i = 0; i < need.length; i += CHUNK) {
        const slice = need.slice(i, i + CHUNK);
        await new Promise((resolve, reject) => {
          const t = tx("questions", "readwrite");
          const store = t.objectStore("questions");
          for (const q of slice) {
            q.deck_id = defaultId;
            store.put(q);
          }
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        });
      }
    }
    return defaultId;
  }

  async function bulkPutQuestionsAndReviews(items, deckId, { dedupe = true, preserveIds = false } = {}) {
    const deck = Number(deckId);
    const existing = await getQuestionsByDeck(deck);
    const keySet = new Set();
    if (dedupe) {
      for (const q of existing) keySet.add(dedupeKey(q.stem, q.answer));
    }
    let nextId = await nextQuestionId();
    const now = nowIso();
    let added = 0;
    let skipped = 0;
    const toWrite = [];

    for (const raw of items) {
      const stem = String(raw.stem || "").trim();
      const answer = String(raw.answer || "").trim();
      if (!stem || !answer) continue;
      const key = dedupeKey(stem, answer);
      if (dedupe && keySet.has(key)) {
        skipped++;
        continue;
      }
      keySet.add(key);
      let id;
      if (preserveIds && raw.id != null) {
        id = Number(raw.id);
        if (id >= nextId) nextId = id + 1;
      } else {
        id = nextId++;
      }
      toWrite.push({
        id,
        deck_id: deck,
        stem,
        options: Array.isArray(raw.options) ? raw.options : null,
        answer,
        explanation: raw.explanation || "",
        source_file: raw.source_file || "",
        import_batch: raw.import_batch || "",
        qtype: raw.qtype || (raw.options ? "choice" : "short"),
        tags: raw.tags || "",
        difficulty: raw.difficulty == null || raw.difficulty === "" ? null : Number(raw.difficulty),
        raw_qtype: raw.raw_qtype || "",
        created_at: raw.created_at || now,
      });
    }

    const CHUNK = 200;
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      const slice = toWrite.slice(i, i + CHUNK);
      await new Promise((resolve, reject) => {
        const t = tx(["questions", "reviews"], "readwrite");
        const qs = t.objectStore("questions");
        const rs = t.objectStore("reviews");
        for (const q of slice) {
          qs.put(q);
          rs.get(q.id).onsuccess = (ev) => {
            if (!ev.target.result) {
              rs.put({
                question_id: q.id,
                easiness: 2.5,
                interval_days: 0,
                repetitions: 0,
                next_review_at: now,
                last_result: null,
                updated_at: now,
              });
            }
          };
          added++;
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("abort"));
      });
      await new Promise((r) => setTimeout(r, 0));
    }
    if (added > 0) touchLocalSync();
    return { added, skipped };
  }

  async function ensureReviewsForDeck(deckId) {
    const qs = await getQuestionsByDeck(deckId);
    const now = nowIso();
    const CHUNK = 300;
    for (let i = 0; i < qs.length; i += CHUNK) {
      const slice = qs.slice(i, i + CHUNK);
      await new Promise((resolve, reject) => {
        const t = tx("reviews", "readwrite");
        const rs = t.objectStore("reviews");
        for (const q of slice) {
          rs.get(q.id).onsuccess = (ev) => {
            if (!ev.target.result) {
              rs.put({
                question_id: q.id,
                easiness: 2.5,
                interval_days: 0,
                repetitions: 0,
                next_review_at: now,
                last_result: null,
                updated_at: now,
              });
            }
          };
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    }
  }

  async function dedupeDeck(deckId) {
    const qs = await getQuestionsByDeck(deckId);
    qs.sort((a, b) => Number(a.id) - Number(b.id));
    const seen = new Map();
    const removeIds = [];
    for (const q of qs) {
      const key = dedupeKey(q.stem, q.answer);
      if (seen.has(key)) removeIds.push(q.id);
      else seen.set(key, q.id);
    }
    for (const id of removeIds) await deleteQuestionCascade(id);
    // orphan cleanup: reviews/wrong without question
    const allQ = new Set((await getAll("questions")).map((q) => Number(q.id)));
    for (const r of await getAll("reviews")) {
      if (!allQ.has(Number(r.question_id))) {
        await reqToPromise(tx("reviews", "readwrite").objectStore("reviews").delete(r.question_id));
      }
    }
    for (const w of await getAll("wrong_book")) {
      if (!allQ.has(Number(w.question_id))) {
        await reqToPromise(tx("wrong_book", "readwrite").objectStore("wrong_book").delete(w.question_id));
      }
    }
    if (removeIds.length) touchLocalSync();
    return removeIds.length;
  }

  function sourceBasename(src) {
    const s = String(src || "").trim();
    if (!s) return "";
    const base = s.split(/[/\\]/).pop() || s;
    return base.replace(/\.xlsx$/i, "").replace(/\.xls$/i, "").trim() || base;
  }

  async function moveQuestionsToDeck(questionIds, targetDeckId) {
    const tid = Number(targetDeckId);
    const ids = questionIds.map(Number);
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      await new Promise((resolve, reject) => {
        const txx = tx("questions", "readwrite");
        const store = txx.objectStore("questions");
        for (const id of slice) {
          store.get(id).onsuccess = (ev) => {
            const q = ev.target.result;
            if (!q) return;
            q.deck_id = tid;
            store.put(q);
          };
        }
        txx.oncomplete = () => resolve();
        txx.onerror = () => reject(txx.error);
      });
    }
    touchLocalSync();
  }

  async function clearDeckQuestions(deckId) {
    const qs = await getQuestionsByDeck(deckId);
    for (const q of qs) await deleteQuestionCascade(q.id);
    touchLocalSync();
    return qs.length;
  }

  async function splitBySourceFile(scopeDeckId) {
    const qs =
      scopeDeckId != null
        ? await getQuestionsByDeck(scopeDeckId)
        : await getAll("questions");
    const groups = new Map();
    for (const q of qs) {
      const key = String(q.source_file || "").trim() || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    }
    const named = [...groups.keys()].filter((k) => k);
    if (named.length <= 1) {
      return {
        ok: false,
        reason:
          named.length === 0
            ? "题目没有来源文件名（source_file），无法按来源拆分。请重新用不同 xlsx 导入，或新建考试后分别导入。"
            : "所有题目来源文件名相同，无法按来源拆成多个考试。若是同一文件重复导入，请先「清除重复题」。",
        named,
      };
    }

    const decks = await listDecks();
    const byName = new Map(decks.map((d) => [d.name, d]));
    let created = 0;
    let moved = 0;
    const summary = [];

    for (const src of named) {
      const name = sourceBasename(src) || src;
      let deck = byName.get(name);
      if (!deck) {
        const id = await createDeck(name);
        deck = await getDeck(id);
        byName.set(name, deck);
        created++;
      }
      const ids = groups.get(src).map((q) => q.id);
      await moveQuestionsToDeck(ids, deck.id);
      moved += ids.length;
      summary.push({ name, n: ids.length, source: src });
    }

    // leftover with empty source_file stay put; delete empty decks
    let deletedEmpty = 0;
    for (const d of await listDecks()) {
      const left = await getQuestionsByDeck(d.id);
      if (!left.length) {
        await reqToPromise(tx("decks", "readwrite").objectStore("decks").delete(Number(d.id)));
        deletedEmpty++;
      }
    }
    // ensure at least one deck exists
    if (!(await listDecks()).length) {
      await createDeck(DEFAULT_DECK_NAME);
    }

    return { ok: true, created, moved, deletedEmpty, summary };
  }


  /** answered at least once in 刷题 (背题 never writes a review result). Fresh rows have last_result null. */
  function isAnswered(r) {
    return !!r && (r.last_result != null || Number(r.repetitions) > 0);
  }
  /** 待复习 = answered at least once AND due now. Never-answered questions are 未做, not 待复习. */
  function isDueReview(r, now) {
    return isAnswered(r) && (!r.next_review_at || r.next_review_at <= now);
  }

  async function getDueQuestions(deckId = currentDeckId) {
    const now = nowIso();
    const qs = await getQuestionsByDeck(deckId);
    const revs = new Map((await cachedAll("reviews")).map((r) => [Number(r.question_id), r]));
    const out = [];
    for (const q of qs) {
      const r = revs.get(Number(q.id));
      if (isDueReview(r, now)) out.push({ ...q, ...r });
    }
    out.sort((a, b) => String(a.next_review_at || "").localeCompare(String(b.next_review_at || "")));
    return out;
  }

  async function getRandomQuestions(n = 20, deckId = currentDeckId) {
    const qs = await getQuestionsByDeck(deckId);
    for (let i = qs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [qs[i], qs[j]] = [qs[j], qs[i]];
    }
    const pick = qs.slice(0, Math.min(n, qs.length));
    return enrichWithReviews(pick);
  }

  /** like enrichWithReviews, but from an in-memory review map (one pass, fast for hundreds of questions) */
  function enrichFromMap(list, revMap) {
    return list.map((q) => {
      const r = revMap.get(Number(q.id)) || {
        question_id: q.id,
        easiness: 2.5,
        interval_days: 0,
        repetitions: 0,
        next_review_at: nowIso(),
        last_result: null,
      };
      return { ...q, ...r };
    });
  }

  async function getSortedQuestions(deckId = currentDeckId) {
    const id = Number(deckId);
    let hit = derived.sorted.get(id);
    if (!hit) {
      hit = await getQuestionsByDeck(id);
      hit.sort((a, b) => Number(a.id) - Number(b.id));
      derived.sorted.set(id, hit);
    }
    return hit.slice();
  }

  async function enrichWithReviews(pick) {
    const out = [];
    for (const q of pick) {
      const r = (await getReview(q.id)) || {
        question_id: q.id,
        easiness: 2.5,
        interval_days: 0,
        repetitions: 0,
        next_review_at: nowIso(),
        last_result: null,
      };
      out.push({ ...q, ...r });
    }
    return out;
  }

  // ---------- Cursors: 背题 (study) and 做题 (practice) are fully independent ----------
  // localStorage[CURSORS_KEY] = { "<deckId>": { study: Cursor, practice: Cursor } }
  // Cursor = { offset, lastStart, lastCount, lastIds[], from, to, qtypes[], status, t }
  //   offset  : absolute 0-based position (in id-sorted deck) where the next batch starts
  //   from/to : optional 1-based range (0 = unrestricted); qtypes/status: optional filters
  //   t       : last-modified ms, used to merge cursors between devices
  function blankCursor() {
    return { offset: 0, lastStart: 0, lastCount: 0, lastIds: [], from: 0, to: 0, qtypes: [], status: "all", t: 0 };
  }
  function normCursor(c) {
    const b = blankCursor();
    if (!c || typeof c !== "object") return b;
    b.offset = Math.max(0, Number(c.offset) || 0);
    b.lastStart = Math.max(0, Number(c.lastStart) || 0);
    b.lastCount = Math.max(0, Number(c.lastCount) || 0);
    b.lastIds = Array.isArray(c.lastIds) ? c.lastIds.map(Number).filter((x) => Number.isFinite(x)) : [];
    b.from = Math.max(0, Number(c.from) || 0);
    b.to = Math.max(0, Number(c.to) || 0);
    b.qtypes = Array.isArray(c.qtypes) ? c.qtypes.filter((x) => typeof x === "string") : [];
    b.status = c.status === "new" || c.status === "wrong" ? c.status : "all";
    b.t = Number(c.t) || 0;
    return b;
  }
  function normCursorMap(m) {
    const out = {};
    if (!m || typeof m !== "object") return out;
    for (const k of Object.keys(m)) {
      const d = m[k] || {};
      out[k] = { study: normCursor(d.study), practice: normCursor(d.practice) };
    }
    return out;
  }
  /** Old single-cursor data {deckId:{offset,lastStart,lastCount}} seeds BOTH cursors. */
  function cursorsFromLegacy(legacy, t = 0) {
    const out = {};
    if (!legacy || typeof legacy !== "object") return out;
    for (const k of Object.keys(legacy)) {
      const m = legacy[k] || {};
      const seed = { offset: m.offset, lastStart: m.lastStart, lastCount: m.lastCount, t };
      out[k] = { study: normCursor(seed), practice: normCursor(seed) };
    }
    return out;
  }
  function cursorsFromPayload(p) {
    if (!p || typeof p !== "object") return null;
    if (p.cursors && typeof p.cursors === "object") return normCursorMap(p.cursors);
    if (p.seqMeta && typeof p.seqMeta === "object") return cursorsFromLegacy(p.seqMeta, Number(p.updatedAt) || 0);
    return null;
  }
  function mergeCursorMaps(a, b) {
    const out = {};
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const x = (a || {})[k] || {};
      const y = (b || {})[k] || {};
      out[k] = {};
      for (const kind of CURSOR_KINDS) {
        const cx = normCursor(x[kind]);
        const cy = normCursor(y[kind]);
        out[k][kind] = cx.t > cy.t ? cx : cy;
      }
    }
    return out;
  }
  function readAllCursors() {
    try {
      const raw = localStorage.getItem(CURSORS_KEY);
      if (raw) return normCursorMap(JSON.parse(raw));
    } catch (_) {}
    // one-time migration from the legacy single cursor
    let legacy = {};
    try {
      legacy = JSON.parse(localStorage.getItem(SEQ_META_KEY) || sessionStorage.getItem(SEQ_META_KEY) || "{}");
    } catch (_) {
      legacy = {};
    }
    const out = cursorsFromLegacy(legacy, 0);
    try {
      localStorage.setItem(CURSORS_KEY, JSON.stringify(out));
    } catch (_) {}
    return out;
  }
  function writeAllCursors(map) {
    try {
      localStorage.setItem(CURSORS_KEY, JSON.stringify(normCursorMap(map)));
    } catch (_) {}
  }
  /** Legacy mirror (practice cursor) so older cached clients reading seqMeta still get a position. */
  function legacySeqMetaFrom(map) {
    const out = {};
    for (const k of Object.keys(map || {})) {
      const c = normCursor(((map || {})[k] || {}).practice);
      out[k] = { offset: c.offset, lastStart: c.lastStart, lastCount: c.lastCount };
    }
    return out;
  }
  function readCursor(kind, deckId = currentDeckId) {
    const all = readAllCursors();
    const d = all[String(deckId)] || {};
    return normCursor(d[kind]);
  }
  function updateCursor(kind, deckId, patch) {
    const all = readAllCursors();
    const key = String(deckId);
    const d = all[key] || { study: blankCursor(), practice: blankCursor() };
    d[kind] = normCursor(Object.assign({}, normCursor(d[kind]), patch, { t: Date.now() }));
    all[key] = d;
    writeAllCursors(all);
    touchLocalSync();
  }
  function advanceCursorTo(kind, idx, deckId = currentDeckId) {
    const c = readCursor(kind, deckId);
    if (Number(idx) > c.offset) updateCursor(kind, deckId, { offset: Number(idx) });
  }
  function resetCursor(kind, deckId = currentDeckId) {
    updateCursor(kind, deckId, blankCursor());
    clearSavedRound(kind);
  }
  function cursorHasScope(c) {
    return c.from > 0 || c.to > 0 || c.qtypes.length > 0 || c.status !== "all";
  }

  /** 单选 / 多选 / 判断 / 其他 (derived from options + answer, works for imported decks too) */
  function qTypeOf(q) {
    const opts = Array.isArray(q.options) ? q.options.filter((x) => x != null && String(x).trim() !== "") : [];
    const raw = String(q.raw_qtype || "");
    if (/判断/.test(raw) || opts.length === 2) return "判断";
    if (/多选/.test(raw)) return "多选";
    if (!opts.length) return "其他";
    const letters = String(q.answer == null ? "" : q.answer).toUpperCase().match(/[A-Z]/g) || [];
    return new Set(letters).size > 1 ? "多选" : "单选";
  }
  const QTYPE_ORDER = ["单选", "多选", "判断", "其他"];

  async function loadScopeContext() {
    const reviews = new Map();
    for (const r of await cachedAll("reviews")) reviews.set(Number(r.question_id), r);
    const wrong = new Set((await cachedAll("wrong_book")).map((w) => Number(w.question_id)));
    return { reviews, wrong };
  }
  /** ascending absolute indices (into id-sorted deck) matching the scope */
  function scopeIndices(sorted, ctx, scope) {
    const total = sorted.length;
    const from = scope.from > 0 ? scope.from : 1;
    const to = scope.to > 0 ? Math.min(scope.to, total) : total;
    const types = scope.qtypes && scope.qtypes.length ? new Set(scope.qtypes) : null;
    const out = [];
    for (let i = from - 1; i < to; i++) {
      const q = sorted[i];
      if (types && !types.has(qTypeOf(q))) continue;
      if (scope.status === "wrong") {
        if (!ctx.wrong.has(Number(q.id))) continue;
      } else if (scope.status === "new") {
        const r = ctx.reviews.get(Number(q.id));
        if (r && r.last_result != null) continue;
      }
      out.push(i);
    }
    return out;
  }

  /**
   * Sequential slice by ascending id for cursor `kind` ("study" | "practice").
   * useLast: replay the last batch of `sourceKind` (default = kind) without touching any cursor offset.
   */
  async function getSequentialQuestions({ n = 20, fromStart = false, useLast = false, kind = "practice", sourceKind = null, deckId = currentDeckId } = {}) {
    const sorted = await getSortedQuestions(deckId);
    let picked = [];
    let wrapped = false;
    if (useLast) {
      const c = readCursor(sourceKind || kind, deckId);
      const idMap = new Map(sorted.map((q, i) => [Number(q.id), i]));
      picked = c.lastIds.map((id) => idMap.get(Number(id))).filter((i) => i != null);
      if (!picked.length && c.lastCount > 0) {
        for (let i = c.lastStart; i < Math.min(sorted.length, c.lastStart + c.lastCount); i++) picked.push(i);
      }
    } else {
      const cur = readCursor(kind, deckId);
      const ctx = await loadScopeContext();
      const all = scopeIndices(sorted, ctx, cur);
      const first = cur.from > 0 ? cur.from - 1 : 0;
      let startOffset = fromStart ? first : Math.max(cur.offset, first);
      let rest = all.filter((i) => i >= startOffset);
      if (!rest.length && !fromStart && all.length) {
        rest = all; // finished a pass: start again from the beginning of the range
        startOffset = first;
        wrapped = true;
      }
      picked = n == null || n <= 0 ? rest : rest.slice(0, n);
      if (picked.length) {
        const patch = {
          lastIds: picked.map((i) => Number(sorted[i].id)),
          lastStart: picked[0],
          lastCount: picked.length,
        };
        if (fromStart || wrapped) patch.offset = Math.min(startOffset, picked[0]);
        updateCursor(kind, deckId, patch);
      }
    }
    const slice = picked.map((i) => sorted[i]);
    const enriched = await enrichWithReviews(slice);
    enriched.forEach((q, i) => {
      q._idx = picked[i];
    });
    return { questions: enriched, start: picked.length ? picked[0] : 0, count: slice.length, total: sorted.length, wrapped };
  }

  function cursorProgress(kind, total, deckId = currentDeckId) {
    const c = readCursor(kind, deckId);
    const scoped = cursorHasScope(c);
    const from = c.from > 0 ? c.from : 1;
    const to = c.to > 0 ? Math.min(c.to, total) : total;
    const of = scoped ? Math.max(0, to - from + 1) : total || 0;
    const done = Math.max(0, Math.min(of, c.offset - (from - 1)));
    return { c, scoped, from, to, of, done };
  }

  async function getWrongList(deckId = currentDeckId) {
    const [wrongs0, qs, revs] = await Promise.all([cachedAll("wrong_book"), getQuestionsByDeck(deckId), cachedAll("reviews")]);
    const qMap = new Map(qs.map((q) => [Number(q.id), q]));
    const rMap = new Map(revs.map((r) => [Number(r.question_id), r]));
    const wrongs = wrongs0.slice();
    wrongs.sort((a, b) => String(b.last_wrong_at || "").localeCompare(String(a.last_wrong_at || "")));
    const out = [];
    for (const w of wrongs) {
      const q = qMap.get(Number(w.question_id));
      if (!q) continue;
      const r = rMap.get(Number(w.question_id)) || {};
      out.push({ ...q, ...r, wrong_count: w.wrong_count, reason: w.reason, last_wrong_at: w.last_wrong_at });
    }
    return out;
  }

  async function addWrong(qid, reason = "wrong") {
    const existing = await reqToPromise(tx("wrong_book").objectStore("wrong_book").get(Number(qid)));
    const now = nowIso();
    if (existing) {
      existing.wrong_count = (existing.wrong_count || 1) + 1;
      existing.reason = reason;
      existing.last_wrong_at = now;
      await reqToPromise(tx("wrong_book", "readwrite").objectStore("wrong_book").put(existing));
    } else {
      await reqToPromise(
        tx("wrong_book", "readwrite").objectStore("wrong_book").put({
          question_id: Number(qid),
          reason,
          wrong_count: 1,
          last_wrong_at: now,
          created_at: now,
        })
      );
    }
    touchLocalSync();
  }

  async function removeWrong(qid) {
    await reqToPromise(tx("wrong_book", "readwrite").objectStore("wrong_book").delete(Number(qid)));
    touchLocalSync();
  }

  async function applyRating(qid, rating, correct) {
    const prev = (await getReview(qid)) || {
      question_id: Number(qid),
      easiness: 2.5,
      interval_days: 0,
      repetitions: 0,
    };
    const next = schedule(rating, prev.easiness, prev.interval_days, prev.repetitions);
    const row = {
      question_id: Number(qid),
      easiness: next.easiness,
      interval_days: next.interval_days,
      repetitions: next.repetitions,
      next_review_at: next.next_review_at,
      last_result: rating,
      updated_at: nowIso(),
    };
    await putReview(row);
    heatBump("practice");
    await reqToPromise(
      tx("review_log", "readwrite").objectStore("review_log").add({
        question_id: Number(qid),
        result: rating,
        correct: correct == null ? null : correct ? 1 : 0,
        created_at: nowIso(),
      })
    );
    touchLocalSync();
    return next;
  }

  const STATS_LS_KEY = "pair_stats_v1";
  const lastStats = new Map(); // deckId -> {total,fresh,due,wrong} last known (memory + localStorage)
  const deckNames = new Map(); // deckId -> name (so the header can paint without a DB read)
  function peekStats(deckId) {
    const k = String(deckId);
    if (lastStats.has(k)) return lastStats.get(k);
    try {
      const all = JSON.parse(localStorage.getItem(STATS_LS_KEY) || "{}");
      if (all[k]) {
        lastStats.set(k, all[k]);
        return all[k];
      }
    } catch (_) {}
    return null;
  }
  function rememberStats(deckId, st) {
    lastStats.set(String(deckId), st);
    try {
      const all = JSON.parse(localStorage.getItem(STATS_LS_KEY) || "{}");
      all[String(deckId)] = st;
      localStorage.setItem(STATS_LS_KEY, JSON.stringify(all));
    } catch (_) {}
  }
  function sameStats(a, b) {
    return !!a && !!b && a.total === b.total && a.fresh === b.fresh && a.due === b.due && a.wrong === b.wrong;
  }

  /** counts for a deck, computed in memory from the cached question / review / wrong-book lists (no per-row DB reads) */
  async function statsForDeck(deckId) {
    const key = Number(deckId);
    const memo = memoStats.get(key);
    if (memo) return memo;
    const [qs, revs, wrongs] = await Promise.all([getQuestionsByDeck(key), cachedAll("reviews"), cachedAll("wrong_book")]);
    const rMap = new Map(revs.map((r) => [Number(r.question_id), r]));
    const wSet = new Set(wrongs.map((w) => Number(w.question_id)));
    const now = nowIso();
    let due = 0;
    let fresh = 0;
    let wrong = 0;
    for (const q of qs) {
      const r = rMap.get(Number(q.id));
      if (!isAnswered(r)) fresh++;
      else if (isDueReview(r, now)) due++;
      if (wSet.has(Number(q.id))) wrong++;
    }
    const st = { total: qs.length, due, fresh, wrong };
    memoStats.set(key, st);
    rememberStats(key, st);
    return st;
  }

  /** Header = back button + deck name (+ offline badge). No stats here, so it never needs a DB scan. */
  async function updateHeaderStats() {
    const back = $("#hdr-back");
    const nameEl = $("#hdr-deck");
    try {
      if (!currentDeckId) {
        if (back) back.hidden = true;
        if (nameEl) nameEl.textContent = "Pair";
        return;
      }
      if (back) back.hidden = route === "quiz" || route === "study-quiz"; // ✕ in the quiz header is the way out
      if (nameEl && deckNames.has(currentDeckId)) nameEl.textContent = deckNames.get(currentDeckId);
      const deck = await getDeck(currentDeckId);
      if (deck) deckNames.set(Number(deck.id), deck.name);
      if (nameEl) nameEl.textContent = deck ? deck.name : "Pair";
    } catch (_) { /* ignore */ }
  }

  function setNavVisible(show) {
    const nav = $(".bottom-nav");
    if (!nav) return;
    nav.style.display = show ? "" : "none";
    document.body.classList.toggle("no-nav", !show);
  }

  function enterDeck(deckId) {
    currentDeckId = Number(deckId);
    try {
      localStorage.setItem(SESSION_DECK_KEY, String(currentDeckId));
    } catch (_) {}
    try {
      sessionStorage.setItem(SESSION_DECK_KEY, String(currentDeckId));
    } catch (_) {}
    setNavVisible(true);
    navigate("today");
  }

  function clearSavedDeck() {
    try {
      localStorage.removeItem(SESSION_DECK_KEY);
    } catch (_) {}
    try {
      sessionStorage.removeItem(SESSION_DECK_KEY);
    } catch (_) {}
  }

  function leaveDeck() {
    currentDeckId = null;
    clearSavedDeck();
    stopTimer();
    setNavVisible(false);
    navigate("exams");
  }

  // ---------- Preload ----------
  async function initPreload() {
    const defaultId = await ensureDecksMigrated();
    try {
      await migrateDefaultDeckName(defaultId);
    } catch (e) {
      console.warn("[rename]", e);
    }
    const meta = await metaGet(PRELOAD_META_KEY);
    const count = await countStore("questions");
    if (meta && meta.value && count > 0) return { loaded: false, count, defaultId };

    app().innerHTML = `
      <div class="card">
        <h1>首次初始化</h1>
        <p class="muted">正在载入预置题库到「${DEFAULT_DECK_NAME}」…</p>
        <div class="progress-bar"><span id="init-bar"></span></div>
        <p id="init-msg" class="muted">准备中</p>
      </div>`;

    // first install: fetch the bundled exams in parallel with the default bank, so all exams appear together
    const bundledPrefetch = prefetchBundled();
    let data;
    try {
      const res = await fetch("data/questions.json", { cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      const res = await fetch("data/questions.json");
      if (!res.ok) throw new Error("无法加载 questions.json: " + (e.message || e));
      data = await res.json();
    }

    const bar = $("#init-bar");
    const msg = $("#init-msg");
    const total = data.length;
    const CHUNK = 250;
    let done = 0;
    let addedTotal = 0;
    for (let i = 0; i < data.length; i += CHUNK) {
      const slice = data.slice(i, i + CHUNK);
      const stamped = slice.map((it) => ({
        ...it,
        source_file: it.source_file || "questions.json",
        import_batch: it.import_batch || "preload_v1",
      }));
      const r = await bulkPutQuestionsAndReviews(stamped, defaultId, { dedupe: true, preserveIds: true });
      addedTotal += r.added;
      done = Math.min(total, i + CHUNK);
      if (bar) bar.style.width = ((done / total) * 100).toFixed(1) + "%";
      if (msg) msg.textContent = `已写入 ${done} / ${total}`;
    }
    await ensureReviewsForDeck(defaultId);
    await metaSet(PRELOAD_META_KEY, { at: nowIso(), n: addedTotal, deck_id: defaultId });
    if (msg) msg.textContent = "正在载入其他考试…";
    try {
      await installBundledDecks({ prefetch: await bundledPrefetch, quiet: true });
    } catch (e) {
      console.warn("[bundled] first install", e);
    }
    return { loaded: true, count: addedTotal, defaultId };
  }

  // ---------- Bundled decks (data/decks/index.json): added once as NEW exams, never touching existing ones ----------
  const BUNDLED_LS_KEY = "pair_bundled_decks";
  const BUNDLED_META_KEY = "bundled_decks";
  function readBundledLocal() {
    try {
      const a = JSON.parse(localStorage.getItem(BUNDLED_LS_KEY) || "[]");
      return Array.isArray(a) ? a : [];
    } catch (_) {
      return [];
    }
  }
  async function fetchJsonTimeout(url, ms) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), ms);
    try {
      const res = await fetch(url, { cache: "no-cache", signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }
  /** static bundled manifest + owner-published decks (/api/decks); the API part is optional (offline / old server) */
  async function fetchDeckManifest() {
    const [stat, pub] = await Promise.all([
      fetchJsonTimeout("data/decks/index.json", 8000),
      fetchJsonTimeout("/api/decks", 6000).catch(() => []),
    ]);
    const out = Array.isArray(stat) ? stat.slice() : [];
    if (Array.isArray(pub))
      for (const e of pub) if (e && /^pub_[a-z0-9]{6,32}$/.test(e.key) && e.name && /^\/api\/decks\//.test(e.file)) out.push(e);
    return out;
  }
  /** start downloading the manifest + every bundled deck file at once; resolves to {manifest, files:Map} */
  async function prefetchBundled() {
    try {
      const manifest = await fetchDeckManifest();
      if (!Array.isArray(manifest)) return null;
      const files = new Map();
      for (const ent of manifest) if (ent && ent.file) files.set(ent.file, fetchJsonTimeout(ent.file, 30000).catch(() => null));
      return { manifest, files };
    } catch (_) {
      return null;
    }
  }
  let bundledRunning = false;
  async function installBundledDecks(opts = {}) {
    if (bundledRunning) return [];
    bundledRunning = true;
    const added = [];
    const pre = opts.prefetch || null;
    try {
      let manifest;
      try {
        manifest = pre ? pre.manifest : await fetchDeckManifest();
      } catch (e) {
        return added; // offline / slow: try again next launch
      }
      if (!Array.isArray(manifest)) return added;
      const metaRow = await metaGet(BUNDLED_META_KEY);
      const done = new Set([...readBundledLocal(), ...((metaRow && Array.isArray(metaRow.value) && metaRow.value) || [])]);
      const mark = async (key) => {
        done.add(key);
        const list = [...done];
        try {
          localStorage.setItem(BUNDLED_LS_KEY, JSON.stringify(list));
        } catch (_) {}
        await metaSet(BUNDLED_META_KEY, list);
      };
      for (const ent of manifest) {
        if (!ent || !ent.key || !ent.name || !ent.file) continue;
        const ver = Number(ent.version) || 1;
        const doneKey = ver > 1 ? ent.key + "@" + ver : ent.key;
        if (done.has(doneKey)) continue;
        const decks = await listDecks();
        // owner published a newer version of a deck this device already has: merge in the NEW questions only
        const installed = decks.find((d) => d.bundled_key === ent.key);
        if (installed && ver > (Number(installed.bundled_version) || 1)) {
          let upd;
          try {
            upd = pre && pre.files.has(ent.file) ? await pre.files.get(ent.file) : await fetchJsonTimeout(ent.file, 30000);
          } catch (e) {
            continue;
          }
          if (!Array.isArray(upd) || !upd.length) continue;
          const r = await bulkPutQuestionsAndReviews(upd.map((it) => ({ ...it, import_batch: "bundled_" + ent.key + "_v" + ver })), Number(installed.id), { dedupe: true });
          await ensureReviewsForDeck(Number(installed.id));
          const d2 = await getDeck(Number(installed.id));
          if (d2) {
            d2.bundled_version = ver;
            await reqToPromise(tx("decks", "readwrite").objectStore("decks").put(d2));
          }
          await mark(doneKey);
          touchLocalSync();
          if (r.added) added.push(ent.name + "（更新 +" + r.added + "）");
          continue;
        }
        if (installed) {
          await mark(doneKey);
          continue;
        }
        const same = decks.filter((d) => d.bundled_key === ent.key || d.name === ent.name);
        let skip = false;
        for (const d of same) {
          if (d.bundled_key === ent.key || (await getQuestionsByDeck(d.id)).length > 0) skip = true;
        }
        if (skip) {
          await mark(doneKey);
          continue;
        }
        let data;
        try {
          data = pre && pre.files.has(ent.file) ? await pre.files.get(ent.file) : await fetchJsonTimeout(ent.file, 30000);
        } catch (e) {
          continue;
        }
        if (!Array.isArray(data) || !data.length) continue;
        // reuse an empty deck with this exact name (e.g. created by hand, import never done) instead of adding a twin
        let deckId = same.length ? Number(same[0].id) : await createDeck(ent.name);
        const d = await getDeck(deckId);
        if (d) {
          d.bundled_key = ent.key;
          d.bundled_version = ver;
          await reqToPromise(tx("decks", "readwrite").objectStore("decks").put(d));
        }
        const stamped = data.map((it) => ({ ...it, import_batch: "bundled_" + ent.key }));
        let n = 0;
        for (let i = 0; i < stamped.length; i += 300) {
          const r = await bulkPutQuestionsAndReviews(stamped.slice(i, i + 300), deckId, { dedupe: true });
          n += r.added;
        }
        await ensureReviewsForDeck(deckId);
        await mark(doneKey);
        touchLocalSync();
        added.push(ent.name);
        console.log("[bundled] added", ent.name, n);
      }
    } catch (e) {
      console.warn("[bundled]", e);
    } finally {
      bundledRunning = false;
    }
    if (added.length && !opts.quiet) {
      toast("已添加新考试：" + added.join("、"));
      if (route === "exams") navigate("exams").catch(() => {});
    }
    return added;
  }

  // ---------- Settings (每题时间) ----------
  function readSettings() {
    try {
      const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (_) {}
    return {};
  }
  function normTime(v) {
    const n = Number(v);
    return TIME_OPTIONS.includes(n) ? n : TIME_DEFAULT;
  }
  function getTimeLimit() {
    const o = readSettings();
    return o.timeLimit == null ? TIME_DEFAULT : normTime(o.timeLimit);
  }
  function setTimeLimit(v) {
    const o = readSettings();
    o.timeLimit = normTime(v);
    o.t = Date.now();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    } catch (_) {}
    touchLocalSync();
  }
  function timeLabel(v) {
    return v > 0 ? `${v}秒` : "不限时";
  }
  function timeHint() {
    const v = getTimeLimit();
    return v > 0 ? `每题 ${v} 秒` : "每题不限时";
  }
  function timeSegHtml(id) {
    const cur = getTimeLimit();
    return `<div class="seg" id="${id}" role="radiogroup" aria-label="每题时间">${TIME_OPTIONS.map(
      (v) => `<button type="button" role="radio" aria-checked="${v === cur}" class="${v === cur ? "on" : ""}" data-t="${v}">${timeLabel(v)}</button>`
    ).join("")}</div>`;
  }
  function wireTimeSeg(host) {
    if (!host) return;
    host.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-t]");
      if (!b || !host.contains(b)) return;
      setTimeLimit(b.dataset.t);
      host.querySelectorAll("[data-t]").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-checked", String(on));
      });
      toast(`每题时间：${timeLabel(getTimeLimit())}（下一题起生效）`);
    });
  }
  /** 随机测试: { n, pool: "all"|"range", status: "all"|"new"|"wrong" } */
  function clampRandN(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, RAND_MAX_N) : RAND_DEFAULT_N;
  }
  function normRand(o) {
    o = o && typeof o === "object" ? o : {};
    return {
      n: clampRandN(o.n),
      pool: o.pool === "range" ? "range" : "all",
      status: o.status === "new" || o.status === "wrong" ? o.status : "all",
    };
  }
  function getRand() {
    return normRand(readSettings().rand);
  }
  function setRand(patch) {
    const o = readSettings();
    o.rand = normRand(Object.assign(getRand(), patch));
    o.t = Date.now();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    } catch (_) {}
    touchLocalSync();
  }
  function normBadPause(v) {
    const n = Number(v);
    return BAD_PAUSE_OPTIONS.includes(n) ? n : BAD_PAUSE_DEFAULT;
  }
  function getBadPause() {
    const o = readSettings();
    return o.badPause == null ? BAD_PAUSE_DEFAULT : normBadPause(o.badPause);
  }
  function setBadPause(v) {
    const o = readSettings();
    o.badPause = normBadPause(v);
    o.t = Date.now();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    } catch (_) {}
    touchLocalSync();
  }
  function badPauseLabel(v) {
    return v > 0 ? `${v}秒` : "立即";
  }
  function badPauseSegHtml(id) {
    const cur = getBadPause();
    return `<div class="seg" id="${id}" role="radiogroup" aria-label="答错停留">${BAD_PAUSE_OPTIONS.map(
      (v) => `<button type="button" role="radio" aria-checked="${v === cur}" class="${v === cur ? "on" : ""}" data-bp="${v}">${badPauseLabel(v)}</button>`
    ).join("")}</div>`;
  }
  function wireBadPauseSeg(host) {
    if (!host) return;
    host.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-bp]");
      if (!b || !host.contains(b)) return;
      setBadPause(b.dataset.bp);
      host.querySelectorAll("[data-bp]").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-checked", String(on));
      });
      toast(`答错停留：${badPauseLabel(getBadPause())}（下一题起生效）`);
    });
  }
  function settingsForSync() {
    return { timeLimit: getTimeLimit(), badPause: getBadPause(), rand: getRand(), t: Number(readSettings().t) || 0 };
  }
  /** snapshots without settings (older versions) leave the local settings alone (default 10 秒 / 5 秒停留 / 100 题) */
  function applyIncomingSettings(inc, mode) {
    if (!inc || typeof inc !== "object" || (inc.timeLimit == null && inc.rand == null && inc.badPause == null)) return;
    const cur = readSettings();
    if (mode === "merge" && (Number(cur.t) || 0) > (Number(inc.t) || 0)) return;
    const next = {
      timeLimit: inc.timeLimit == null ? getTimeLimit() : normTime(inc.timeLimit),
      badPause: inc.badPause == null ? getBadPause() : normBadPause(inc.badPause),
      rand: inc.rand == null ? getRand() : normRand(inc.rand),
      t: Number(inc.t) || 0,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  // ---------- Timer ----------
  function stopTimer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  }
  function clearAdvance() {
    if (advanceTimerId) {
      clearInterval(advanceTimerId);
      clearTimeout(advanceTimerId);
      advanceTimerId = null;
    }
  }
  function startTimer(onTimeout) {
    stopTimer();
    const limit = getTimeLimit(); // read per question: a changed setting applies from the next question
    timerLeft = limit;
    const node = $("#timer");
    if (node) {
      node.textContent = limit > 0 ? String(timerLeft) : "∞";
      node.classList.remove("warn");
    }
    if (!(limit > 0)) return; // 不限时: no countdown, no auto-wrong
    timerId = setInterval(() => {
      if (boardOpen) return; // countdown pauses while the 题板 is open
      timerLeft -= 1;
      const el = $("#timer");
      if (el) {
        el.textContent = String(Math.max(0, timerLeft));
        if (timerLeft <= 3) el.classList.add("warn");
      }
      if (timerLeft <= 0) {
        stopTimer();
        onTimeout();
      }
    }, 1000);
  }

  function normalizeAnswer(s) {
    return String(s || "").trim().toUpperCase().replace(/\s+/g, "").replace(/[,，、]/g, "");
  }
  function optionLetter(idx) {
    return KEYS[idx] || String(idx + 1);
  }
  function isChoiceCorrect(q, selectedLetter) {
    const ans = normalizeAnswer(q.answer);
    const sel = normalizeAnswer(selectedLetter);
    if (ans === sel) return true;
    if (ans.startsWith(sel) && (ans.length === 1 || !/[A-F]/.test(ans.slice(1, 2)))) return true;
    if (ans.split("").sort().join("") === sel.split("").sort().join("")) return true;
    if (Array.isArray(q.options)) {
      const idx = KEYS.indexOf(sel);
      if (idx >= 0 && q.options[idx]) {
        const text = normalizeAnswer(q.options[idx]);
        if (ans === text || ans.includes(text) || text.includes(ans)) return true;
      }
    }
    return ans.includes(sel);
  }

  let toastTimer = null;

  // ---------- Cloud sync (LWW snapshot) ----------
  let syncPushTimer = null;
  let syncInFlight = false;
  let syncStatusText = "";
  let syncMute = false;

  function getSyncCode() {
    try {
      return (localStorage.getItem(SYNC_CODE_KEY) || "").replace(/\s+/g, "");
    } catch (_) {
      return "";
    }
  }
  function setSyncCode(code) {
    const c = String(code || "").replace(/\s+/g, "");
    try {
      if (c) localStorage.setItem(SYNC_CODE_KEY, c);
      else localStorage.removeItem(SYNC_CODE_KEY);
    } catch (_) {}
  }
  function getLocalSyncUpdatedAt() {
    try {
      return Number(localStorage.getItem(SYNC_UPDATED_AT_KEY) || 0) || 0;
    } catch (_) {
      return 0;
    }
  }
  function setLocalSyncUpdatedAt(ts) {
    try {
      localStorage.setItem(SYNC_UPDATED_AT_KEY, String(Number(ts) || 0));
    } catch (_) {}
  }
  function touchLocalSync() {
    if (syncMute) return;
    setLocalSyncUpdatedAt(Date.now());
    scheduleSyncPush();
  }
  function generateSyncCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    let s = "";
    for (let i = 0; i < arr.length; i++) s += chars[arr[i] % 62];
    return s;
  }
  function formatSyncCodeDisplay(code) {
    const c = String(code || "").replace(/\s+/g, "");
    return c.match(/.{1,4}/g)?.join(" ") || c;
  }
  function isValidSyncCode(code) {
    return /^[A-Za-z0-9]{16,128}$/.test(String(code || "").replace(/\s+/g, ""));
  }
  async function exportAllData() {
    const stores = {
      decks: await getAll("decks"),
      questions: await getAll("questions"),
      reviews: await getAll("reviews"),
      wrong_book: await getAll("wrong_book"),
      meta: await getAll("meta"),
      review_log: await getAll("review_log"),
    };
    const updatedAt = Math.max(Date.now(), getLocalSyncUpdatedAt());
    return {
      version: SYNC_VERSION,
      updatedAt,
      stores,
      cursors: readAllCursors(),
      seqMeta: legacySeqMetaFrom(readAllCursors()),
      settings: settingsForSync(),
      heat: (({ s, p }) => ({ s, p }))(readHeat()),
      syncCode: getSyncCode() || undefined,
    };
  }

  async function clearAndPutStore(storeName, rows) {
    await new Promise((resolve, reject) => {
      const t = tx(storeName, "readwrite");
      const store = t.objectStore(storeName);
      const clearReq = store.clear();
      clearReq.onerror = () => reject(clearReq.error);
      clearReq.onsuccess = () => {
        let i = 0;
        const list = rows || [];
        const putNext = () => {
          if (i >= list.length) return;
          const row = list[i++];
          const req = store.put(row);
          req.onerror = () => reject(req.error);
          req.onsuccess = putNext;
        };
        putNext();
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("abort"));
    });
  }

  /**
   * cursorMode "merge": keep whichever cursor (per deck, per study/practice) was modified last — used by cloud pulls.
   * cursorMode "replace": take the payload's cursors as-is — used by backup restore.
   */
  async function importAllData(payload, { replace = true, cursorMode = "replace" } = {}) {
    if (!payload || !payload.stores || typeof payload.stores !== "object") {
      throw new Error("无效同步数据");
    }
    if (!replace) throw new Error("仅支持 replace 导入");
    renameLegacyDefaultInStores(payload.stores);
    const names = ["decks", "questions", "reviews", "wrong_book", "meta", "review_log"];
    const prevMute = syncMute;
    syncMute = true;
    try {
    // Single transaction clear+put for consistency
    await new Promise((resolve, reject) => {
      const t = tx(names, "readwrite");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("import abort"));
      for (const name of names) {
        const store = t.objectStore(name);
        store.clear();
        const rows = payload.stores[name] || [];
        for (const row of rows) {
          store.put(row);
        }
      }
    });
    const incoming = cursorsFromPayload(payload);
    if (incoming) {
      writeAllCursors(cursorMode === "merge" ? mergeCursorMaps(readAllCursors(), incoming) : incoming);
    }
    applyIncomingSettings(payload.settings, cursorMode);
    writeHeat(mergeHeat(readHeat(), payload.heat || {})); // per-day max; pd reset → 做题 days re-derived from the merged review_log
    if (payload.updatedAt) setLocalSyncUpdatedAt(payload.updatedAt);
    bankCache = [];
    } finally {
      syncMute = prevMute;
    }
  }

  /** fetch with a hard timeout so a stalled connection can never hang sync (or boot) forever */
  function fetchTimeout(url, opts, ms = 20000) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), ms);
    return fetch(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {})).finally(() => clearTimeout(timer));
  }
  async function syncApiGet(code) {
    const res = await fetchTimeout("/api/sync", {
      method: "GET",
      headers: { "X-Pair-Sync-Code": code },
      cache: "no-store",
    });
    return res;
  }
  async function syncApiPut(code, updatedAt, data) {
    const res = await fetchTimeout(
      "/api/sync",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Pair-Sync-Code": code,
        },
        body: JSON.stringify({ updatedAt, data }),
      },
      30000
    );
    return res;
  }

  function getSyncBase() {
    try {
      const v = localStorage.getItem(SYNC_BASE_KEY);
      if (v == null) {
        // first run of this version: treat everything we have as already synced
        const b = getLocalSyncUpdatedAt();
        localStorage.setItem(SYNC_BASE_KEY, String(b));
        return b;
      }
      return Number(v) || 0;
    } catch (_) {
      return 0;
    }
  }
  function setSyncBase(ts) {
    try {
      localStorage.setItem(SYNC_BASE_KEY, String(Number(ts) || 0));
    } catch (_) {}
  }
  let pushForce = false;

  async function localHasProgress() {
    const reviews = await getAll("reviews");
    if (reviews.some((r) => r.last_result != null)) return true;
    const all = readAllCursors();
    return Object.keys(all).some((k) => CURSOR_KINDS.some((kind) => normCursor(all[k][kind]).offset > 0));
  }

  /** Two devices may each have added the same bundled exam before syncing: keep one copy, carry progress over. */
  function dedupeBundledInStores(stores) {
    const byKey = new Map();
    for (const d of stores.decks || []) {
      if (!d.bundled_key) continue;
      if (!byKey.has(d.bundled_key)) byKey.set(d.bundled_key, []);
      byKey.get(d.bundled_key).push(d);
    }
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => Number(a.id) - Number(b.id));
      const keep = Number(list[0].id);
      const drop = new Set(list.slice(1).map((d) => Number(d.id)));
      const keepQ = new Map();
      for (const q of stores.questions) if (Number(q.deck_id) === keep) keepQ.set(dedupeKey(q.stem, q.answer), q.id);
      const remap = new Map();
      const dropQ = new Set();
      for (const q of stores.questions) {
        if (!drop.has(Number(q.deck_id))) continue;
        dropQ.add(q.id);
        const k = keepQ.get(dedupeKey(q.stem, q.answer));
        if (k != null) remap.set(q.id, k);
      }
      const revMap = new Map(stores.reviews.map((r) => [r.question_id, r]));
      for (const [from, to] of remap) {
        const a = revMap.get(from), b = revMap.get(to);
        if (a && a.last_result && !(b && b.last_result)) revMap.set(to, Object.assign({}, a, { question_id: to }));
      }
      for (const id of dropQ) revMap.delete(id);
      stores.reviews = [...revMap.values()];
      const wb = new Map(stores.wrong_book.map((w) => [w.question_id, w]));
      for (const [from, to] of remap) if (wb.has(from) && !wb.has(to)) wb.set(to, Object.assign({}, wb.get(from), { question_id: to }));
      for (const id of dropQ) wb.delete(id);
      stores.wrong_book = [...wb.values()];
      stores.review_log = stores.review_log.map((l) => (remap.has(l.question_id) ? Object.assign({}, l, { question_id: remap.get(l.question_id) }) : l)).filter((l) => !dropQ.has(l.question_id) || remap.has(l.question_id));
      stores.questions = stores.questions.filter((q) => !dropQ.has(q.id));
      stores.decks = stores.decks.filter((d) => !drop.has(Number(d.id)));
    }
  }

  /** Combine local and remote snapshots (used only when BOTH sides changed since the last sync). */
  function mergeSnapshots(local, remote) {
    const sa = (local && local.stores) || {};
    const sb = (remote && remote.stores) || {};
    const union = (la, lb, key, pick) => {
      const m = new Map();
      for (const r of la || []) m.set(r[key], r);
      for (const r of lb || []) {
        const x = m.get(r[key]);
        m.set(r[key], x ? pick(x, r) : r);
      }
      return [...m.values()];
    };
    const logKey = (r) => `${r.question_id}|${r.created_at}|${r.result}`;
    const remoteLogs = (sb.review_log || []).slice();
    const seen = new Set(remoteLogs.map(logKey));
    const extraLogs = [];
    for (const r of sa.review_log || []) {
      if (seen.has(logKey(r))) continue;
      const c = Object.assign({}, r);
      delete c.id;
      extraLogs.push(c);
    }
    const stores = {
      decks: union(sa.decks, sb.decks, "id", (l, r) => (r.name === LEGACY_DEFAULT_NAME && l.name === DEFAULT_DECK_NAME ? Object.assign({}, r, { name: l.name }) : r)),
      questions: union(sa.questions, sb.questions, "id", (l, r) => r),
      // an answered record always beats an untouched placeholder (fresh imports stamp updated_at = now)
      reviews: union(sa.reviews, sb.reviews, "question_id", (l, r) => {
        const la = !!(l && l.last_result), ra = !!(r && r.last_result);
        if (la !== ra) return la ? l : r;
        return String(l.updated_at || "") > String(r.updated_at || "") ? l : r;
      }),
      wrong_book: union(sa.wrong_book, sb.wrong_book, "question_id", (l, r) =>
        String(l.last_wrong_at || "") > String(r.last_wrong_at || "") ? l : r
      ),
      meta: union(sa.meta, sb.meta, "key", (l, r) => r),
      review_log: remoteLogs.concat(extraLogs),
    };
    dedupeBundledInStores(stores);
    renameLegacyDefaultInStores(stores);
    const cursors = mergeCursorMaps(cursorsFromPayload(local) || {}, cursorsFromPayload(remote) || {});
    const ls = local && local.settings;
    const rs = remote && remote.settings;
    const settings = !rs ? ls : !ls ? rs : (Number(ls.t) || 0) > (Number(rs.t) || 0) ? ls : rs;
    return {
      version: SYNC_VERSION,
      updatedAt: Math.max(Number(local && local.updatedAt) || 0, Number(remote && remote.updatedAt) || 0),
      stores,
      cursors,
      seqMeta: legacySeqMetaFrom(cursors),
      settings: settings || undefined,
      heat: mergeHeat(local && local.heat, remote && remote.heat),
    };
  }

  /**
   * Apply a remote snapshot when it is newer than what we last synced with.
   * - empty remote snapshots never replace local data
   * - if local ALSO has unsynced changes, the two are merged (nothing is dropped)
   */
  async function reconcileRemote(remote) {
    const rAt = Number(remote && remote.updatedAt) || 0;
    if (!remote || !remote.data || !remote.data.stores) return { applied: false };
    const base = getSyncBase();
    if (!(rAt > base)) return { applied: false };
    const rq = (remote.data.stores.questions || []).length;
    if (rq === 0 && (await countStore("questions")) > 0) return { applied: false, ignoredEmpty: true };
    const localAt = getLocalSyncUpdatedAt();
    if (localAt > base) {
      const merged = mergeSnapshots(await exportAllData(), remote.data);
      await importAllData(merged, { replace: true, cursorMode: "merge" });
      setLocalSyncUpdatedAt(Date.now());
      setSyncBase(rAt);
      return { applied: true, merged: true, updatedAt: rAt };
    }
    await importAllData(remote.data, { replace: true, cursorMode: "merge" });
    setLocalSyncUpdatedAt(rAt);
    setSyncBase(rAt);
    return { applied: true, updatedAt: rAt };
  }

  async function syncPullAndApply() {
    const code = getSyncCode();
    if (!code) return { ok: false, reason: "no-code" };
    if (!navigator.onLine) return { ok: false, reason: "offline" };
    const res = await syncApiGet(code);
    if (res.status === 404) return { ok: true, empty: true };
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "拉取失败 " + res.status);
    }
    const remote = await res.json();
    const r = await reconcileRemote(remote);
    return Object.assign({ ok: true, applied: false, empty: false, updatedAt: Number(remote.updatedAt) || 0 }, r);
  }

  async function syncPush({ force = false } = {}) {
    const code = getSyncCode();
    if (!code) return { ok: false, reason: "no-code" };
    if (!navigator.onLine) return { ok: false, reason: "offline" };
    if (syncInFlight) return { ok: false, reason: "busy" };
    syncInFlight = true;
    const doForce = force || pushForce;
    pushForce = false;
    let mergedRemote = false;
    try {
      if (!doForce) {
        // never blindly overwrite the cloud: look first, merge if someone else pushed meanwhile
        const g = await syncApiGet(code);
        if (g.ok) {
          const remote = await g.json();
          const r = await reconcileRemote(remote);
          if (r.applied && !r.merged) return { ok: true, appliedRemote: true, updatedAt: remote.updatedAt };
          if (r.merged) mergedRemote = true;
        } else if (g.status !== 404) {
          const err = await g.json().catch(() => ({}));
          throw new Error(err.error || "拉取失败 " + g.status);
        }
      }
      const data = stripDeviceMeta(await exportAllData());
      const updatedAt = Math.max(Number(data.updatedAt) || 0, getLocalSyncUpdatedAt(), Date.now());
      data.updatedAt = updatedAt;
      const res = await syncApiPut(code, updatedAt, data);
      if (res.status === 409) {
        const remote = await res.json().catch(() => ({}));
        if (remote.data) {
          const merged = mergeSnapshots(await exportAllData(), remote.data);
          await importAllData(merged, { replace: true, cursorMode: "merge" });
          setLocalSyncUpdatedAt(Math.max(Date.now(), (Number(remote.updatedAt) || 0) + 1));
          setSyncBase(Number(remote.updatedAt) || 0);
          scheduleSyncPush();
          return { ok: true, appliedRemote: true, updatedAt: remote.updatedAt };
        }
        throw new Error(remote.error || "远端更新");
      }
      if (res.status === 429) {
        return { ok: false, reason: "rate" };
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "推送失败 " + res.status);
      }
      const body = await res.json().catch(() => ({}));
      const at = body.updatedAt || updatedAt;
      setLocalSyncUpdatedAt(at);
      setSyncBase(at);
      return { ok: true, pushed: true, updatedAt: at, mergedRemote };
    } finally {
      syncInFlight = false;
    }
  }

  function scheduleSyncPush() {
    if (!getSyncCode()) return;
    if (!navigator.onLine) return;
    clearTimeout(syncPushTimer);
    syncPushPending = true;
    syncPushTimer = setTimeout(() => {
      syncPushPending = false;
      syncPush()
        .then(async (r) => {
          if (r && r.reason === "busy") scheduleSyncPush();
          if (r && r.ok) {
            syncStatusText = "已同步 " + formatSyncTime(getLocalSyncUpdatedAt());
            if ((r.appliedRemote || r.mergedRemote) && route !== "quiz" && route !== "study-quiz") {
              await refreshAfterSyncImport();
            }
          }
        })
        .catch((e) => console.warn("[sync] push", e));
    }, SYNC_PUSH_DEBOUNCE_MS);
  }
  let syncPushPending = false;

  async function syncNow() {
    const code = getSyncCode();
    if (!code) {
      toast("请先绑定同步码");
      return { ok: false };
    }
    if (!navigator.onLine) {
      toast("离线，稍后自动重试");
      return { ok: false, reason: "offline" };
    }
    toast("同步中…");
    try {
      const pull = await syncPullAndApply();
      if (pull.applied) {
        toast(pull.merged ? "已合并云端与本机进度" : "已从云端更新");
        await refreshAfterSyncImport();
      }
      const push = await syncPush();
      if (push.appliedRemote) {
        toast("已合并远端更新");
        await refreshAfterSyncImport();
      } else if (push.ok) {
        toast("同步完成");
      }
      syncStatusText = "已同步 " + formatSyncTime(getLocalSyncUpdatedAt());
      return { ok: true };
    } catch (e) {
      toast("同步失败：" + (e.message || e));
      return { ok: false, error: e };
    }
  }

  async function refreshAfterSyncImport() {
    bankCache = [];
    // Fix current deck if deleted remotely
    if (currentDeckId && !(await getDeck(currentDeckId))) {
      clearSavedDeck();
      currentDeckId = null;
      setNavVisible(false);
      await navigate("exams");
      return;
    }
    if (route === "exams" || !currentDeckId) {
      await navigate("exams");
    } else {
      await navigate(route === "quiz" || route === "study-quiz" ? "today" : route);
    }
    await updateHeaderStats();
  }

  /** resolves true when remote data was applied locally */
  async function maybeSyncOnBoot() {
    if (!getSyncCode() || !navigator.onLine) return false;
    try {
      const pull = await syncPullAndApply();
      if (pull.applied) {
        console.log("[sync] applied remote on boot", pull.merged ? "(merged)" : "");
      }
      // Push if local newer, remote empty, or we merged both sides
      if (pull.empty || !pull.applied || pull.merged) {
        await syncPush({ force: !!pull.empty });
      }
      return !!pull.applied;
    } catch (e) {
      console.warn("[sync] boot", e);
      return false;
    }
  }

  function formatSyncTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return "从未";
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** null = unknown yet, true/false = browser granted durable (non-evictable) storage */
  let storagePersisted = null;
  function storagePersistText() {
    if (storagePersisted === true) return "本机存储：已申请持久保护，不会被浏览器自动清理";
    if (storagePersisted === false) return "本机存储：浏览器未授予持久保护。请「添加到主屏幕」使用，并绑定同步码或定期导出备份";
    return "";
  }
  async function requestPersistentStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      let ok = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!ok) ok = await navigator.storage.persist();
      storagePersisted = !!ok;
    } catch (_) {}
  }

  function syncCardHtml({ bare = false } = {}) {
    const code = getSyncCode();
    const bound = isValidSyncCode(code);
    const last = formatSyncTime(getLocalSyncUpdatedAt());
    const display = bound ? formatSyncCodeDisplay(code) : "";
    return `
      <div class="${bare ? "sync-card sync-bare" : "card sync-card"}" id="sync-card">
        ${bare ? "" : `<h2 style="margin:0 0 8px;font-size:16px">云同步</h2>`}
        <p class="muted" style="margin:0 0 10px">同一同步码的设备自动同步进度，请勿分享</p>
        ${
          bound
            ? `<p class="sync-status">状态：<strong>已绑定</strong> · 上次同步 ${escapeHtml(last)}</p>
               <div class="sync-code-box" id="sync-code-show">${escapeHtml(display)}</div>
               <div class="btn-row" style="margin-top:8px">
                 <button type="button" class="btn" id="sync-copy">复制</button>
                 <button type="button" class="btn primary" id="sync-now">立即同步</button>
                 <button type="button" class="btn" id="sync-unbind">解除绑定</button>
               </div>`
            : `<div class="btn-row">
                 <button type="button" class="btn primary" id="sync-generate">生成本机同步码</button>
               </div>
               <div class="sync-bind-row" style="margin-top:10px">
                 <input class="search" id="sync-code-input" placeholder="输入同步码" autocomplete="off" spellcheck="false" />
                 <button type="button" class="btn" id="sync-bind">绑定</button>
               </div>`
        }
        <div class="backup-row">
          <p class="muted" style="margin:12px 0 8px">本地备份：导出 / 导入全部进度</p>
          <div class="btn-row">
            <button type="button" class="btn" id="backup-export">导出进度备份</button>
            <button type="button" class="btn" id="backup-import">导入进度备份</button>
          </div>
          <input type="file" id="backup-file" accept=".json,application/json" style="display:none" />
          <p class="muted persist-note" style="margin:10px 0 0">${storagePersistText()}</p>
        </div>
      </div>`;
  }

  // ---------- Progress backup file (same snapshot as cloud sync) ----------
  const BACKUP_KIND = "pair-progress-backup";
  function backupFileName() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    return `Pair-进度备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  }
  function isIosStandalone() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
    return ios && standalone;
  }
  function downloadBackupBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 4000);
  }
  async function exportProgressBackup() {
    const data = await exportAllData();
    delete data.syncCode; // never put the private sync code into a shareable file
    const payload = Object.assign({ kind: BACKUP_KIND, exportedAt: Date.now() }, data);
    const json = JSON.stringify(payload);
    const name = backupFileName();
    const blob = new Blob([json], { type: "application/json" });
    // iOS standalone PWA: blob download opens a viewer with no way back; prefer share sheet if possible
    if (isIosStandalone() && navigator.canShare && typeof File === "function") {
      try {
        const file = new File([json], name, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          toast("已导出进度备份");
          return;
        }
      } catch (e) {
        if (e && e.name === "AbortError") return;
        console.warn("[backup] share failed, fallback to download", e);
      }
    }
    downloadBackupBlob(blob, name);
    toast("已导出进度备份");
  }
  function validateBackupPayload(p) {
    if (!p || typeof p !== "object") return "文件内容不是有效 JSON 对象";
    if (p.kind && p.kind !== BACKUP_KIND) return "不是 Pair 进度备份文件";
    if (!p.stores || typeof p.stores !== "object") return "缺少 stores 数据";
    const names = ["decks", "questions", "reviews", "wrong_book", "meta", "review_log"];
    for (const n of names) {
      if (p.stores[n] != null && !Array.isArray(p.stores[n])) return "数据格式错误：" + n;
    }
    if (!Array.isArray(p.stores.decks) || !Array.isArray(p.stores.questions)) return "缺少题库数据";
    if (p.seqMeta != null && typeof p.seqMeta !== "object") return "顺序进度格式错误";
    return "";
  }
  async function importProgressBackupFile(file) {
    let payload;
    try {
      const text = await file.text();
      payload = JSON.parse(text);
    } catch (_) {
      toast("导入失败：无法解析 JSON");
      return false;
    }
    const err = validateBackupPayload(payload);
    if (err) {
      toast("导入失败：" + err);
      return false;
    }
    if (!confirm("导入会覆盖本机当前进度，确定吗？")) return false;
    try {
      const data = Object.assign({}, payload);
      delete data.kind;
      delete data.exportedAt;
      delete data.syncCode;
      await importAllData(data, { replace: true, cursorMode: "replace" });
      // Local import is now the newest state: mark it and push (debounced) if bound
      setLocalSyncUpdatedAt(Date.now());
      pushForce = true; // a restored backup replaces the cloud copy instead of merging with it
      scheduleSyncPush();
      await refreshAfterSyncImport();
      toast("导入成功");
      return true;
    } catch (e) {
      toast("导入失败：" + (e.message || e));
      return false;
    }
  }

  function bindSyncCardHandlers(afterChange) {
    $("#backup-export")?.addEventListener("click", async () => {
      try {
        await exportProgressBackup();
      } catch (e) {
        toast("导出失败：" + (e.message || e));
      }
    });
    $("#backup-import")?.addEventListener("click", () => {
      const inp = $("#backup-file");
      if (!inp) return;
      inp.value = "";
      inp.click();
    });
    $("#backup-file")?.addEventListener("change", async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      await importProgressBackupFile(f);
    });
    $("#sync-generate")?.addEventListener("click", async () => {
      const code = generateSyncCode();
      setSyncCode(code);
      setLocalSyncUpdatedAt(Date.now());
      toast("已生成同步码");
      try {
        await syncPush({ force: true });
      } catch (e) {
        console.warn(e);
      }
      if (afterChange) afterChange();
    });
    $("#sync-bind")?.addEventListener("click", async () => {
      const raw = ($("#sync-code-input")?.value || "").replace(/\s+/g, "");
      if (!isValidSyncCode(raw)) {
        toast("同步码需至少 16 位字母数字");
        return;
      }
      setSyncCode(raw);
      toast("绑定中…");
      try {
        const res = await syncApiGet(raw);
        if (res.status === 404) {
          setLocalSyncUpdatedAt(Date.now());
          await syncPush({ force: true });
          toast("已绑定（云端为空，已上传本机）");
        } else if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "拉取失败 " + res.status);
        } else {
          const remote = await res.json();
          const rAt = Number(remote.updatedAt) || 0;
          const rq = remote.data && remote.data.stores ? (remote.data.stores.questions || []).length : 0;
          if (!rq) {
            // an empty cloud snapshot never replaces local data
            setLocalSyncUpdatedAt(Date.now());
            await syncPush({ force: true });
            toast("已绑定（云端无题库，已上传本机）");
          } else {
            let merged = false;
            if (await localHasProgress()) {
              const useCloud = confirm(
                "云端和本机都有进度。\n点「确定」：用云端进度覆盖本机\n点「取消」：合并两边（各自保留较新的进度）"
              );
              if (!useCloud) {
                const m = mergeSnapshots(await exportAllData(), remote.data);
                await importAllData(m, { replace: true, cursorMode: "merge" });
                merged = true;
              }
            }
            if (!merged) await importAllData(remote.data, { replace: true, cursorMode: "replace" });
            setSyncBase(rAt);
            setLocalSyncUpdatedAt(merged ? Date.now() : rAt);
            if (merged) await syncPush({ force: true });
            toast(merged ? "已绑定并合并进度" : "已绑定并拉取云端进度");
            await refreshAfterSyncImport();
          }
        }
      } catch (e) {
        toast("绑定失败：" + (e.message || e));
      }
      if (afterChange) afterChange();
    });
    $("#sync-copy")?.addEventListener("click", async () => {
      const code = getSyncCode();
      try {
        await navigator.clipboard.writeText(code);
        toast("已复制同步码");
      } catch (_) {
        prompt("复制同步码", code);
      }
    });
    $("#sync-now")?.addEventListener("click", async () => {
      await syncNow();
      if (afterChange) afterChange();
    });
    $("#sync-unbind")?.addEventListener("click", () => {
      if (!confirm("解除绑定？本机数据保留，不再自动同步。")) return;
      setSyncCode("");
      toast("已解除绑定");
      if (afterChange) afterChange();
    });
  }

  // ---------- Heatmap (首页热力图): per-day counts, Asia/Shanghai dates ----------
  // localStorage[HEAT_KEY] = { s: { "YYYY-MM-DD": 背题数 }, p: { day: 做题数 }, pd: 1 once 做题 history was derived from review_log }
  const HEAT_KEY = "pair_heat_v1";
  const HEAT_WEEKS = 20;
  function shDay(ms) {
    return new Date((ms == null ? Date.now() : ms) + 8 * 3600000).toISOString().slice(0, 10);
  }
  function readHeat() {
    try {
      const h = JSON.parse(localStorage.getItem(HEAT_KEY) || "{}");
      return { s: h && typeof h.s === "object" && h.s ? h.s : {}, p: h && typeof h.p === "object" && h.p ? h.p : {}, pd: h && h.pd ? 1 : 0 };
    } catch (_) {
      return { s: {}, p: {}, pd: 0 };
    }
  }
  function writeHeat(h) {
    try {
      localStorage.setItem(HEAT_KEY, JSON.stringify(h));
    } catch (_) {}
  }
  function maxMerge(a, b) {
    const o = Object.assign({}, a || {});
    for (const k in b || {}) {
      const v = Number(b[k]) || 0;
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v > (Number(o[k]) || 0)) o[k] = v;
    }
    return o;
  }
  /** per-day max: safe for repeated syncs (never double counts) */
  function mergeHeat(a, b) {
    if (!a && !b) return undefined;
    a = a || {};
    b = b || {};
    return { s: maxMerge(a.s, b.s), p: maxMerge(a.p, b.p), pd: 0 };
  }
  function heatBump(kind) {
    const h = readHeat();
    const d = shDay();
    const m = kind === "study" ? h.s : h.p;
    m[d] = (Number(m[d]) || 0) + 1;
    writeHeat(h);
  }
  /** one-time (and after each sync import) backfill of 做题 days from review_log timestamps */
  async function deriveHeatFromLogs() {
    const logs = await getAll("review_log");
    const p = {};
    for (const r of logs) {
      const t = Date.parse(r && r.created_at);
      if (!isFinite(t)) continue;
      const d = shDay(t);
      p[d] = (p[d] || 0) + 1;
    }
    const h = readHeat();
    h.p = maxMerge(h.p, p);
    h.pd = 1;
    writeHeat(h);
    return h;
  }
  function heatLevel(n) {
    return n <= 0 ? 0 : n < 10 ? 1 : n < 30 ? 2 : n < 60 ? 3 : 4;
  }
  function heatHtml(h) {
    const DAY = 86400000;
    const today = shDay();
    const t0 = Date.parse(today + "T00:00:00Z");
    const dow = (new Date(t0).getUTCDay() + 6) % 7; // Monday = 0
    const start = t0 - (dow + 7 * (HEAT_WEEKS - 1)) * DAY;
    let cells = "";
    for (let w = 0; w < HEAT_WEEKS; w++) {
      for (let r = 0; r < 7; r++) {
        const ms = start + (w * 7 + r) * DAY;
        const d = new Date(ms).toISOString().slice(0, 10);
        if (d > today) {
          cells += `<i class="hc future"></i>`;
          continue;
        }
        const s = Number(h.s[d]) || 0;
        const p = Number(h.p[d]) || 0;
        cells += `<i class="hc l${heatLevel(s + p)}${d === today ? " today" : ""}" data-d="${d}" data-s="${s}" data-p="${p}"></i>`;
      }
    }
    // totals / streak over all recorded days
    const act = new Set();
    for (const k in h.s) if (Number(h.s[k]) > 0) act.add(k);
    for (const k in h.p) if (Number(h.p[k]) > 0) act.add(k);
    const has = (d) => act.has(d);
    let streak = 0;
    let cur = has(today) ? t0 : t0 - DAY; // today still counts as "in progress"
    while (has(new Date(cur).toISOString().slice(0, 10))) {
      streak++;
      cur -= DAY;
    }
    return `
      <div class="heat-grid" style="grid-template-columns:repeat(${HEAT_WEEKS},1fr)">${cells}</div>
      <div class="heat-foot">
        <span id="heat-tip">活跃 <b>${act.size}</b> 天 · 连续 <b>${streak}</b> 天</span>
        <span class="heat-legend">少<i class="hc l0"></i><i class="hc l1"></i><i class="hc l2"></i><i class="hc l3"></i><i class="hc l4"></i>多</span>
      </div>`;
  }
  function paintHeat(h) {
    const box = $("#heat");
    if (!box) return;
    box.innerHTML = heatHtml(h);
  }
  function mountHeat(seq) {
    const box = $("#heat");
    if (!box) return;
    const h = readHeat();
    paintHeat(h);
    let sel = null;
    box.addEventListener("click", (e) => {
      const c = e.target.closest(".hc[data-d]");
      const tip = $("#heat-tip");
      if (!c || !tip) return;
      if (sel) sel.classList.remove("sel");
      if (sel === c) {
        sel = null;
        paintHeat(readHeat());
        return;
      }
      sel = c;
      c.classList.add("sel");
      const [, m, d] = c.dataset.d.split("-");
      tip.innerHTML = `${Number(m)}月${Number(d)}日 · 背题 <b>${c.dataset.s}</b> · 做题 <b>${c.dataset.p}</b>`;
    });
    if (!h.pd) {
      deriveHeatFromLogs()
        .then((nh) => {
          if (seq === navSeq && route === "today") paintHeat(nh);
        })
        .catch((e) => console.warn("[heat]", e));
    }
  }

  // ---------- Changelog (更新说明) ----------
  const CHANGELOG = {
    v29: [
      "首页新增背题热力图，背得越多颜色越深",
      "点一下格子可看当天背题、做题数量",
      "如果有问题请联系：qzh_0813",
    ],
    v28: [
      "使用说明与更新记录改到首页选考试的「更多」里",
      "如果有问题请联系：qzh_0813",
    ],
    v27: [
      "「更多」改为只显示更新记录（去掉完整使用说明）",
      "如果有问题请联系：qzh_0813",
    ],
    v26: [
      "曾加入使用说明（现已精简为更新记录）",
      "答错停留时间可在「更多 → 做题设置」里调整（默认 5 秒）",
      "如果有问题请联系：qzh_0813",
    ],
    v25: [
      "答错后停留时间可自己改：打开「更多 → 做题设置 → 答错停留」，默认仍是 5 秒，也可改成立刻跳过或更长",
      "有新版本时会弹出本说明，点一下后本机不再显示，直到下次更新",
      "如果有问题请联系：qzh_0813",
    ],
  };
  function getSeenChangelog() {
    try {
      return localStorage.getItem(CHANGELOG_KEY) || "";
    } catch (_) {
      return "";
    }
  }
  function setSeenChangelog(build) {
    try {
      localStorage.setItem(CHANGELOG_KEY, String(build || BUILD));
    } catch (_) {}
  }
  function changelogNotes(build) {
    const list = CHANGELOG[build];
    return Array.isArray(list) ? list.filter(Boolean) : [];
  }
  function dismissChangelog() {
    setSeenChangelog(BUILD);
    document.getElementById("chg-overlay")?.remove();
  }
  function maybeShowChangelog() {
    if (getSeenChangelog() === BUILD) return;
    const notes = changelogNotes(BUILD);
    if (!notes.length) {
      setSeenChangelog(BUILD);
      return;
    }
    if (document.getElementById("chg-overlay")) return;
    const el = document.createElement("div");
    el.id = "chg-overlay";
    el.className = "chg-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "更新说明");
    el.innerHTML = `
      <div class="chg-card">
        <h2>Pair 更新说明（${escapeHtml(BUILD)}）</h2>
        <ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
        <button type="button" class="btn" id="chg-ok">知道了</button>
      </div>`;
    document.body.appendChild(el);
    $("#chg-ok", el)?.addEventListener("click", dismissChangelog);
  }

  function toast(text) {
    let el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  // ---------- Navigation ----------
  function setActiveNav(name) {
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.nav === name);
    });
  }

  let foldOpen = false; // keep the 更多 / 云同步 fold open across the re-render a sync action triggers
  let navSeq = 0; // bumped on every navigation; async renders drop their result if it no longer matches
  const SUB_ROUTES = ["practice", "study", "bank", "import"]; // live under 「更多」

  /** back link + title for secondary pages */
  function subHead(title, back = "more") {
    const label = back === "exams" ? "考试" : "更多";
    return `<div class="sub-head"><button type="button" class="back-link" data-go="${back}">← ${label}</button><h1>${title}</h1></div>`;
  }

  /** The view paints first (from memory / last-known numbers); data fills in afterwards. */
  function navigate(name) {
    return navigateInner(name).catch((e) => {
      console.error("[navigate]", name, e);
      const host = app();
      if (host && !host.children.length) showFatal(e); // never leave a blank page behind
    });
  }
  async function navigateInner(name) {
    hideBoard();
    if (name !== "practice") randFoldOpen = false;
    stopTimer();
    clearAdvance();
    answering = false;
    route = name;
    const seq = ++navSeq;
    const host = app();
    host.dataset.route = name;
    window.scrollTo(0, 0);
    if (name === "exams") {
      currentDeckId = null;
      setNavVisible(false);
      setActiveNav("");
      updateHeaderStats();
      return renderExams(seq);
    }
    // home-only pages (no deck selected): 使用说明 / 更新记录
    if (name === "guide" || name === "changelog") {
      currentDeckId = null;
      setNavVisible(false);
      setActiveNav("");
      updateHeaderStats();
      return name === "guide" ? renderGuide() : renderChangelog();
    }
    if (!currentDeckId) {
      return navigate("exams");
    }
    const immersive = name === "quiz" || name === "study-quiz";
    setNavVisible(!immersive);
    setActiveNav(SUB_ROUTES.includes(name) ? "more" : immersive ? "" : name);
    updateHeaderStats();
    if (name === "today") return renderToday(seq);
    if (name === "more") return renderMore();
    if (name === "practice") return renderPracticeMenu(seq);
    if (name === "study") return renderStudyMenu(seq);
    if (name === "wrong") return renderWrong(seq);
    if (name === "bank") return renderBank(true, seq);
    if (name === "import") return renderImport();
    if (name === "quiz") return renderQuiz();
    if (name === "study-quiz") return renderStudy();
  }

  /** paint immediately with the last known counts, then correct in place once the real numbers are in */
  async function withStats(seq, paint) {
    const id = currentDeckId;
    const peek = peekStats(id);
    paint(peek, false);
    const real = await statsForDeck(id);
    if (seq !== navSeq || id !== currentDeckId) return;
    if (!sameStats(peek, real)) paint(real, true);
  }

  function statLineHtml(s) {
    const v = (x) => (s ? x : "…");
    return `总数 <b>${v(s && s.total)}</b> · 未做 <b>${v(s && s.fresh)}</b> · 待复习 <b>${v(s && s.due)}</b>`;
  }

  // ---------- Views: exams home ----------
  function deckStatsHtml(s) {
    return `<span>总数 <strong>${s ? s.total : "…"}</strong></span><span>未做 <strong>${s ? s.fresh : "…"}</strong></span><span>待复习 <strong>${s ? s.due : "…"}</strong></span>`;
  }

  async function renderExams(seq) {
    const decks = await listDecks();
    if (seq !== navSeq) return;
    // 非「默认题库」靠前（如事规在上），默认题库沉底；同组按 id 倒序（新建在上）
    decks.sort((a, b) => {
      const aDef = a.name === LEGACY_DEFAULT_NAME || a.name === DEFAULT_DECK_NAME ? 1 : 0;
      const bDef = b.name === LEGACY_DEFAULT_NAME || b.name === DEFAULT_DECK_NAME ? 1 : 0;
      if (aDef !== bDef) return aDef - bDef;
      return (b.id || 0) - (a.id || 0);
    });
    app().innerHTML = `
      <div id="deck-list">${decks
        .map(
          (d) => `
      <div class="deck-card" data-id="${d.id}">
        <div class="deck-top"><div class="deck-name">${escapeHtml(d.name)}</div><button type="button" class="deck-more" data-act="toggle" aria-label="管理">⋯</button></div>
        <div class="deck-stats" data-stats="${d.id}">${deckStatsHtml(peekStats(d.id))}</div>
        <div class="deck-actions">
          <button type="button" class="btn" data-act="rename">重命名</button>
          <button type="button" class="btn" data-act="clear">清空题目</button>
          <button type="button" class="btn" data-act="delete">删除考试</button>
        </div>
      </div>`
        )
        .join("")}</div>
      ${decks.length ? "" : `<div class="empty">暂无考试</div>`}
      <button class="btn primary" id="new-deck">新建考试</button>
      <details class="fold" id="exam-more" ${foldOpen ? "open" : ""}>
        <summary>更多</summary>
        <div class="fold-body">
          <div class="menu exam-home-more">
            <button type="button" class="row" data-go="guide"><span>使用说明</span><i>›</i></button>
            <button type="button" class="row" data-go="changelog"><span>更新记录</span><i>›</i></button>
          </div>
          <button class="btn" id="split-source">按来源拆成考试</button>
          ${syncCardHtml({ bare: true })}
        </div>
      </details>
    `;
    const list = $("#deck-list");
    // numbers fill in after first paint (one pass over cached lists)
    (async () => {
      for (const d of decks) {
        const st = await statsForDeck(d.id);
        if (seq !== navSeq) return;
        const el = list.querySelector(`[data-stats="${d.id}"]`);
        if (el) el.innerHTML = deckStatsHtml(st);
      }
    })();

    $("#new-deck").onclick = async () => {
      const name = prompt("考试名称", "新考试");
      if (name == null) return;
      const id = await createDeck(name);
      toast("已创建");
      enterDeck(id);
    };

    $("#split-source").onclick = async () => {
      if (!confirm("按题目的来源文件名（source_file）拆成多个考试？将移动题目到对应考试卡片。")) return;
      const r = await splitBySourceFile(null);
      if (!r.ok) {
        toast(r.reason);
        return;
      }
      toast(`已拆分：新建 ${r.created} 个考试，移动 ${r.moved} 题`);
      currentDeckId = null;
      clearSavedDeck();
      setNavVisible(false);
      navigate("exams");
    };

    list.onclick = async (ev) => {
      const card = ev.target.closest(".deck-card");
      if (!card) return;
      const id = Number(card.dataset.id);
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (act === "toggle") {
        card.classList.toggle("show-actions");
        return;
      }
      if (act === "rename") {
        const d = await getDeck(id);
        const name = prompt("重命名考试", d ? d.name : "");
        if (name == null) return;
        await renameDeck(id, name);
        toast("已重命名");
        navigate("exams");
        return;
      }
      if (act === "clear") {
        const d = await getDeck(id);
        if (!confirm(`清空考试「${d ? d.name : id}」下全部题目？（保留空卡片）`)) return;
        const n = await clearDeckQuestions(id);
        toast(`已清空 ${n} 题`);
        navigate("exams");
        return;
      }
      if (act === "delete") {
        const d = await getDeck(id);
        if (!confirm(`确认删除考试「${d ? d.name : id}」？将删除其全部题目、复习与错题。`)) return;
        await deleteDeck(id);
        toast("已删除考试");
        navigate("exams");
        return;
      }
      enterDeck(id);
    };

    // long-press also toggles actions visibility
    let pressTimer = null;
    list.addEventListener("pointerdown", (ev) => {
      const card = ev.target.closest(".deck-card");
      if (!card || ev.target.closest("[data-act]")) return;
      pressTimer = setTimeout(() => card.classList.toggle("show-actions"), 500);
    });
    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };
    list.addEventListener("pointerup", clearPress);
    list.addEventListener("pointerleave", clearPress);
    list.addEventListener("pointercancel", clearPress);

    foldOpen = false;
    bindSyncCardHandlers(() => {
      foldOpen = true;
      navigate("exams");
    });
  }

  function progressName(kind) {
    return kind === "study" ? "背题进度" : "做题进度";
  }

  function scopeText(c, total) {
    const parts = [];
    if (c.from > 0 || c.to > 0) parts.push(`#${c.from > 0 ? c.from : 1}–#${c.to > 0 ? Math.min(c.to, total) : total}`);
    if (c.qtypes.length) parts.push(c.qtypes.join("/"));
    if (c.status === "new") parts.push("没做过的");
    else if (c.status === "wrong") parts.push("错题");
    return parts.join(" · ") || "全题库";
  }

  function pbarHtml(done, total) {
    const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    return `<div class="pbar"><i style="width:${pct.toFixed(2)}%"></i></div>`;
  }

  /** 「背题进度 X / 总数」 or 「做题进度 X / 总数」 block with its own bar (study and practice never share one) */
  function progressBlockHtml(kind, total) {
    const p = cursorProgress(kind, total);
    return `<div class="deck-progress" data-kind="${kind}">
        <div class="deck-progress-row"><span>${progressName(kind)}</span><strong>${p.done} / ${p.of}</strong></div>
        ${pbarHtml(p.done, p.of)}
        ${p.scoped ? `<div class="scope-line">范围：${escapeHtml(scopeText(p.c, total))}（题库共 ${total} 题）</div>` : ""}
      </div>`;
  }

  function nextFromLabel(kind, total) {
    const c = readCursor(kind, currentDeckId);
    const first = c.from > 0 ? c.from - 1 : 0;
    const at = Math.min(Math.max(c.offset, first), total || 0);
    return `${progressName(kind)}：下次从 #${at + 1} 开始`;
  }

  /** position (1-based) of question q inside the active range, for headers */
  function positionInScope(kind, q, total) {
    const p = cursorProgress(kind, total);
    const pos = (Number(q._idx) || 0) + 1 - (p.from - 1);
    return { pos: Math.max(1, Math.min(p.of || 1, pos)), of: p.of };
  }

  function resetRound() {
    roundAns = [];
    studySeen = [];
  }

  /** counts of the current timed round, straight from the per-index answers (nothing can be counted twice) */
  function roundCounts() {
    let ok = 0, bad = 0, to = 0, un = 0;
    for (let i = 0; i < queue.length; i++) {
      const r = roundAns[i];
      if (!r) un++;
      else if (r.r === "ok") ok++;
      else if (r.r === "to") to++;
      else bad++;
    }
    return { ok, bad, to, un };
  }
  /** next unanswered index after `from`, wrapping around; -1 when every question is answered */
  function nextUnanswered(from) {
    const n = queue.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!roundAns[i]) return i;
    }
    return -1;
  }

  // ---------- Unfinished round (survives reload / ✕; resumed by 「继续做题」「继续背题」) ----------
  function roundKindNow() {
    return queueMode === "study" ? "study" : queueMode === "random" ? "random" : "practice";
  }
  function roundPersistable() {
    if (roundIsRedo || !queue.length) return false;
    if (queueMode === "random") return true; // a long random test survives reload / ✕ too
    return seqMove && (queueMode === "seq" || queueMode === "study");
  }
  function readRounds() {
    try {
      const o = JSON.parse(localStorage.getItem(ROUND_KEY) || "{}");
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (_) {}
    return {};
  }
  function writeRounds(o) {
    try {
      localStorage.setItem(ROUND_KEY, JSON.stringify(o));
    } catch (_) {}
  }
  function saveRound() {
    if (!roundPersistable()) return;
    const kind = roundKindNow();
    const o = readRounds();
    o[kind] = {
      deck: currentDeckId,
      t: Date.now(),
      ids: queue.map((q) => Number(q.id)),
      ans: kind !== "study" ? queue.map((_, i) => roundAns[i] || 0) : undefined,
      seen: kind === "study" ? queue.map((_, i) => (studySeen[i] ? 1 : 0)) : undefined,
      qIndex,
      seqBatch,
      seqSession,
    };
    writeRounds(o);
  }
  function clearSavedRound(kind) {
    const o = readRounds();
    if (o[kind]) {
      delete o[kind];
      writeRounds(o);
    }
  }
  /** pick up an unfinished sequential round of this deck; false = nothing to resume */
  async function resumeRound(kind) {
    const s = readRounds()[kind];
    if (!s || typeof s !== "object") return false;
    const ids = Array.isArray(s.ids) ? s.ids : [];
    const flags = kind === "study" ? (Array.isArray(s.seen) ? s.seen : []) : Array.isArray(s.ans) ? s.ans : [];
    const fresh = Date.now() - (Number(s.t) || 0) < ROUND_TTL_MS;
    if (Number(s.deck) !== Number(currentDeckId) || !fresh || !ids.length || !ids.some((_, i) => !flags[i])) {
      clearSavedRound(kind);
      return false;
    }
    const sorted = await getSortedQuestions(currentDeckId);
    const idMap = new Map(sorted.map((q, i) => [Number(q.id), i]));
    const picked = ids.map((id) => idMap.get(Number(id)));
    if (picked.some((i) => i == null)) {
      clearSavedRound(kind);
      return false;
    }
    const ctx = await loadScopeContext();
    const qs = enrichFromMap(picked.map((i) => sorted[i]), ctx.reviews);
    qs.forEach((q, i) => {
      q._idx = picked[i];
    });
    queue = qs;
    roundIsRedo = false;
    seqMove = kind !== "random"; // random tests never move 做题进度
    seqBatch = { start: picked[0], count: qs.length, total: sorted.length };
    if (s.seqSession && typeof s.seqSession === "object") seqSession = s.seqSession;
    const at = Math.max(0, Math.min(qs.length - 1, Number(s.qIndex) | 0));
    if (kind === "study") {
      queueMode = "study";
      roundAns = [];
      studySeen = qs.map((_, i) => !!flags[i]);
      qIndex = at;
      navigate("study-quiz");
    } else {
      queueMode = kind === "random" ? "random" : "seq";
      studySeen = [];
      roundAns = qs.map((_, i) => {
        const a = flags[i];
        return a && (a.r === "ok" || a.r === "bad" || a.r === "to") ? { r: a.r, p: a.p || null } : null;
      });
      qIndex = roundAns[at] ? Math.max(0, nextUnanswered(at)) : at;
      navigate("quiz");
    }
    return true;
  }

  /** Start a timed quiz round with given list */
  function startQuiz(list, mode, { redo = false } = {}) {
    queue = list;
    queueMode = mode;
    qIndex = 0;
    roundIsRedo = !!redo;
    if (redo) seqMove = false; // redo rounds never move the cursor
    resetRound();
    saveRound();
    navigate("quiz");
  }

  // ---------- 题板 (answer sheet) ----------
  let boardEl = null;
  function ensureBoard() {
    if (boardEl) return boardEl;
    const el = document.createElement("div");
    el.className = "board";
    el.id = "board";
    el.hidden = true;
    el.innerHTML = `<div class="board-mask" data-close></div>
      <div class="board-sheet" role="dialog" aria-modal="true" aria-label="题板">
        <div class="board-top"><strong>题板</strong><button type="button" class="board-x" data-close aria-label="关闭">✕</button></div>
        <div class="board-stats" id="board-stats"></div>
        <div class="board-grid" id="board-grid"></div>
        <div class="board-foot" id="board-foot"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-close]")) return closeBoard();
      const c = ev.target.closest(".cell");
      if (c) jumpTo(Number(c.dataset.i));
    });
    wireTimeSeg(el.querySelector("#board-foot"));
    boardEl = el;
    return el;
  }
  function boardStat(n, label, sw, extra = "") {
    return `<div><b>${n}</b>${extra}<span>${sw != null ? `<i class="sw ${sw}"></i>` : ""}${label}</span></div>`;
  }
  function openBoard() {
    if (!queue.length || qIndex >= queue.length) return;
    const el = ensureBoard();
    const study = route === "study-quiz";
    const n = queue.length;
    let html = "";
    let a = 0, b = 0, to = 0, u = 0;
    for (let i = 0; i < n; i++) {
      let cls = "cell";
      if (study) {
        if (studySeen[i]) {
          cls += " ok";
          a++;
        } else u++;
      } else {
        const r = roundAns[i];
        if (!r) u++;
        else if (r.r === "ok") {
          cls += " ok";
          a++;
        } else {
          cls += " bad";
          b++;
          if (r.r === "to") to++;
        }
      }
      if (i === qIndex) cls += " cur";
      html += `<button type="button" class="${cls}" data-i="${i}">${i + 1}</button>`;
    }
    const cur = boardStat(qIndex + 1, "当前", null, `<small>/${n}</small>`);
    el.querySelector("#board-stats").innerHTML = study
      ? boardStat(a, "已看", "ok") + boardStat(u, "未看", "") + cur
      : boardStat(a, "答对", "ok") + boardStat(b, to ? `答错<em>含超时${to}</em>` : "答错", "bad") + boardStat(u, "未答", "") + cur;
    const grid = el.querySelector("#board-grid");
    grid.innerHTML = html;
    el.querySelector("#board-foot").innerHTML = study
      ? ""
      : `<div class="board-foot-l"><span>每题时间</span><span class="muted">下一题起生效</span></div>${timeSegHtml("board-time")}`;
    el.classList.toggle("study", study);
    el.hidden = false;
    boardOpen = true;
    const btn = $("#board-btn");
    if (btn) btn.setAttribute("aria-expanded", "true");
    void el.offsetWidth; // start the slide from the closed position
    el.classList.add("open");
    const c = grid.querySelector(".cur");
    if (c && c.offsetTop + c.offsetHeight > grid.clientHeight) grid.scrollTop = c.offsetTop - grid.clientHeight / 2;
    else grid.scrollTop = 0;
  }
  /** close without side effects (navigation, jump) */
  function hideBoard() {
    boardOpen = false;
    pendingAdvance = null;
    if (!boardEl) return;
    boardEl.classList.remove("open");
    boardEl.hidden = true;
  }
  /** user closed the sheet: resume the countdown / a due auto-advance */
  function closeBoard() {
    const run = pendingAdvance;
    hideBoard();
    const btn = $("#board-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (run) run();
  }
  function jumpTo(i) {
    if (!(i >= 0 && i < queue.length)) return;
    hideBoard();
    clearAdvance();
    stopTimer();
    qIndex = i;
    saveRound();
    if (route === "study-quiz") renderStudy();
    else renderQuiz();
  }
  function boardBtnHtml() {
    return `<button type="button" class="board-btn" id="board-btn" aria-haspopup="dialog" aria-expanded="false">题板 <b>${qIndex + 1}</b>/${queue.length}</button>`;
  }

  async function startMore() {
    const mode = queueMode;
    if (mode === "seq") return startSeqPractice({ n: MORE_N });
    if (mode === "random") return startRandomTest();
    if (mode === "practice") {
      const list = await getRandomQuestions(MORE_N);
      if (!list.length) return toast("题库为空");
      return startQuiz(list, "practice");
    }
    if (mode === "due") {
      const list = (await getDueQuestions()).slice(0, MORE_N);
      if (!list.length) {
        toast("暂无到期题目");
        return navigate("today");
      }
      return startQuiz(list, "due");
    }
    if (mode === "wrong") {
      const list = (await getWrongList()).slice(0, MORE_N);
      if (!list.length) {
        toast("错题本已清空");
        return navigate("wrong");
      }
      return startQuiz(list, "wrong");
    }
    return navigate("today");
  }

  function startRedoWrong(prevQueue, wrongIds) {
    const byId = new Map(prevQueue.map((q) => [Number(q.id), q]));
    const list = wrongIds.map((id) => byId.get(Number(id))).filter(Boolean);
    if (!list.length) return toast("本轮没有错题");
    startQuiz(list, queueMode, { redo: true });
  }

  function progLabel(kind, total) {
    const p = cursorProgress(kind, total || 0);
    return `${p.scoped ? "范围" : ""}${progressName(kind)} ${total == null ? "…" : p.done} / ${total == null ? "…" : p.of}`;
  }

  /** Home: deck stats in one line, two big buttons. Paints instantly; numbers refresh in place. */
  function renderToday(seq) {
    app().innerHTML = `
      <div class="stat-line" id="stat-line"></div>
      <button class="btn primary big" id="btn-seq"><span>继续做题</span><small id="sub-seq"></small></button>
      <button class="btn big" id="btn-study"><span>继续背题</span><small id="sub-study"></small></button>
      <button type="button" class="rand-entry" id="btn-rand">${randEntryLabel()}</button>
      <section class="heat" id="heat" aria-label="每天背题 + 做题数量"></section>
      <p class="hint" id="home-hint">${timeHint()} · 点选即提交 · 自动下一题</p>
      <p class="disclaimer">题目仅供练习参考，答案以现行规章和作业指导书为准</p>
    `;
    const fill = (s) => {
      const line = $("#stat-line");
      if (!line) return;
      line.innerHTML = statLineHtml(s);
      const total = s ? s.total : null;
      $("#sub-seq").textContent = progLabel("practice", total);
      $("#sub-study").textContent = progLabel("study", total);
      $("#btn-seq").disabled = !!s && !s.total;
      $("#btn-study").disabled = !!s && !s.total;
    };
    // an unfinished round (✕ / reload / jumped ahead on the 题板) is picked up first, otherwise a new batch
    $("#btn-seq").addEventListener("click", async () => {
      if (!(await resumeRound("practice"))) startSeqPractice({ n: MORE_N });
    });
    $("#btn-study").addEventListener("click", async () => {
      if (!(await resumeRound("study"))) startStudy({ n: MORE_N });
    });
    $("#btn-rand").addEventListener("click", async () => {
      if (await resumeRound("random")) return;
      randFoldOpen = true;
      navigate("practice");
    });
    mountHeat(seq);
    return withStats(seq, fill);
  }


  /** 首页「更多 → 使用说明」：简明教程（无考试时也可看） */
  function renderGuide() {
    app().innerHTML = `
      ${subHead("使用说明", "exams")}
      <article class="guide">
        <p class="guide-lead">Pair 刷题小工具。题目仅供练习参考，答案以现行规章和作业指导书为准。</p>
        <h2>第一次打开</h2>
        <ol>
          <li>手机浏览器打开本站（iPhone 建议 Safari）。</li>
          <li>可「添加到主屏幕」当 App 用。</li>
          <li>首页点进一套考试即可开始。首次需短暂联网下载题库，之后多可离线刷。</li>
        </ol>
        <h2>做题</h2>
        <ul>
          <li>选出答案后自动提交；答对马上下一题。</li>
          <li>答错 / 超时会先显示正确答案，默认停约 5 秒（进考试后：更多 → 做题设置 → 答错停留可改）。</li>
          <li>每题限时也可在做题设置里改，或选「不限时」。</li>
          <li>顶部「题板」可查看对错并跳题；「随机测试」不改动正式做题进度。</li>
        </ul>
        <h2>背题与错题</h2>
        <ul>
          <li>背题进度与做题进度分开记。</li>
          <li>底部「错题」可继续练、导出。</li>
        </ul>
        <h2>进度与同步</h2>
        <ul>
          <li>进度存在本机；建议定期在考试内「更多」里备份导出。</li>
          <li>同步码只给自己的多台设备用，不要发到工作群、不要和别人共用。</li>
        </ul>
        <p class="guide-foot">有问题请联系：<code>qzh_0813</code></p>
      </article>`;
  }

  /** 首页「更多 → 更新记录」 */
  function renderChangelog() {
    app().innerHTML = `
      ${subHead("更新记录", "exams")}
      <article class="guide">
        <ul class="changelog-list">
          <li><b>v29</b>：首页新增背题热力图，背得越多颜色越深</li>
          <li><b>v28</b>：使用说明与更新记录改到首页选考试的「更多」里</li>
          <li><b>v27</b>：「更多」曾改为只显示更新记录</li>
          <li><b>v26</b>：曾加入使用说明</li>
          <li><b>v25</b>：答错停留可调；新版本弹更新说明；联系 qzh_0813</li>
        </ul>
      </article>`;
  }

  /** 「更多」: everything that is not the daily path. Static page, no DB reads. */
  function renderMore() {
    app().innerHTML = `
      <div class="menu">
        <button type="button" class="row" data-go="practice"><span>做题设置</span><i>›</i></button>
        <button type="button" class="row" data-go="study"><span>背题设置</span><i>›</i></button>
        <button type="button" class="row" data-go="bank"><span>题库管理</span><i>›</i></button>
        <button type="button" class="row" data-go="import"><span>导入题目</span><i>›</i></button>
        <details class="fold" id="sync-fold" ${foldOpen ? "open" : ""}>
          <summary>云同步与备份</summary>
          <div class="fold-body">${syncCardHtml({ bare: true })}</div>
        </details>
        <button type="button" class="row" id="switch-deck"><span>切换考试</span><i>›</i></button>
      </div>`;
    $("#switch-deck").onclick = () => leaveDeck();
    foldOpen = false;
    bindSyncCardHandlers(() => {
      foldOpen = true;
      renderMore();
    });
  }

  // ---------- 随机测试 (random test: N distinct questions, one timed round, never moves 做题进度) ----------
  let randFoldOpen = false; // home 「随机测试」 opens 做题设置 with this fold expanded
  function randUnfinished() {
    const s = readRounds().random;
    if (!s || Number(s.deck) !== Number(currentDeckId) || !(Date.now() - (Number(s.t) || 0) < ROUND_TTL_MS)) return null;
    const ids = Array.isArray(s.ids) ? s.ids : [];
    const ans = Array.isArray(s.ans) ? s.ans : [];
    const done = ids.filter((_, i) => ans[i]).length;
    return done < ids.length ? { done, n: ids.length } : null;
  }
  function randEntryLabel() {
    const u = randUnfinished();
    return u ? `<span>继续随机测试</span><b>${u.done} / ${u.n}</b><i>›</i>` : `<span>随机测试</span><b>${getRand().n} 题</b><i>›</i>`;
  }
  function randScope(r) {
    const c = readCursor("practice", currentDeckId);
    return r.pool === "range"
      ? { from: c.from, to: c.to, qtypes: c.qtypes.slice(), status: r.status }
      : { from: 0, to: 0, qtypes: [], status: r.status };
  }
  async function randPool(r) {
    const sorted = await getSortedQuestions(currentDeckId);
    const ctx = await loadScopeContext();
    return { sorted, ctx, idx: scopeIndices(sorted, ctx, randScope(r)) };
  }
  /** unbiased partial Fisher–Yates: k distinct items */
  function sampleDistinct(arr, k) {
    const a = arr.slice();
    const m = Math.min(k, a.length);
    for (let i = 0; i < m; i++) {
      const j = i + Math.floor(Math.random() * (a.length - i));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a.slice(0, m);
  }
  async function startRandomTest() {
    const r = getRand();
    const { sorted, ctx, idx } = await randPool(r);
    if (!idx.length) return toast(r.status === "wrong" ? "错题本是空的" : r.status === "new" ? "没有没做过的题" : "题池为空");
    const picked = sampleDistinct(idx, r.n);
    const list = enrichFromMap(picked.map((i) => sorted[i]), ctx.reviews);
    list.forEach((q, i) => {
      q._idx = picked[i];
    });
    if (picked.length < r.n) toast(`题池只有 ${picked.length} 题，已全部抽取`);
    seqMove = false; // never touches 做题进度
    startQuiz(list, "random");
  }
  function randFoldHtml() {
    const r = getRand();
    const u = randUnfinished();
    return `<details class="fold" id="rand-fold" ${randFoldOpen ? "open" : ""}><summary>随机测试 · ${r.n} 题${u ? ` · 未完成 ${u.done}/${u.n}` : ""}</summary><div class="fold-body" id="rand-card"></div></details>`;
  }
  function wireRandFold(seq) {
    const det = $("#rand-fold");
    if (!det) return;
    const mount = () => {
      if (!det.open || det.dataset.mounted) return;
      det.dataset.mounted = "1";
      mountRandCard($("#rand-card"), seq);
    };
    det.addEventListener("toggle", mount);
    mount();
  }
  async function mountRandCard(host, seq) {
    const r = getRand();
    const c = readCursor("practice", currentDeckId);
    const scoped = cursorHasScope(c);
    const u = randUnfinished();
    const chip = (attr, v, label, on) => `<button type="button" class="chip ${on ? "on" : ""}" ${attr}="${v}">${label}</button>`;
    host.innerHTML = `
      <div class="rand-n-row">
        <label for="rt-n">题数</label>
        <input id="rt-n" type="number" inputmode="numeric" min="1" max="${RAND_MAX_N}" value="${r.n}" />
        <span class="muted" id="rt-pool-n">题池 …</span>
      </div>
      <div class="chips" id="rt-quick">${RAND_QUICK.map((n) => chip("data-n", n, n, n === r.n)).join("")}</div>
      <div class="chip-label">题池</div>
      <div class="chips" id="rt-pool">${chip("data-p", "all", "全题库", r.pool === "all")}${chip("data-p", "range", scoped ? "当前范围" : "当前范围（未设）", r.pool === "range")}</div>
      <div class="chips" id="rt-status">${chip("data-s", "all", "全部", r.status === "all")}${chip("data-s", "new", "没做过的", r.status === "new")}${chip("data-s", "wrong", "错题", r.status === "wrong")}</div>
      ${u ? `<button class="btn" id="rt-resume">继续未完成的随机测试（${u.done} / ${u.n}）</button>` : ""}
      <button class="btn primary" id="rt-start">开始随机测试</button>
      <p class="muted">一次抽取不重复的题，按「每题时间」计时；不影响做题进度，答错照常进错题本。</p>`;
    const nInput = $("#rt-n", host);
    let poolSize = null;
    const paintStart = () => {
      const g = getRand();
      const k = poolSize == null ? g.n : Math.min(g.n, poolSize);
      $("#rt-start", host).textContent = `开始随机测试（${k} 题）`;
      $("#rt-start", host).disabled = poolSize === 0;
      host.querySelectorAll("#rt-quick .chip").forEach((x) => x.classList.toggle("on", Number(x.dataset.n) === g.n));
      const sum = det && det.querySelector("summary");
      if (sum) sum.firstChild.textContent = `随机测试 · ${g.n} 题`;
    };
    const det = $("#rand-fold");
    const refreshPool = async () => {
      const { idx } = await randPool(getRand());
      if (seq != null && seq !== navSeq) return;
      poolSize = idx.length;
      const el = $("#rt-pool-n", host);
      if (el) el.textContent = `题池 ${poolSize} 题`;
      paintStart();
    };
    nInput.addEventListener("change", () => {
      setRand({ n: clampRandN(nInput.value) });
      nInput.value = getRand().n;
      paintStart();
    });
    nInput.addEventListener("input", () => {
      const v = parseInt(nInput.value, 10);
      if (v > 0) {
        setRand({ n: v });
        paintStart();
      }
    });
    host.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b || !host.contains(b)) return;
      if (b.dataset.n) {
        setRand({ n: Number(b.dataset.n) });
        nInput.value = getRand().n;
        paintStart();
      } else if (b.dataset.p || b.dataset.s) {
        setRand(b.dataset.p ? { pool: b.dataset.p } : { status: b.dataset.s });
        const grp = b.parentElement;
        grp.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
        refreshPool();
      } else if (b.id === "rt-start") {
        setRand({ n: clampRandN(nInput.value) });
        startRandomTest();
      } else if (b.id === "rt-resume") {
        resumeRound("random");
      }
    });
    paintStart();
    refreshPool();
  }

  // ---------- Range picker (shared by 练习 and 背题 menus) ----------
  /** collapsed fold that builds the range picker only when first opened */
  function rangeFoldHtml(kind, total) {
    const c = readCursor(kind, currentDeckId);
    const tag = cursorHasScope(c) ? ` · ${escapeHtml(scopeText(c, total || 0))}` : "";
    return `<details class="fold" id="range-fold"><summary>选择题目范围${tag}</summary><div class="fold-body" id="range-card"></div></details>`;
  }
  function wireRangeFold(kind, seq) {
    const det = $("#range-fold");
    if (!det) return;
    det.addEventListener("toggle", () => {
      if (!det.open || det.dataset.mounted) return;
      det.dataset.mounted = "1";
      mountRangeCard(kind, $("#range-card"), seq);
    });
  }

  async function mountRangeCard(kind, host, seq) {
    host.innerHTML = `<p class="muted">载入中…</p>`;
    const sorted = await getSortedQuestions(currentDeckId);
    const total = sorted.length;
    const ctx = await loadScopeContext();
    if (seq != null && seq !== navSeq) return;
    const cur = readCursor(kind, currentDeckId);
    const present = QTYPE_ORDER.filter((t) => sorted.some((q) => qTypeOf(q) === t));
    const st = {
      from: cur.from > 0 ? cur.from : 1,
      to: cur.to > 0 ? Math.min(cur.to, total) : total,
      qtypes: cur.qtypes.filter((t) => present.includes(t)),
      status: cur.status,
    };
    const clamp = (v, dflt) => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return dflt;
      return Math.max(1, Math.min(total, n));
    };
    const active = cursorHasScope(cur);
    host.innerHTML = `
      <div class="range-row">
        <label>起题号<input type="number" inputmode="numeric" id="rg-from" min="1" max="${total}" value="${st.from}" /></label>
        <span class="range-dash">–</span>
        <label>止题号<input type="number" inputmode="numeric" id="rg-to" min="1" max="${total}" value="${st.to}" /></label>
      </div>
      <div class="chip-label">题型</div>
      <div class="chips" id="rg-types">
        <button type="button" class="chip" data-t="">全部</button>
        ${present.map((t) => `<button type="button" class="chip" data-t="${t}">${t}</button>`).join("")}
      </div>
      <div class="chip-label">状态</div>
      <div class="chips" id="rg-status">
        <button type="button" class="chip" data-s="all">全部</button>
        <button type="button" class="chip" data-s="new">没做过的</button>
        <button type="button" class="chip" data-s="wrong">错题</button>
      </div>
      <p class="range-count" id="rg-count">范围内共 … 题</p>
      <button class="btn primary" id="rg-start">开始</button>
      ${active ? `<button class="btn" id="rg-reset">恢复全题库（保留当前位置）</button>` : ""}
      <p class="muted">新范围从起点开始；范围不变则接着上次位置，每批 ${MORE_N} 题</p>`;
    const fromEl = $("#rg-from", host);
    const toEl = $("#rg-to", host);
    const readScope = () => {
      let f = clamp(fromEl.value, 1);
      let t = clamp(toEl.value, total);
      if (f > t) [f, t] = [t, f];
      return { f, t };
    };
    const paint = () => {
      host.querySelectorAll("#rg-types .chip").forEach((b) => {
        const t = b.dataset.t;
        b.classList.toggle("on", t === "" ? st.qtypes.length === 0 : st.qtypes.includes(t));
      });
      host.querySelectorAll("#rg-status .chip").forEach((b) => b.classList.toggle("on", b.dataset.s === st.status));
      const { f, t } = readScope();
      const n = scopeIndices(sorted, ctx, { from: f, to: t, qtypes: st.qtypes, status: st.status }).length;
      $("#rg-count", host).textContent = `范围内共 ${n} 题`;
      $("#rg-start", host).disabled = n === 0;
    };
    const normalizeInputs = () => {
      const { f, t } = readScope();
      fromEl.value = String(f);
      toEl.value = String(t);
      paint();
    };
    fromEl.addEventListener("input", () => paint());
    toEl.addEventListener("input", () => paint());
    fromEl.addEventListener("change", normalizeInputs);
    toEl.addEventListener("change", normalizeInputs);
    $("#rg-types", host).addEventListener("click", (ev) => {
      const b = ev.target.closest(".chip");
      if (!b) return;
      const t = b.dataset.t;
      if (t === "") st.qtypes = [];
      else st.qtypes = st.qtypes.includes(t) ? st.qtypes.filter((x) => x !== t) : st.qtypes.concat(t);
      paint();
    });
    $("#rg-status", host).addEventListener("click", (ev) => {
      const b = ev.target.closest(".chip");
      if (!b) return;
      st.status = b.dataset.s;
      paint();
    });
    $("#rg-start", host).addEventListener("click", () => {
      normalizeInputs();
      const { f, t } = readScope();
      const scope = { from: f <= 1 ? 0 : f, to: t >= total ? 0 : t, qtypes: st.qtypes.slice(), status: st.status };
      const n = scopeIndices(sorted, ctx, { from: f, to: t, qtypes: scope.qtypes, status: scope.status }).length;
      if (!n) return toast("范围内没有题目");
      const c = readCursor(kind, currentDeckId);
      const same =
        c.from === scope.from &&
        c.to === scope.to &&
        c.status === scope.status &&
        c.qtypes.slice().sort().join() === scope.qtypes.slice().sort().join();
      if (!same) {
        updateCursor(kind, currentDeckId, Object.assign({}, scope, { offset: f - 1, lastIds: [], lastStart: 0, lastCount: 0 }));
      }
      if (kind === "study") startStudy({ n: MORE_N });
      else startSeqPractice({ n: MORE_N });
    });
    $("#rg-reset", host)?.addEventListener("click", () => {
      updateCursor(kind, currentDeckId, { from: 0, to: 0, qtypes: [], status: "all" });
      clearSavedRound(kind);
      toast("已恢复全题库");
      navigate(kind === "study" ? "study" : "practice");
    });
    paint();
  }

  function nextFromShort(kind, total) {
    return nextFromLabel(kind, total);
  }

  function renderPracticeMenu(seq) {
    app().innerHTML = `${subHead("做题设置")}<div id="pm-body"></div>`;
    const paint = (s) => {
      const total = s ? s.total : 0;
      const due = s ? s.due : 0;
      const study = readCursor("study", currentDeckId);
      const hasStudyBatch = study.lastIds.length > 0 || study.lastCount > 0;
      const studyBatchN = study.lastIds.length || study.lastCount;
      $("#pm-body").innerHTML = `
        <div class="set-label">每题时间</div>
        ${timeSegHtml("pm-time")}
        <div class="set-label">答错停留</div>
        ${badPauseSegHtml("pm-bad-pause")}
        ${progressBlockHtml("practice", total)}
        <p class="muted">${nextFromShort("practice", total)}</p>
        <div class="btn-row3">
          <button class="btn" id="p-seq20">下一批 20</button>
          <button class="btn" id="p-seq50">下一批 50</button>
          <button class="btn" id="p-seqrest">到末尾</button>
        </div>
        <button class="btn" id="pall" ${due ? "" : "disabled"}>复习到期题（${due}）</button>
        ${randFoldHtml()}
        <button class="btn" id="p-last" ${hasStudyBatch ? "" : "disabled"}>按顺序刷刚背的${hasStudyBatch ? ` ${studyBatchN} 题` : ""}</button>
        ${rangeFoldHtml("practice", total)}
        <button class="btn quiet" id="p-reset">重置做题进度</button>`;
      $("#p-last").onclick = () => startSeqPractice({ useLast: true, sourceKind: "study" });
      wireTimeSeg($("#pm-time"));
      wireBadPauseSeg($("#pm-bad-pause"));
      $("#p-seq20").onclick = () => startSeqPractice({ n: 20 });
      $("#p-seq50").onclick = () => startSeqPractice({ n: 50 });
      $("#p-seqrest").onclick = () => startSeqPractice({ n: null });
      $("#p-reset").onclick = () => {
        if (!confirm("把做题进度重置回第 1 题？（背题进度不受影响）")) return;
        resetCursor("practice");
        toast("做题进度已重置");
        renderPracticeMenu(navSeq);
      };
      $("#pall").onclick = async () => {
        const list = await getDueQuestions();
        if (!list.length) return toast("没有可练习的题目");
        startQuiz(list, "due");
      };
      wireRandFold(seq);
      wireRangeFold("practice", seq);
    };
    return withStats(seq, (s) => paint(s));
  }

  function renderStudyMenu(seq) {
    app().innerHTML = `${subHead("背题设置")}<div id="sm-body"></div>`;
    const paint = (s) => {
      const total = s ? s.total : 0;
      const c = readCursor("study", currentDeckId);
      const scoped = cursorHasScope(c);
      $("#sm-body").innerHTML = `
        ${progressBlockHtml("study", total)}
        <p class="muted">${nextFromShort("study", total)} · 不计时、不计错题</p>
        <div class="btn-row3">
          <button class="btn" id="s20">下一批 20</button>
          <button class="btn" id="s50">下一批 50</button>
          <button class="btn" id="sall" ${total ? "" : "disabled"}>${scoped ? "范围从头背" : "从头背完"}</button>
        </div>
        ${rangeFoldHtml("study", total)}
        <button class="btn quiet" id="s-reset">重置背题进度</button>`;
      $("#s20").onclick = () => startStudy({ n: 20 });
      $("#s50").onclick = () => startStudy({ n: 50 });
      $("#sall").onclick = () => startStudy({ n: null, fromStart: true });
      $("#s-reset").onclick = () => {
        if (!confirm("把背题进度重置回第 1 题？（做题进度不受影响）")) return;
        resetCursor("study");
        toast("背题进度已重置");
        renderStudyMenu(navSeq);
      };
      wireRangeFold("study", seq);
    };
    return withStats(seq, (s) => paint(s));
  }

  async function startStudy({ n = 20, fromStart = false, useLast = false } = {}) {
    studyCount = n == null ? null : n;
    seqSession = { kind: "study", sourceKind: "study", fromStart: !!fromStart, useLast: !!useLast, n: studyCount };
    const batch = await getSequentialQuestions({ n: studyCount, fromStart, useLast, kind: "study" });
    queue = batch.questions;
    seqBatch = { start: batch.start, count: batch.count, total: batch.total };
    if (!queue.length) return toast(batch.total ? "范围内没有符合条件的题" : "题库为空");
    if (batch.wrapped) toast("这一遍背完了，从头开始");
    queueMode = "study";
    roundIsRedo = false;
    qIndex = 0;
    seqMove = !useLast;
    resetRound();
    saveRound();
    navigate("study-quiz");
  }

  async function startSeqPractice({ n = 20, fromStart = false, useLast = false, sourceKind = null } = {}) {
    studyCount = n == null ? null : n;
    const src = sourceKind || "practice";
    seqSession = { kind: "practice", sourceKind: src, fromStart: !!fromStart, useLast: !!useLast, n: studyCount };
    const batch = await getSequentialQuestions({ n: studyCount, fromStart, useLast, kind: "practice", sourceKind: src });
    if (!batch.questions.length) return toast(useLast ? "暂无上一批" : "范围内没有符合条件的题");
    if (batch.wrapped) toast("这一遍做完了，从头开始");
    seqBatch = { start: batch.start, count: batch.count, total: batch.total };
    seqMove = !useLast; // replaying a batch (e.g. 刚背的) never moves the 做题进度
    startQuiz(batch.questions, "seq");
  }

  function highlightStudyAnswers(q) {
    const ans = normalizeAnswer(q.answer);
    document.querySelectorAll(".option").forEach((btn) => {
      const L = btn.dataset.letter;
      if (!L) return;
      if (ans.includes(L) || (ans.length === 1 && ans === L)) {
        btn.classList.add("correct");
      }
    });
  }

  function studyHeadProgress(q) {
    if (!seqMove) return "回顾本批 · 不改变背题进度";
    const { pos, of } = positionInScope("study", q, seqBatch.total || 0);
    return `背题进度 ${pos} / ${of}`;
  }

  function renderStudy() {
    clearAdvance();
    stopTimer();
    if (!queue.length || qIndex >= queue.length) {
      if (queue.length && seqMove) {
        const last = queue[queue.length - 1];
        if (last && last._idx != null) advanceCursorTo("study", last._idx + 1);
      }
      if (seqMove) clearSavedRound("study");
      const total = seqBatch.total || 0;
      app().innerHTML = `
        <div class="empty round-end">
          <h2>本批背完 ${queue.length} 题</h2>
          ${progressBlockHtml("study", total)}
          <p class="muted">未计入错题与复习 · ${seqMove ? nextFromLabel("study", total) : "本次是回顾，不改变背题进度"}</p>
          <button class="btn primary" id="study-drill">按顺序刷刚背的（不影响做题进度）</button>
          <button class="btn" id="study-next-batch">再背 ${MORE_N} 题</button>
          <button class="btn" id="study-again">再背同一批</button>
          <button class="btn" id="study-back">返回首页</button>
        </div>`;
      $("#study-drill").onclick = () => startSeqPractice({ useLast: true, sourceKind: "study" });
      $("#study-back").onclick = () => navigate("today");
      $("#study-again").onclick = () => startStudy({ useLast: true });
      $("#study-next-batch").onclick = () => startStudy({ n: MORE_N });
      return;
    }
    const q = queue[qIndex];
    answering = false;
    const opts = Array.isArray(q.options) ? q.options.filter((x) => x != null && String(x).trim() !== "") : [];
    const optHtml = opts.length
      ? `<div class="options" id="options">
          ${opts
            .map(
              (t, i) =>
                `<div class="option study-static" data-letter="${optionLetter(i)}"><span class="key">${optionLetter(i)}.</span> ${escapeHtml(String(t))}</div>`
            )
            .join("")}
        </div>`
      : `<div class="card short-q"><p class="muted">本题无选项（判断/填空）</p></div>`;
    let seen = 0;
    for (let i = 0; i < queue.length; i++) if (studySeen[i]) seen++;

    app().innerHTML = `
      <div class="quiz-head">
        <button type="button" class="quit" id="quit" aria-label="退出">✕</button>
        ${boardBtnHtml()}
        <div class="head-main"><span class="muted">背题</span><div class="muted head-sub">${studyHeadProgress(q)}</div></div>
      </div>
      ${pbarHtml(seen, queue.length)}
      <div class="q-card">
        <div class="stem">${escapeHtml(q.stem)}</div>
        ${optHtml}
        <div id="after">
          <button class="btn primary" id="study-reveal" style="margin-top:12px">显示答案</button>
        </div>
      </div>
    `;

    const idx = qIndex;
    const markSeen = () => {
      if (!studySeen[idx]) {
        studySeen[idx] = true;
        heatBump("study");
        saveRound();
      }
      if (seqMove && q._idx != null) advanceCursorTo("study", q._idx + 1);
    };
    $("#quit")?.addEventListener("click", exitQuiz);
    $("#board-btn")?.addEventListener("click", openBoard);

    const paintNav = () => {
      const prevDisabled = qIndex <= 0 ? "disabled" : "";
      return `
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" id="study-prev" ${prevDisabled}>上一题</button>
          <button class="btn primary" id="study-next">下一题</button>
        </div>`;
    };

    const wireNav = () => {
      $("#study-prev")?.addEventListener("click", () => {
        if (qIndex <= 0) return;
        qIndex -= 1;
        saveRound();
        renderStudy();
      });
      $("#study-next")?.addEventListener("click", () => {
        markSeen();
        qIndex += 1;
        saveRound();
        renderStudy();
      });
    };

    const reveal = () => {
      markSeen();
      highlightStudyAnswers(q);
      const after = $("#after");
      after.innerHTML = `
        <div class="feedback">
          <div>正确答案：${escapeHtml(String(q.answer))}</div>
          ${q.explanation ? `<div class="explain">${escapeHtml(String(q.explanation))}</div>` : ""}
        </div>
        ${paintNav()}`;
      wireNav();
    };
    if (studySeen[idx]) reveal(); // already seen (back / 题板): show it with the answer
    else $("#study-reveal")?.addEventListener("click", reveal);
  }

  /** leave a running quiz / study batch (answers are already saved one by one) */
  function exitQuiz() {
    navigate(queueMode === "wrong" ? "wrong" : "today");
  }

  function quizProgressHtml(q) {
    if (queueMode !== "seq" || roundIsRedo) return "";
    if (!seqMove) return `<div class="muted head-sub">回顾本批 · 不影响做题进度</div>`;
    const { pos, of } = positionInScope("practice", q, seqBatch.total || 0);
    return `<div class="muted head-sub">做题进度 ${pos} / ${of}</div>`;
  }

  function isAnswerLetter(q, L) {
    const ans = normalizeAnswer(q.answer);
    return ans.includes(L) || (ans.length === 1 && ans === L);
  }

  function renderQuizEnd() {
    const c = roundCounts();
    const n = c.ok + c.bad + c.to;
    const a = c.ok;
    const b = c.bad + c.to;
    const acc = n > 0 ? Math.round((a / n) * 100) : 0;
    const needRedo = n > 0 && b > 0 && (a / n) * 100 < ACC_PASS;
    const roundQueue = queue.slice();
    const roundWrongIds = [];
    queue.forEach((q, i) => {
      const r = roundAns[i];
      if (r && r.r !== "ok" && !roundWrongIds.includes(Number(q.id))) roundWrongIds.push(Number(q.id));
    });
    if (roundPersistable()) clearSavedRound(roundKindNow());
    const moreLabel = `再做 ${queueMode === "random" ? getRand().n : MORE_N} 题`;
    const seqHint =
      queueMode === "seq" && !roundIsRedo
        ? seqMove
          ? progressBlockHtml("practice", seqBatch.total || 0) + `<p class="muted">${nextFromLabel("practice", seqBatch.total || 0)}</p>`
          : `<p class="muted">${seqSession.sourceKind === "study" ? "这是回顾刚背的一批，不影响做题进度" : "这是回顾上一批，不影响做题进度"}</p>`
        : "";
    app().innerHTML = `
      <div class="empty round-end">
        <h2>${roundIsRedo ? "重做完成" : "本轮完成"} 共 ${queue.length} 题</h2>
        <div class="acc ${needRedo ? "low" : ""}">正确率 ${acc}%<span>（对 ${a} / 共 ${n}）</span></div>
        <p class="acc-sub">错 ${b} 题${c.to ? `（含超时 ${c.to}）` : ""}</p>
        ${needRedo ? `<div class="notice">正确率不足 ${ACC_PASS}%，建议重做本轮错题</div>
        <button class="btn primary" id="redo-wrong">重做本轮错题（${b} 题）</button>` : ""}
        ${seqHint}
        <button class="btn ${needRedo ? "" : "primary"}" id="more-50">${moreLabel}</button>
        ${!needRedo && b > 0 ? `<button class="btn" id="redo-wrong">重做本轮错题（${b} 题）</button>` : ""}
        ${queueMode === "seq" && !roundIsRedo ? `<button class="btn" id="seq-again">再刷同一批</button>` : ""}
        <button class="btn" id="back-today">返回首页</button>
        <p class="disclaimer">题目仅供练习参考，答案以现行规章和作业指导书为准</p>
      </div>`;
    $("#back-today").onclick = () => navigate("today");
    $("#more-50").onclick = () => startMore();
    $("#redo-wrong")?.addEventListener("click", () => startRedoWrong(roundQueue, roundWrongIds));
    $("#seq-again")?.addEventListener("click", () =>
      startSeqPractice({ useLast: true, sourceKind: seqSession.sourceKind || "practice" })
    );
  }

  function renderQuiz() {
    clearAdvance();
    stopTimer();
    if (!queue.length || qIndex >= queue.length) return renderQuizEnd();
    const q = queue[qIndex];
    const idx = qIndex;
    const done = roundAns[idx] || null; // answered already → read-only review, no timer, no re-answer
    answering = !!done;
    const opts = Array.isArray(q.options) ? q.options.filter((x) => x != null && String(x).trim() !== "") : [];
    const optCls = (L) => {
      if (!done) return "option";
      let c = "option";
      if (isAnswerLetter(q, L)) c += " correct";
      else if (done.p === L) c += " wrong";
      return c;
    };
    const optHtml = opts.length
      ? `<div class="options" id="options">
          ${opts
            .map(
              (t, i) =>
                `<button type="button" class="${optCls(optionLetter(i))}" data-letter="${optionLetter(i)}"${done ? " disabled" : ""}><span class="key">${optionLetter(i)}.</span> ${escapeHtml(String(t))}</button>`
            )
            .join("")}
        </div>`
      : done
        ? ""
        : `<div class="card short-q">
            <p class="muted">本题无选项</p>
            <button class="btn" id="reveal">查看答案</button>
          </div>`;
    const c = roundCounts();
    const answered = queue.length - c.un;
    const timerTxt = done ? (done.r === "ok" ? "✓" : done.r === "to" ? "超时" : "错") : getTimeLimit() > 0 ? String(getTimeLimit()) : "∞";

    let reviewHtml = "";
    if (done) {
      const nx = nextUnanswered(idx);
      reviewHtml = `
        <div class="feedback ${done.r === "ok" ? "ok" : "bad"}">
          <strong>${done.r === "ok" ? "正确" : done.r === "to" ? "超时" : "错误"}</strong>${done.p ? `<span class="muted-inv"> · 你选了 ${escapeHtml(done.p)}</span>` : ""}
          <div>正确答案：${escapeHtml(String(q.answer))}</div>
          ${q.explanation ? `<div class="explain">${escapeHtml(String(q.explanation))}</div>` : ""}
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" id="q-prev" ${idx <= 0 ? "disabled" : ""}>上一题</button>
          <button class="btn primary" id="q-next">${nx < 0 ? "完成本轮" : "下一题"}</button>
        </div>`;
    }

    app().innerHTML = `
      <div class="quiz-head">
        <button type="button" class="quit" id="quit" aria-label="退出">✕</button>
        ${boardBtnHtml()}
        <div class="head-main"><span class="muted">${roundIsRedo ? "重做错题" : queueMode === "wrong" ? "错题" : queueMode === "due" ? "今日" : queueMode === "seq" ? "顺序练习" : queueMode === "random" ? "随机测试" : "练习"}</span>${quizProgressHtml(q)}</div>
        <div id="timer" class="${done && done.r !== "ok" ? "warn" : ""}">${timerTxt}</div>
      </div>
      ${pbarHtml(answered, queue.length)}
      <div class="q-card">
        <div class="stem">${escapeHtml(q.stem)}</div>
        ${optHtml}
        <div id="after">${reviewHtml}</div>
      </div>
    `;

    $("#quit")?.addEventListener("click", exitQuiz);
    $("#board-btn")?.addEventListener("click", openBoard);
    if (done) {
      $("#q-prev")?.addEventListener("click", () => {
        if (qIndex <= 0) return;
        qIndex -= 1;
        saveRound();
        renderQuiz();
      });
      $("#q-next")?.addEventListener("click", () => goNextUnanswered(idx));
      return;
    }
    startTimer(() => {
      if (answering) return;
      handleAnswer(q, null, true);
    });
    $("#options")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".option");
      if (!btn || answering) return;
      handleAnswer(q, btn.dataset.letter, false);
    });
    $("#reveal")?.addEventListener("click", () => {
      if (answering) return;
      stopTimer();
      answering = true;
      const after = $("#after");
      after.innerHTML = `
        <div class="feedback">
          <div>正确答案：${escapeHtml(String(q.answer))}</div>
          ${q.explanation ? `<div class="explain">${escapeHtml(String(q.explanation))}</div>` : ""}
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn primary" id="mark-ok">答对了</button>
          <button class="btn" id="mark-bad">答错了</button>
        </div>`;
      $("#mark-ok").onclick = () => {
        recordAnswer(idx, q, true, false, null);
        goNextUnanswered(idx);
      };
      $("#mark-bad").onclick = () => {
        recordAnswer(idx, q, false, false, null);
        goNextUnanswered(idx);
      };
    });
  }

  /** after an answer (or 「下一题」 on a reviewed one): the next unanswered question, wrapping; none left → round end */
  function goNextUnanswered(from) {
    if (route !== "quiz") return;
    const nx = nextUnanswered(from);
    qIndex = nx < 0 ? queue.length : nx;
    saveRound();
    renderQuiz();
  }

  /** Persist one answer right away (review state, wrong book, 做题进度) — even if the user leaves during the feedback pause.
   *  Keyed by round index: a question can only be counted once per round, however the user jumps around. */
  async function recordAnswer(idx, q, correct, timedOut, pick) {
    if (roundAns[idx]) return;
    roundAns[idx] = { r: correct ? "ok" : timedOut ? "to" : "bad", p: pick || null };
    saveRound();
    if (correct) {
      await applyRating(q.id, "good", true);
      await removeWrong(q.id);
    } else {
      await addWrong(q.id, timedOut ? "timeout" : "wrong");
      await applyRating(q.id, "again", false);
    }
    if (queueMode === "seq" && seqMove && !roundIsRedo && q._idx != null) {
      advanceCursorTo("practice", q._idx + 1); // monotonic: jumping back never lowers 做题进度
    }
  }

  async function handleAnswer(q, letter, timedOut) {
    const idx = qIndex;
    if (answering || roundAns[idx] || queue[idx] !== q) return;
    answering = true;
    stopTimer();
    clearAdvance();
    let correct = false;
    if (!timedOut && letter) correct = isChoiceCorrect(q, letter);

    document.querySelectorAll("#options .option").forEach((btn) => {
      btn.disabled = true;
      const L = btn.dataset.letter;
      if (letter && L === letter && !correct) btn.classList.add("wrong");
      if (isAnswerLetter(q, L)) btn.classList.add("correct");
    });

    const after = $("#after");
    const timerEl = $("#timer");
    const verdict = timedOut ? "超时" : correct ? "正确" : "错误";
    recordAnswer(idx, q, correct, timedOut, letter); // saved immediately; the timers below only advance to the next question
    const pb = $(".pbar > i");
    if (pb) pb.style.width = ((100 * (queue.length - roundCounts().un)) / queue.length).toFixed(2) + "%";
    // auto-advance waits while the 题板 is open and runs once it is closed (unless the user jumped)
    const advance = () => {
      advanceTimerId = null;
      if (boardOpen) {
        pendingAdvance = () => goNextUnanswered(idx);
        return;
      }
      goNextUnanswered(idx);
    };

    if (correct) {
      if (timerEl) {
        timerEl.textContent = "✓";
        timerEl.classList.remove("warn");
      }
      after.innerHTML = `
        <div class="feedback ok">
          <strong>${verdict}</strong>
          <div class="muted" id="next-cd">即将下一题</div>
        </div>`;
      advanceTimerId = setTimeout(advance, FLASH_MS_OK);
      return;
    }

    // 答错/超时：按「答错停留」倒计时；0 = 短暂闪一下正确答案后立刻下一题
    const pauseSec = getBadPause();
    const badBody = `
      <div class="feedback bad">
        <strong>${verdict}</strong>
        <div>正确答案：${escapeHtml(String(q.answer))}</div>
        ${q.explanation ? `<div class="explain">${escapeHtml(String(q.explanation))}</div>` : ""}
        <div class="next-hint" id="next-cd"></div>
      </div>`;
    after.innerHTML = badBody;
    if (pauseSec <= 0) {
      if (timerEl) {
        timerEl.textContent = "×";
        timerEl.classList.add("warn");
      }
      const cd = $("#next-cd");
      if (cd) cd.textContent = "即将下一题";
      advanceTimerId = setTimeout(advance, FLASH_MS_OK);
      return;
    }
    let left = pauseSec;
    const paint = () => {
      if (timerEl) {
        timerEl.textContent = String(left);
        timerEl.classList.add("warn");
      }
      const cd = $("#next-cd");
      if (cd) cd.textContent = left + " 秒后下一题";
    };
    paint();
    advanceTimerId = setInterval(() => {
      if (boardOpen) return; // countdown pauses while the 题板 is open
      left -= 1;
      if (left <= 0) {
        clearAdvance();
        goNextUnanswered(idx);
        return;
      }
      paint();
    }, 1000);
  }

  // ---------- Export helpers ----------
  function exportStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  function reasonLabel(reason) {
    if (reason === "timeout") return "超时";
    if (reason === "wrong") return "答错";
    return reason || "";
  }
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function wrongRowsForExcel(list) {
    return list.map((q) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      return {
        题干: q.stem || "",
        选项A: opts[0] || "",
        选项B: opts[1] || "",
        选项C: opts[2] || "",
        选项D: opts[3] || "",
        选项E: opts[4] || "",
        选项F: opts[5] || "",
        正确答案: q.answer || "",
        "你的错因": reasonLabel(q.reason),
        错误次数: q.wrong_count || 1,
        最近错误时间: q.last_wrong_at || "",
        标签: q.tags || "",
        难度: q.difficulty == null ? "" : q.difficulty,
        解析: q.explanation || "",
      };
    });
  }
  /** SheetJS is only needed for Excel import/export: load it on demand from our own origin (never blocks startup). */
  let xlsxLoading = null;
  function loadXLSX() {
    if (typeof XLSX !== "undefined") return Promise.resolve(true);
    if (xlsxLoading) return xlsxLoading;
    const tryLoad = (src) =>
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        const timer = setTimeout(() => reject(new Error("timeout " + src)), 20000);
        s.onload = () => {
          clearTimeout(timer);
          typeof XLSX !== "undefined" ? resolve(true) : reject(new Error("no XLSX"));
        };
        s.onerror = () => {
          clearTimeout(timer);
          reject(new Error("load failed " + src));
        };
        document.head.appendChild(s);
      });
    xlsxLoading = tryLoad("vendor/xlsx.full.min.js")
      .catch(() => tryLoad("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"))
      .catch((e) => {
        xlsxLoading = null;
        console.warn("[xlsx]", e);
        return false;
      });
    return xlsxLoading;
  }
  function exportWrongExcel(list) {
    if (!list.length) return toast("暂无错题");
    if (typeof XLSX === "undefined") {
      toast("正在加载 Excel 组件…");
      loadXLSX().then((ok) => (ok ? exportWrongExcel(list) : toast("Excel 组件加载失败，请稍后再试")));
      return;
    }
    const ws = XLSX.utils.json_to_sheet(wrongRowsForExcel(list));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "错题本");
    XLSX.writeFile(wb, `错题本-${exportStamp()}.xlsx`);
    toast(`已导出 ${list.length} 题 Excel`);
  }
  function exportWrongText(list) {
    if (!list.length) return toast("暂无错题");
    const blocks = list.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const optLines = opts.map((t, idx) => `  ${"ABCDEF"[idx]}. ${t}`).join("\n");
      return [
        `【${i + 1}】`,
        `题干：${q.stem || ""}`,
        optLines ? `选项：\n${optLines}` : "选项：（无）",
        `正确答案：${q.answer || ""}`,
        `错因：${reasonLabel(q.reason)}`,
        `错误次数：${q.wrong_count || 1}`,
        `最近错误：${q.last_wrong_at || ""}`,
        q.tags ? `标签：${q.tags}` : null,
        q.difficulty != null && q.difficulty !== "" ? `难度：${q.difficulty}` : null,
        q.explanation ? `解析：${q.explanation}` : null,
      ]
        .filter((x) => x != null && x !== "")
        .join("\n");
    });
    const text = `错题本导出\n共 ${list.length} 题\n导出时间：${nowIso()}\n\n` + blocks.join("\n\n----------\n\n") + "\n";
    downloadBlob(`错题本-${exportStamp()}.txt`, new Blob([text], { type: "text/plain;charset=utf-8" }));
    toast(`已导出 ${list.length} 题文本`);
  }

  const AI_ANALYSIS_PREFIX = "请根据以下错题，逐题简要解析考点、为什么对、常见误区，用中文，尽量精炼。";
  function buildWrongAnalysisMarkdown(list) {
    const blocks = list.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const optLines = opts.length ? opts.map((t, idx) => `- ${"ABCDEF"[idx]}. ${t}`).join("\n") : "- （无选项）";
      const lines = [
        `### ${i + 1}. 错题`,
        "",
        "**题干**",
        q.stem || "",
        "",
        "**选项**",
        optLines,
        "",
        `**正确答案**：${q.answer || ""}`,
        `**错因**：${reasonLabel(q.reason)}`,
        `**错误次数**：${q.wrong_count || 1}`,
      ];
      if (q.last_wrong_at) lines.push(`**最近错误**：${q.last_wrong_at}`);
      if (q.tags) lines.push(`**标签**：${q.tags}`);
      if (q.difficulty != null && q.difficulty !== "") lines.push(`**难度**：${q.difficulty}`);
      if (q.explanation) lines.push("", "**原解析**", q.explanation);
      return lines.join("\n");
    });
    return AI_ANALYSIS_PREFIX + "\n\n" + `> 共 ${list.length} 题 · 导出时间 ${nowIso()}\n\n` + blocks.join("\n\n---\n\n") + "\n";
  }
  async function copyWrongAnalysis(list) {
    if (!list.length) return toast("暂无错题");
    const text = buildWrongAnalysisMarkdown(list);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast("已复制分析文本，可粘贴给 AI");
    } catch (e) {
      toast("复制失败：" + (e.message || e));
    }
  }
  function exportWrongAnalysisMd(list) {
    if (!list.length) return toast("暂无错题");
    downloadBlob(`错题分析-${exportStamp()}.md`, new Blob([buildWrongAnalysisMarkdown(list)], { type: "text/markdown;charset=utf-8" }));
    toast(`已导出分析稿 ${list.length} 题`);
  }
  async function shareWrongAnalysis(list) {
    if (!list.length) return toast("暂无错题");
    if (!navigator.share) return toast("当前环境不支持系统分享");
    const text = buildWrongAnalysisMarkdown(list);
    const name = `错题分析-${exportStamp()}.md`;
    const file = new File([text], name, { type: "text/markdown" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: "错题分析", text: AI_ANALYSIS_PREFIX, files: [file] });
      } else {
        await navigator.share({ title: "错题分析", text });
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
      toast("分享取消或失败");
    }
  }

  let wrongShown = 50;
  async function renderWrong(seq) {
    wrongShown = 50;
    app().innerHTML = `<h1>错题本 <span class="muted" id="wrong-n"></span></h1><div id="wrong-body"></div>`;
    const list = await getWrongList();
    if (seq !== navSeq) return;
    const dis = list.length ? "" : "disabled";
    const canShare = typeof navigator.share === "function";
    $("#wrong-n").textContent = `${list.length} 题`;
    $("#wrong-body").innerHTML = `
      <button class="btn primary" id="wrong-practice" ${dis}>练习错题</button>
      <details class="fold">
        <summary>导出 / 清空</summary>
        <div class="fold-body">
          <div class="btn-row">
            <button class="btn" id="wrong-xlsx" ${dis}>导出 Excel</button>
            <button class="btn" id="wrong-txt" ${dis}>导出文本</button>
            <button class="btn" id="wrong-copy" ${dis}>复制分析文本</button>
            <button class="btn" id="wrong-md" ${dis}>导出分析稿</button>
          </div>
          ${canShare ? `<button class="btn" id="wrong-share" ${dis}>分享</button>` : ""}
          <button class="btn quiet" id="wrong-clear" ${dis}>清空错题本</button>
        </div>
      </details>
      <div id="wrong-list"></div>
      <div id="wrong-more"></div>
      ${list.length ? "" : `<div class="empty">暂无错题</div>`}
    `;
    const box = $("#wrong-list");
    const paintList = () => {
      box.innerHTML = list
        .slice(0, wrongShown)
        .map(
          (q) => `
      <div class="list-item" data-id="${q.id}">
        <div class="title">${escapeHtml(q.stem)}</div>
        <div class="list-meta">错 ${q.wrong_count || 1} 次 · ${escapeHtml(reasonLabel(q.reason))} · 答案 ${escapeHtml(String(q.answer))}</div>
        <div class="list-actions">
          <button class="btn" data-act="practice">练习</button>
          <button class="btn" data-act="remove">移除</button>
        </div>
      </div>`
        )
        .join("");
      $("#wrong-more").innerHTML = list.length > wrongShown ? `<button class="btn" id="wrong-more-btn">显示更多（${wrongShown} / ${list.length}）</button>` : "";
      $("#wrong-more-btn")?.addEventListener("click", () => {
        wrongShown += 50;
        paintList();
      });
    };
    paintList();
    $("#wrong-practice").onclick = () => {
      startQuiz(list.slice(), "wrong");
    };
    $("#wrong-clear").onclick = async () => {
      if (!confirm("确认清空当前考试错题本？")) return;
      for (const q of list) await removeWrong(q.id);
      toast("已清空");
      navigate("wrong");
    };
    $("#wrong-xlsx").onclick = () => exportWrongExcel(list);
    $("#wrong-txt").onclick = () => exportWrongText(list);
    $("#wrong-copy").onclick = () => copyWrongAnalysis(list);
    $("#wrong-md").onclick = () => exportWrongAnalysisMd(list);
    $("#wrong-share")?.addEventListener("click", () => shareWrongAnalysis(list));
    box.onclick = async (ev) => {
      const item = ev.target.closest(".list-item");
      if (!item) return;
      const id = Number(item.dataset.id);
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (act === "remove") {
        await removeWrong(id);
        toast("已移除");
        navigate("wrong");
      } else if (act === "practice") {
        const q = list.find((x) => x.id === id);
        if (!q) return;
        startQuiz([q], "wrong");
      }
    };
  }

  /** 题库管理: manage buttons folded away; search/list update in place (typing no longer rebuilds the page). */
  async function renderBank(reset = false, seq = navSeq) {
    app().innerHTML = `
      ${subHead("题库管理")}
      <input class="search" id="bank-search" placeholder="搜索题目 / 答案 / 标签" value="${escapeAttr(reset ? "" : bankQuery)}" />
      <p class="muted" id="bank-count">载入中…</p>
      <div id="bank-list"></div>
      <div id="bank-more-host"></div>
      <details class="fold">
        <summary>整理题库</summary>
        <div class="fold-body">
          <div class="btn-row">
            <button class="btn" id="dedupe-btn">清除重复题</button>
            <button class="btn" id="split-btn">按来源拆成考试</button>
            <button class="btn" id="move-btn">整库移到其他考试</button>
            <button class="btn" id="clear-btn">清空本题库</button>
          </div>
        </div>
      </details>`;
    if (reset) {
      bankOffset = 0;
      bankQuery = "";
      bankCache = await getSortedQuestions(currentDeckId);
      if (seq !== navSeq) return;
    }
    const paintList = () => {
      const q = bankQuery.trim().toLowerCase();
      const filtered = q
        ? bankCache.filter(
            (x) =>
              String(x.stem).toLowerCase().includes(q) ||
              String(x.answer).toLowerCase().includes(q) ||
              String(x.tags || "").toLowerCase().includes(q)
          )
        : bankCache;
      const slice = filtered.slice(0, bankOffset + BANK_PAGE);
      const hasMore = slice.length < filtered.length;
      $("#bank-count").textContent = `显示 ${slice.length} / ${filtered.length}（本考试 ${bankCache.length}）`;
      $("#bank-list").innerHTML = slice
        .map(
          (item) => `
      <div class="list-item">
        <div class="title">${escapeHtml(item.stem)}</div>
        <div class="list-meta">#${item.id} · 答案 ${escapeHtml(String(item.answer))} · ${escapeHtml(item.raw_qtype || item.qtype || "")}</div>
      </div>`
        )
        .join("");
      $("#bank-more-host").innerHTML = hasMore ? `<button class="btn" id="bank-more">加载更多</button>` : "";
      $("#bank-more")?.addEventListener("click", () => {
        bankOffset += BANK_PAGE;
        paintList();
      });
    };
    paintList();
    $("#dedupe-btn").onclick = async () => {
      if (!confirm("清除当前考试中题干+答案相同的重复题（保留最早一条）？")) return;
      const n = await dedupeDeck(currentDeckId);
      toast(n ? `已清除 ${n} 道重复题` : "没有重复题");
      renderBank(true, navSeq);
    };
    $("#split-btn").onclick = async () => {
      if (!confirm("按本考试题目的来源文件名拆成多个考试？")) return;
      const r = await splitBySourceFile(currentDeckId);
      if (!r.ok) {
        toast(r.reason);
        return;
      }
      toast(`已拆分：新建 ${r.created} · 移动 ${r.moved} 题`);
      leaveDeck();
    };
    $("#clear-btn").onclick = async () => {
      if (!confirm("清空当前考试全部题目？卡片会保留。")) return;
      const n = await clearDeckQuestions(currentDeckId);
      toast(`已清空 ${n} 题`);
      renderBank(true, navSeq);
    };
    $("#move-btn").onclick = async () => {
      const decks = (await listDecks()).filter((d) => Number(d.id) !== Number(currentDeckId));
      if (!decks.length) {
        toast("请先新建另一个考试");
        return;
      }
      const names = decks.map((d, i) => `${i + 1}. ${d.name}`).join("\n");
      const pick = prompt(`移到哪个考试？输入序号：\n${names}`, "1");
      if (pick == null) return;
      const idx = Number(pick) - 1;
      if (!decks[idx]) {
        toast("无效序号");
        return;
      }
      const qs = await getQuestionsByDeck(currentDeckId);
      if (!qs.length) return toast("本题库为空");
      if (!confirm(`将 ${qs.length} 题移到「${decks[idx].name}」？`)) return;
      await moveQuestionsToDeck(
        qs.map((q) => q.id),
        decks[idx].id
      );
      toast(`已移动 ${qs.length} 题`);
      renderBank(true, navSeq);
    };
    const search = $("#bank-search");
    let tmr = null;
    search.addEventListener("input", () => {
      clearTimeout(tmr);
      tmr = setTimeout(() => {
        bankQuery = search.value;
        bankOffset = 0;
        paintList();
      }, 150);
    });
  }

  function renderImport() {
    app().innerHTML = `
      ${subHead("导入题目")}
      <div class="card">
        <p class="muted" style="margin:0 0 10px">导入到当前考试，重复题自动跳过</p>
        <div class="file-box">
          <div>选择 xlsx 文件</div>
          <input type="file" id="xlsx" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
        </div>
        <p id="import-msg" class="muted" style="margin-top:12px"></p>
      </div>
    `;
    $("#xlsx").addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const msg = $("#import-msg");
      msg.textContent = "解析中…";
      try {
        if (!(await loadXLSX())) throw new Error("Excel 组件加载失败，请检查网络后重试");
        const buf = await file.arrayBuffer();
        const batch = "imp_" + Date.now().toString(36);
        const items = parseXlsx(buf, file.name).map((it) => ({
          ...it,
          source_file: file.name,
          import_batch: batch,
        }));
        msg.textContent = `解析到 ${items.length} 题，写入中（自动去重）…`;
        const r = await bulkPutQuestionsAndReviews(items, currentDeckId, { dedupe: true, preserveIds: false });
        await ensureReviewsForDeck(currentDeckId);
        msg.textContent = `新增 ${r.added} 题，跳过重复 ${r.skipped} 题`;
        toast(`导入完成：+${r.added} / 跳过 ${r.skipped}`);
        bankCache = [];
      } catch (e) {
        msg.textContent = "导入失败：" + (e.message || e);
      }
    });
  }

  // ---------- Excel parse ----------
  function parseXlsx(buf, sourceFile) {
    const wb = XLSX.read(buf, { type: "array" });
    let sheetName = wb.SheetNames.includes("总表")
      ? "总表"
      : wb.SheetNames.reduce((best, name) => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
          const n = rows.filter((r) => r.some((c) => String(c).trim())).length;
          return !best || n > best.n ? { name, n } : best;
        }, null)?.name || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" }).map((r) =>
      r.map((c) => String(c == null ? "" : c).trim())
    );
    if (!rows.length) throw new Error("Excel 为空");
    const headerIdxMap = findExcelHeader(rows.slice(0, 5));
    if (headerIdxMap.map) return parseWithHeader(rows.slice(headerIdxMap.idx + 1), headerIdxMap.map, sourceFile);
    const out = [];
    for (const r of rows) {
      if (!r[0] || !r[1]) continue;
      if (/题干|题目|question/i.test(r[0])) continue;
      const options = r.slice(2, 8).filter((x) => x);
      out.push({
        stem: r[0],
        answer: r[1],
        options: options.length ? options : null,
        explanation: "",
        source_file: sourceFile,
        qtype: options.length ? "choice" : "short",
        tags: "",
        difficulty: null,
        raw_qtype: "",
      });
    }
    return out;
  }

  function normalizeImportedAnswer(answer, options) {
    let a = String(answer || "").trim();
    if (!a) return "";
    if (/\.0$/.test(a) && !isNaN(Number(a))) a = String(parseInt(a, 10));
    // numeric indices 1-based, possibly multi "1234" -> "ABCD"
    if (/^[1-6]+$/.test(a) && options && options.length) {
      const letters = [];
      for (const ch of a) {
        const idx = Number(ch) - 1;
        if (idx < 0 || idx >= options.length) return String(answer).trim();
        letters.push("ABCDEF"[idx]);
      }
      return letters.join("");
    }
    return a.replace(/\s+/g, "").toUpperCase();
  }

  function findExcelHeader(candidateRows) {
    for (let idx = 0; idx < candidateRows.length; idx++) {
      const map = detectHeader(candidateRows[idx]);
      if (map) return { idx, map };
    }
    return { idx: -1, map: null };
  }
  function detectHeader(row) {
    const mapping = {};
    const reStem = /题干|题目|question|stem/i;
    const reAns = /正确答案|答案|answer/i;
    const reExp = /解析|explanation|详解/i;
    const reOpt = /^(?:选项)?([A-Fa-f])$|^选项([A-Fa-f])$/i;
    const reOptCN = /^选项([一二三四五六123456])$/;
    const reTag = /标签|tags?/i;
    const reDiff = /难度/;
    const reQtype = /题型/;
    for (let i = 0; i < row.length; i++) {
      const cell = (row[i] || "").replace(/\s+/g, "");
      if (!cell) continue;
      const m = cell.match(reOpt);
      if (m) {
        mapping["opt_" + (m[1] || m[2]).toUpperCase()] = i;
        continue;
      }
      const mcn = cell.match(reOptCN);
      if (mcn) {
        const mapCN = { 一: "A", 二: "B", 三: "C", 四: "D", 五: "E", 六: "F", "1": "A", "2": "B", "3": "C", "4": "D", "5": "E", "6": "F" };
        const L = mapCN[mcn[1]];
        if (L) mapping["opt_" + L] = i;
        continue;
      }
      if (cell === "解释" && mapping.explanation == null) {
        mapping.explanation = i;
        continue;
      }
      if ((cell === "题目类型" || cell === "题型") && mapping.raw_qtype == null) {
        mapping.raw_qtype = i;
        continue;
      }
      if ("ABCDEF".includes(cell.toUpperCase()) && cell.length === 1) {
        mapping["opt_" + cell.toUpperCase()] = i;
        continue;
      }
      if (reStem.test(cell) && mapping.stem == null) {
        if (cell.includes("信息") && !cell.includes("题目（") && cell !== "题目") continue;
        if (cell.includes("类型") || cell.includes("题型")) continue;
        mapping.stem = i;
        continue;
      }
      if (reAns.test(cell) && mapping.answer == null) {
        mapping.answer = i;
        continue;
      }
      if (reExp.test(cell) && mapping.explanation == null) {
        mapping.explanation = i;
        continue;
      }
      if (reTag.test(cell) && mapping.tags == null) {
        mapping.tags = i;
        continue;
      }
      if (reDiff.test(cell) && mapping.difficulty == null) {
        mapping.difficulty = i;
        continue;
      }
      if (reQtype.test(cell) && mapping.raw_qtype == null) {
        mapping.raw_qtype = i;
        continue;
      }
    }
    if (mapping.stem != null && (mapping.answer != null || mapping.opt_A != null)) return mapping;
    return null;
  }
  function parseWithHeader(dataRows, map, sourceFile) {
    const out = [];
    for (const r of dataRows) {
      const stem = (r[map.stem] || "").trim();
      if (!stem) continue;
      const options = [];
      for (const L of KEYS) {
        const key = "opt_" + L;
        if (map[key] != null) {
          const v = (r[map[key]] || "").trim();
          if (v) options.push(v);
        }
      }
      let answer = map.answer != null ? (r[map.answer] || "").trim() : "";
      answer = normalizeImportedAnswer(answer, options);
      if (!answer && !options.length) continue;
      out.push({
        stem,
        answer: answer || (options[0] || ""),
        options: options.length ? options : null,
        explanation: map.explanation != null ? (r[map.explanation] || "").trim() : "",
        source_file: sourceFile,
        qtype: options.length ? "choice" : "short",
        tags: map.tags != null ? (r[map.tags] || "").trim() : "",
        difficulty: map.difficulty != null && r[map.difficulty] !== "" ? Number(r[map.difficulty]) || null : null,
        raw_qtype: map.raw_qtype != null ? (r[map.raw_qtype] || "").trim() : "",
      });
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function updateOnlineBadge() {
    const el = $("#online-badge");
    if (!el) return;
    // only shown when offline: the online state is the default and needs no chrome
    el.hidden = navigator.onLine;
    el.textContent = "离线";
    el.classList.add("offline");
  }
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      console.log("[sw] registered", reg.scope);
    } catch (e) {
      console.warn("[sw] register failed", e);
    }
  }

  /** last line of defence: show the plain recovery screen (index.html) instead of leaving a blank page */
  function showFatal(e) {
    const msg = (e && (e.message || e.name)) || String(e || "未知错误");
    console.error("[fatal]", e);
    if (window.__pairRecovery) {
      window.__pairRecovery(msg, true);
    } else {
      const host = document.getElementById("app");
      if (host) {
        host.innerHTML = `<div class="card"><h1>启动失败</h1><p>${escapeHtml(msg)}</p>
          <p class="muted">做题记录仍保存在本机，没有被删除。</p>
          <button class="btn" onclick="location.reload()">重新加载</button></div>`;
      }
    }
  }

  /* ---------- anonymous usage ping (no personal data; device id is random) ---------- */
  const DEVICE_KEY = "pair_device_id";
  const PING_KEY = "pair_last_ping";
  function stripDeviceMeta(data) {
    try {
      if (data && data.stores && Array.isArray(data.stores.meta))
        data.stores.meta = data.stores.meta.filter((m) => m && m.key !== DEVICE_KEY);
    } catch (_) {}
    return data;
  }
  function randomId() {
    const b = new Uint8Array(16);
    (self.crypto || window.crypto).getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function getDeviceId() {
    let id = null;
    try {
      id = localStorage.getItem(DEVICE_KEY);
    } catch (_) {}
    if (!id || !/^[a-f0-9]{32}$/.test(id)) {
      try {
        const row = await metaGet(DEVICE_KEY);
        if (row && /^[a-f0-9]{32}$/.test(row.value)) id = row.value;
      } catch (_) {}
    }
    if (!id || !/^[a-f0-9]{32}$/.test(id)) id = randomId();
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch (_) {}
    try {
      const row = await metaGet(DEVICE_KEY);
      if (!row || row.value !== id) await metaSet(DEVICE_KEY, id);
    } catch (_) {}
    return id;
  }
  function platformHint() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iOS";
    if (/Android/.test(ua)) return "Android";
    return "desktop";
  }
  async function sendUsagePing(force) {
    try {
      if (!navigator.onLine) return;
      let last = 0;
      try {
        last = Number(localStorage.getItem(PING_KEY)) || 0;
      } catch (_) {}
      if (!force && Date.now() - last < 3600 * 1000) return;
      const deviceId = await getDeviceId();
      let decks = 0, answered = 0;
      try {
        decks = (await listDecks()).length;
        for (const r of await cachedAll("reviews")) if (isAnswered(r)) answered++;
      } catch (_) {}
      const standalone = !!((window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone);
      const body = JSON.stringify({ deviceId, build: BUILD, platform: platformHint(), standalone, syncBound: !!getSyncCode(), decks, answered });
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const t = setTimeout(() => ctl && ctl.abort(), 8000);
      const res = await fetch("/api/ping", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctl && ctl.signal, keepalive: true });
      clearTimeout(t);
      if (res.ok || res.status === 429) {
        try {
          localStorage.setItem(PING_KEY, String(Date.now()));
        } catch (_) {}
      }
    } catch (_) {}
  }
  function startUsagePing() {
    setTimeout(() => sendUsagePing(true), 4000);
    setInterval(() => {
      if (document.visibilityState === "visible") sendUsagePing(false);
    }, 10 * 60 * 1000);
  }

  async function boot() {
    try {
      await bootInner();
    } catch (e) {
      showFatal(e);
    }
  }

  async function bootInner() {
    updateOnlineBadge();
    getSyncBase(); // pin the sync baseline before any local change is made
    window.addEventListener("online", () => {
      updateOnlineBadge();
      if (getSyncCode()) {
        syncPullAndApply()
          .then(async (r) => {
            if (r.applied && route !== "quiz" && route !== "study-quiz") await refreshAfterSyncImport();
            if (!r.applied || r.merged) return syncPush();
          })
          .catch((e) => console.warn("[sync] online", e));
      }
    });
    // Installed PWAs are often resumed next day without a reload: pull on return, flush on leave.
    let lastVisSync = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (syncPushPending) {
          clearTimeout(syncPushTimer);
          syncPushPending = false;
          syncPush().catch((e) => console.warn("[sync] flush", e));
        }
        return;
      }
      if (!getSyncCode() || !navigator.onLine || Date.now() - lastVisSync < 30000) return;
      lastVisSync = Date.now();
      syncPullAndApply()
        .then(async (r) => {
          if (r.applied && route !== "quiz" && route !== "study-quiz") await refreshAfterSyncImport();
        })
        .catch((e) => console.warn("[sync] visible", e));
    });
    window.addEventListener("offline", updateOnlineBadge);
    const navEl = document.querySelector(".bottom-nav");
    if (navEl) {
      navEl.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-nav]");
        if (!btn) return;
        const name = btn.dataset.nav;
        // map legacy "home" data-nav to today
        navigate(name === "home" ? "today" : name);
      });
    }
    $("#hdr-back")?.addEventListener("click", () => leaveDeck());
    app().addEventListener("click", (ev) => {
      const go = ev.target.closest("[data-go]");
      if (go) navigate(go.dataset.go);
    });

    idb = await openDBRobust();
    requestPersistentStorage();
    try {
      syncMute = true;
      await initPreload();
    } finally {
      syncMute = false;
    }

    // Cloud sync must never keep the screen blank: give it a few seconds, then show the app and let it finish
    // in the background (it refreshes the view itself if it ends up applying remote data).
    const syncP = maybeSyncOnBoot();
    const syncRes = await Promise.race([syncP.then((applied) => ({ done: true, applied })), new Promise((r) => setTimeout(() => r({ done: false }), 3000))]);

    let restored = null;
    try {
      restored = localStorage.getItem(SESSION_DECK_KEY) || sessionStorage.getItem(SESSION_DECK_KEY);
    } catch (_) {}
    const restoredId = Number(restored);
    let restoredDeck = null;
    if (restored && Number.isFinite(restoredId)) {
      try {
        restoredDeck = await getDeck(restoredId);
      } catch (_) {
        restoredDeck = null;
      }
    }
    if (restoredDeck) {
      enterDeck(restoredId);
    } else {
      if (restored) clearSavedDeck(); // stale / corrupt id: forget it instead of tripping over it every launch
      setNavVisible(false);
      navigate("exams");
    }

    if (!syncRes.done) {
      syncP.then(async (applied) => {
        if (applied && route !== "quiz" && route !== "study-quiz") await refreshAfterSyncImport();
      });
    }
    // after the first paint: service worker + (idle) Excel component, neither may delay the first screen
    setTimeout(() => {
      registerSW();
      loadXLSX();
    }, 1500);
    startUsagePing();
    // bundled new exams: only after cloud sync settled (so a pulled copy is seen first), never blocking the first screen
    Promise.race([syncP.then(() => true), new Promise((r) => setTimeout(() => r(!getSyncCode()), 15000))]).then((ok) => {
      if (ok) setTimeout(() => installBundledDecks(), 300);
    });
    setTimeout(() => maybeShowChangelog(), 400);
  }

  boot();
})();
