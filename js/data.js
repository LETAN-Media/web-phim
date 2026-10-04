// Data layer: nguồn phim (Telegram feed + phim đăng thủ công + phim mặc định),
// bookmark và settings lưu trong localStorage. Không đổi API / logic lấy phim.
(function () {
  const TG_PREFIX = 'tg_';
  const LS_CUSTOM = 'customMovies';
  const LS_BOOKMARKS = 'bookmarks';
  const LS_SETTINGS = 'settings';

  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // ---- Tags: tự suy từ tên/mô tả phim. Thêm rule mới tại đây là toàn web áp dụng ----
  const TAG_RULES = [
    { match: /hormone/i, tag: 'HORMONE' },
  ];

  function tagsFor(m) {
    const hay = `${(m && m.title) || ''} ${(m && m.desc) || ''}`;
    const tags = [];
    TAG_RULES.forEach(r => { if (r.match.test(hay)) tags.push(r.tag); });
    return tags;
  }

  // ---- Điểm lượt xem: khởi đầu khác nhau theo mid (ổn định, worker
  // tính giống hệt), mỗi lượt Phát +1 toàn site qua /api/views.
  function seedViewsFor(mid) {
    const n = Number(mid);
    if (!Number.isFinite(n)) return 20;
    return 15 + ((Math.abs(Math.floor(n)) * 53) % 70);
  }

  // ---- Telegram feed -> movie objects (giữ nguyên mapping cũ) ----
  function mapFeedItem(x, i) {
    const date = x.date ? new Date(x.date * 1000) : null;
    return {
      id: TG_PREFIX + x.mid,
      title: x.title,
      desc: x.desc || '',
      year: date ? date.getFullYear() : '',
      rating: 8.0,
      views: seedViewsFor(x.mid),
      quality: 'TELE',
      genres: ['Mới cập nhật'],
      tags: tagsFor({ title: x.title, desc: x.desc }),
      poster: x.thumb,
      backdrop: x.thumb,
      videoUrl: x.stream,
      tgNew: i === 0,
      tgDate: date ? date.toLocaleDateString('vi-VN') : '',
    };
  }

  const Store = {
    tgMovies: [],
    tgState: 'loading', // loading | ok | unconfigured | error
    tgCount: 0,
    viewsReady: false,

    // Điểm thật từ server (KV). Gọi sau khi feed về + định kỳ mỗi phút.
    // Server chưa có KV (501) thì giữ điểm seed local, không báo lỗi.
    async loadViews() {
      try {
        const r = await fetch('/api/views');
        const d = await r.json();
        if (!d || d.ok !== true || !d.views) return;
        let changed = false;
        this.tgMovies.forEach(m => {
          const mid = String(m.id).startsWith(TG_PREFIX) ? String(m.id).slice(TG_PREFIX.length) : null;
          if (mid == null || !Number.isFinite(Number(d.views[mid]))) return;
          const v = Math.floor(Number(d.views[mid]));
          if (m.views !== v) { m.views = v; changed = true; }
        });
        this.viewsReady = true;
        if (changed) emit('views:changed', { bulk: true });
      } catch (e) { /* giữ điểm seed local */ }
    },

    isTg(m) { return String(m && m.id).startsWith(TG_PREFIX); },
    custom() { const v = readJson(LS_CUSTOM, []); return Array.isArray(v) ? v : []; },
    all() { return [...this.tgMovies, ...this.custom(), ...DEFAULT_MOVIES].map(m => m.tags ? m : Object.assign({}, m, { tags: tagsFor(m) })); },
    byId(id) { return this.all().find(m => String(m.id) === String(id)) || null; },

    genres() {
      const set = new Set();
      this.all().forEach(m => (m.genres || []).forEach(g => set.add(g)));
      return Array.from(set);
    },
    byGenre(genre) {
      if (!genre || genre === 'Tất cả') return this.all();
      return this.all().filter(m => (m.genres || []).includes(genre));
    },
    tags() {
      const set = new Set();
      this.all().forEach(m => (m.tags || []).forEach(t => set.add(t)));
      return Array.from(set);
    },
    byTag(tag) {
      if (!tag || tag === 'Tất cả') return this.all();
      return this.all().filter(m => (m.tags || []).includes(tag));
    },
    search(q) {
      const s = String(q || '').trim().toLowerCase();
      if (!s) return [];
      return this.all().filter(m =>
        m.title.toLowerCase().includes(s) ||
        (m.desc || '').toLowerCase().includes(s) ||
        (m.genres || []).some(g => g.toLowerCase().includes(s)) ||
        (m.tags || []).some(t => t.toLowerCase().includes(s))
      );
    },
    topRated() {
      return this.all().filter(m => m.rating != null).sort((a, b) => (b.rating || 0) - (a.rating || 0));
    },
    latest() {
      return [...this.all()].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
    },
    related(movie, limit = 12) {
      if (!movie) return [];
      const g = new Set(movie.genres || []);
      const same = this.all().filter(m => m.id !== movie.id && (m.genres || []).some(x => g.has(x)));
      const rest = this.all().filter(m => m.id !== movie.id && !same.includes(m));
      return [...same, ...rest].slice(0, limit);
    },
    featured() {
      // Hero mac dinh: HORMONE 26C (mid=27). Doi so nay de doi hero.
      // Neu video ghim khong con thi fallback: feed moi nhat -> dang thu cong -> top rated.
      const pinned = this.byId(TG_PREFIX + 27);
      if (pinned) return pinned;
      if (this.tgMovies.length) return this.tgMovies[0];
      const custom = this.custom();
      if (custom.length) return custom[0];
      return this.topRated()[0] || this.all()[0] || null;
    },

    _feedSig: null,
    async loadFeed() {
      const prevState = this.tgState;
      const prevSig = this._feedSig;
      try {
        const r = await fetch('/api/feed');
        const d = await r.json();
        if (!d.configured) {
          this.tgState = 'unconfigured';
          this.tgMovies = [];
          this.tgCount = 0;
          this._feedSig = null;
        } else {
          this._feedSig = JSON.stringify(d.items || []);
          this.tgMovies = (d.items || []).map(mapFeedItem);
          this.tgCount = d.count || this.tgMovies.length;
          this.tgState = 'ok';
        }
      } catch (e) {
        this.tgState = 'error';
      }
      // Chỉ render lại khi trạng thái hoặc nội dung feed thực sự đổi (giữ vị trí scroll)
      if (prevState === this.tgState && prevSig === this._feedSig) return;
      emit('data:changed');
      if (this.tgState === 'ok') this.loadViews();
    },
  };

  // ---- Bookmark (localStorage) ----
  const Bookmarks = {
    list() { const v = readJson(LS_BOOKMARKS, []); return Array.isArray(v) ? v.map(String) : []; },
    has(id) { return this.list().includes(String(id)); },
    toggle(id) {
      const sid = String(id);
      const list = this.list();
      const next = list.includes(sid) ? list.filter(x => x !== sid) : [sid, ...list];
      writeJson(LS_BOOKMARKS, next);
      emit('bookmarks:changed', { id: sid, on: next.includes(sid) });
      return next.includes(sid);
    },
    clear() { writeJson(LS_BOOKMARKS, []); emit('bookmarks:changed', {}); },
    movies() {
      const ids = this.list();
      const map = new Map(Store.all().map(m => [String(m.id), m]));
      return ids.map(id => map.get(id)).filter(Boolean);
    },
  };

  // ---- Settings ----
  const DEFAULT_SETTINGS = { autoplay: true };
  const Settings = {
    all() { return Object.assign({}, DEFAULT_SETTINGS, readJson(LS_SETTINGS, {})); },
    get(key) { return this.all()[key]; },
    set(key, val) {
      const s = this.all(); s[key] = val; writeJson(LS_SETTINGS, s);
      emit('settings:changed', { key, val });
    },
  };

  window.Store = Store;
  window.Bookmarks = Bookmarks;
  window.Settings = Settings;
})();
