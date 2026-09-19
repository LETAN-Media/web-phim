// App chính: router (hash), render các view, trang chi tiết, bottom nav, scroll-to-top.
(function () {
  const $ = id => document.getElementById(id);
  const { Icons, el, escapeHtml, mediaRow, emptyState, fillGrid, skeletonRow, skeletonGrid, ratingHtml } = UI;

  // URL dùng trong CSS url("...") — loại ký tự có thể phá cú pháp
  const cssUrl = u => `url("${String(u || '').replace(/["\\\n\r)]/g, '')}")`;

  const VIEWS = ['home', 'movies', 'new', 'bookmarks', 'search', 'settings'];
  const state = { route: 'home', genre: 'Tất cả', query: '', inAppNav: false };

  // ===================== Router =====================
  function parseHash() {
    const raw = (location.hash || '#/').replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const params = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'movie' && parts[1]) return { route: 'movie', id: decodeURIComponent(parts[1]), params };
    return { route: VIEWS.includes(parts[0]) ? parts[0] : 'home', params };
  }

  function navigate(hash) { if (location.hash !== hash) location.hash = hash; else onRoute(); }

  function onRoute() {
    const r = parseHash();
    if (r.route === 'movie') { openDetail(r.id); return; }
    closeDetail();
    if (r.route === 'movies') state.genre = r.params.get('genre') || 'Tất cả';
    if (r.route === 'search' && r.params.has('q')) state.query = r.params.get('q') || '';
    showView(r.route);
  }

  function showView(route) {
    const changed = state.route !== route;
    state.route = route;
    VIEWS.forEach(v => { $('view-' + v).hidden = v !== route; });
    document.querySelectorAll('[data-route]').forEach(a => {
      const on = a.dataset.route === route;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('hero').hidden = route !== 'home';
    RENDER[route]();
    if (changed) window.scrollTo(0, 0);
    if (route === 'search') setTimeout(() => $('searchInput').focus({ preventScroll: true }), 60);
  }

  // ===================== Hero =====================
  function renderHero(m) {
    const hero = $('hero');
    if (!m) { hero.hidden = true; return; }
    const img = m.backdrop || m.poster;
    preloadImage(img);
    $('heroBg').style.backgroundImage = cssUrl(img);
    $('heroTitle').textContent = m.title;
    $('heroMeta').innerHTML = metaHtml(m);
    $('heroDesc').textContent = m.desc || '';
    $('heroDesc').hidden = !m.desc;
    $('heroPlay').href = `#/movie/${encodeURIComponent(m.id)}?play=1`;
    $('heroInfo').href = `#/movie/${encodeURIComponent(m.id)}`;
    hero.hidden = state.route !== 'home';
  }

  // Dùng chung 1 thẻ <link rel=preload> cho ảnh quan trọng (hero / backdrop đang xem)
  const preloadLink = document.createElement('link');
  preloadLink.rel = 'preload'; preloadLink.as = 'image';
  function preloadImage(src) {
    if (!src || preloadLink.href === src) return;
    preloadLink.href = src;
    if (!preloadLink.parentNode) document.head.appendChild(preloadLink);
  }

  function metaHtml(m, { withGenre = true } = {}) {
    const parts = [];
    if (m.rating != null) parts.push(ratingHtml(m.rating, 14).replace('</span>', '<small style="color:var(--muted);font-weight:500">/10</small></span>'));
    if (m.year) parts.push(`<span>${Icons.calendar()}${escapeHtml(m.year)}</span>`);
    if (withGenre && m.genres && m.genres[0]) parts.push(`<span class="genre">${Icons.tag()}${escapeHtml(m.genres[0])}</span>`);
    if (m.quality && m.quality !== 'TELE') parts.push(`<span>${escapeHtml(m.quality)}</span>`);
    return parts.join('<i class="dot" aria-hidden="true"></i>');
  }

  // ===================== HOME =====================
  function renderHome() {
    const wrap = $('homeRows');
    wrap.innerHTML = '';
    renderHero(Store.featured());

    const frag = document.createDocumentFragment();
    const tgSection = buildTgSection();
    if (tgSection) frag.appendChild(tgSection);

    const add = (title, list, opts) => { const s = mediaRow(title, list, opts); if (s) frag.appendChild(s); };
    add('Đánh giá cao', Store.topRated(), { href: '#/movies' });
    add('Mới nhất', Store.latest().filter(m => !Store.isTg(m)), { href: '#/movies' });
    const saved = Bookmarks.movies();
    if (saved.length) add('Đã lưu của bạn', saved, { href: '#/bookmarks' });
    Store.genres().filter(g => g !== 'Mới cập nhật').forEach(g => {
      add(g, Store.byGenre(g), { href: `#/movies?genre=${encodeURIComponent(g)}` });
    });
    wrap.appendChild(frag);
  }

  function buildTgSection() {
    if (Store.tgState === 'unconfigured') return null;
    if (Store.tgState === 'loading') {
      const s = el(`<section class="section">${UI.sectionHeader('Mới cập nhật', { count: 'đang tải...' })}</section>`);
      s.appendChild(skeletonRow(4, true));
      return s;
    }
    if (Store.tgState === 'error') {
      return el(`<section class="section">${UI.sectionHeader('Mới cập nhật', { count: '' })}<p class="status error">Không kết nối được server đồng bộ Telegram.</p></section>`);
    }
    if (!Store.tgMovies.length) {
      return el(`<section class="section">${UI.sectionHeader('Mới cập nhật', { href: '#/new' })}<p class="status">Kênh chưa có video nào.</p></section>`);
    }
    return mediaRow('Mới cập nhật', Store.tgMovies, { href: '#/new', landscape: true });
  }

  // ===================== MOVIES =====================
  function renderMovies() {
    const genres = ['Tất cả', ...Store.genres()];
    if (!genres.includes(state.genre)) state.genre = 'Tất cả';
    const bar = $('genreBar');
    bar.innerHTML = '';
    genres.forEach(g => {
      const b = el(`<button class="chip${g === state.genre ? ' active' : ''}" role="tab" aria-selected="${g === state.genre}">${escapeHtml(g)}</button>`);
      b.onclick = () => navigate(g === 'Tất cả' ? '#/movies' : `#/movies?genre=${encodeURIComponent(g)}`);
      bar.appendChild(b);
    });
    bar.querySelector('.chip.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });

    const list = Store.byGenre(state.genre);
    $('moviesTitle').textContent = state.genre === 'Tất cả' ? 'Tất cả phim' : state.genre;
    $('moviesCount').textContent = `${list.length} phim`;
    const grid = $('movieGrid');
    grid.classList.toggle('landscape', list.length > 0 && list.every(m => Store.isTg(m)));
    fillGrid(grid, list);
    $('moviesEmpty').innerHTML = '';
    if (list.length) return;
    const e = emptyState({ title: 'Không có phim', text: 'Thể loại này chưa có phim nào.', actionHtml: '<button class="btn btn-ghost" id="moviesReset">Xem tất cả</button>' });
    $('moviesEmpty').appendChild(e);
    $('moviesReset').onclick = () => navigate('#/movies');
  }

  // ===================== NEW (Telegram) =====================
  function renderNew() {
    const body = $('newBody');
    const st = $('newStatus');
    body.innerHTML = '';
    st.className = 'count status';
    if (Store.tgState === 'loading') { st.textContent = 'đang tải...'; body.appendChild(skeletonGrid(6, true)); return; }
    if (Store.tgState === 'unconfigured') {
      st.textContent = 'chưa kết nối kênh';
      body.appendChild(emptyState({ icon: Icons.tv(28), title: 'Chưa kết nối kênh Telegram', text: 'Cấu hình bot_token trong tg-config.json để tự đồng bộ video từ kênh.' }));
      return;
    }
    if (Store.tgState === 'error') {
      st.textContent = 'lỗi kết nối'; st.classList.add('error');
      body.appendChild(emptyState({ icon: Icons.tv(28), title: 'Không kết nối được server đồng bộ', text: 'Server telegram-sync có thể đang tắt. Thử lại sau.', actionHtml: '<button class="btn btn-ghost" id="newRetry">Thử lại</button>' }));
      $('newRetry').onclick = () => { Store.tgState = 'loading'; renderNew(); Store.loadFeed(); };
      return;
    }
    st.textContent = Store.tgCount ? `${Store.tgCount} video` : 'kênh chưa có video';
    if (!Store.tgMovies.length) {
      body.appendChild(emptyState({ icon: Icons.tv(28), title: 'Kênh chưa có video nào', text: 'Up video lên kênh Telegram, web sẽ tự hiển thị trong khoảng 1 phút.' }));
      return;
    }
    const grid = el('<div class="grid landscape"></div>');
    fillGrid(grid, Store.tgMovies, { landscape: true });
    body.appendChild(grid);
  }

  // ===================== BOOKMARKS =====================
  function renderBookmarks() {
    const list = Bookmarks.movies();
    const body = $('bookmarkBody');
    body.innerHTML = '';
    $('bookmarkCount').textContent = list.length ? `${list.length} phim` : '';
    if (!list.length) {
      body.appendChild(emptyState({ icon: Icons.bookmark(28), title: 'Chưa lưu phim nào', text: 'Bấm biểu tượng bookmark ở trang chi tiết để lưu phim xem sau.', actionHtml: '<a class="btn btn-ghost" href="#/movies">Khám phá phim</a>' }));
      return;
    }
    const grid = el('<div class="grid"></div>');
    fillGrid(grid, list);
    body.appendChild(grid);
  }

  // ===================== SEARCH =====================
  let searchTimer = null;
  function renderSearch() {
    const input = $('searchInput');
    if (input.value !== state.query) input.value = state.query;
    runSearch();
  }
  function runSearch() {
    const q = state.query.trim();
    const body = $('searchBody');
    const hint = $('searchHint');
    $('searchClear').hidden = !q;
    body.innerHTML = '';
    if (!q) {
      hint.textContent = 'Nhập tên phim hoặc thể loại để tìm.';
      const rec = mediaRow('Gợi ý cho bạn', Store.topRated(), { href: '#/movies' });
      if (rec) body.appendChild(rec);
      return;
    }
    const list = Store.search(q);
    hint.textContent = list.length ? `${list.length} kết quả cho “${q}”` : '';
    if (!list.length) {
      body.appendChild(emptyState({ icon: Icons.search(28), title: 'Không tìm thấy phim', text: `Không có kết quả cho “${q}”. Thử từ khóa khác.` }));
      return;
    }
    const grid = el('<div class="grid"></div>');
    fillGrid(grid, list);
    body.appendChild(grid);
  }
  // Tìm kiếm là lọc local nên chỉ debounce, không thay kết quả cũ bằng skeleton (tránh nhấp nháy)
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 220);
  }

  // ===================== SETTINGS =====================
  function renderSettings() {
    const body = $('settingsBody');
    const s = Settings.all();
    const tgLabel = { ok: `Đã kết nối · ${Store.tgCount} video`, loading: 'Đang kiểm tra...', unconfigured: 'Chưa cấu hình bot_token', error: 'Không kết nối được' }[Store.tgState];
    body.innerHTML = `
      <div class="settings-group">
        <h3>Phát video</h3>
        <button class="setting" role="switch" aria-checked="${s.autoplay}" data-setting="autoplay">
          <span class="ico">${Icons.play(18)}</span>
          <span class="txt"><b>Tự động phát</b><small>Phát ngay khi bấm nút Phát ở trang chi tiết</small></span>
          <span class="switch" aria-hidden="true"></span>
        </button>
      </div>
      <div class="settings-group">
        <h3>Quản lý</h3>
        <a class="setting" href="admin.html"><span class="ico">${Icons.plus(18)}</span><span class="txt"><b>Đăng phim</b><small>Thêm phim thủ công (MP4 / YouTube / Telegram)</small></span><span class="chev">${Icons.chevron()}</span></a>
        <a class="setting" href="upload.html"><span class="ico">${Icons.upload(18)}</span><span class="txt"><b>Up video</b><small>Up file dung lượng lớn lên server</small></span><span class="chev">${Icons.chevron()}</span></a>
        <div class="setting" style="cursor:default"><span class="ico">${Icons.tv(18)}</span><span class="txt"><b>Kênh Telegram</b><small>${escapeHtml(tgLabel || '')}</small></span></div>
      </div>
      <div class="settings-group">
        <h3>Dữ liệu</h3>
        <div class="setting" style="cursor:default"><span class="ico">${Icons.film(18)}</span><span class="txt"><b>Thư viện</b><small>${Store.all().length} phim · ${Store.custom().length} phim đăng thủ công · ${Bookmarks.list().length} đã lưu</small></span></div>
        <button class="setting danger" id="clearBookmarks" ${Bookmarks.list().length ? '' : 'disabled style="opacity:.5"'}><span class="ico">${Icons.trash(18)}</span><span class="txt"><b>Xóa danh sách đã lưu</b><small>Chỉ xóa bookmark, không ảnh hưởng phim</small></span></button>
      </div>`;
    body.querySelector('[data-setting="autoplay"]').onclick = e => {
      const next = !(e.currentTarget.getAttribute('aria-checked') === 'true');
      Settings.set('autoplay', next);
      e.currentTarget.setAttribute('aria-checked', next);
    };
    body.querySelector('#clearBookmarks').onclick = () => { if (confirm('Xóa toàn bộ phim đã lưu?')) { Bookmarks.clear(); renderSettings(); } };
  }

  const RENDER = { home: renderHome, movies: renderMovies, new: renderNew, bookmarks: renderBookmarks, search: renderSearch, settings: renderSettings };

  // ===================== DETAIL =====================
  const detail = $('detail');
  const playerWrap = $('playerWrap');
  let currentMovie = null;
  let lastFocus = null;

  function openDetail(id) {
    const m = Store.byId(id);
    if (!m) { navigate('#/'); return; }
    const isNew = !currentMovie || String(currentMovie.id) !== String(id);
    currentMovie = m;
    if (isNew) stopPlayer();

    const img = m.backdrop || m.poster;
    preloadImage(img);
    $('dBackdrop').style.backgroundImage = cssUrl(img);
    $('dTitle').textContent = m.title;
    $('dMeta').innerHTML = metaHtml(m);
    $('dDesc').textContent = m.desc || 'Chưa có mô tả cho phim này.';
    $('dGenres').innerHTML = (m.genres || []).map(g => `<a href="#/movies?genre=${encodeURIComponent(g)}">${escapeHtml(g)}</a>`).join('');
    renderBookmarkBtn();
    if (isNew) {
      $('dDesc').classList.remove('expanded');
      $('dInfo').innerHTML = Icons.info(22);
      $('dInfo').setAttribute('aria-expanded', 'false');
      $('dTelegram').innerHTML = '';
      $('dNote').textContent = '';
    }

    const related = $('dRelated');
    related.innerHTML = '';
    const row = mediaRow('Có thể bạn thích', Store.related(m), {});
    if (row) related.appendChild(row);

    if (detail.hidden) {
      lastFocus = document.activeElement;
      detail.hidden = false;
      document.body.style.overflow = 'hidden';
      setBackgroundInert(true);
      $('dBack').focus({ preventScroll: true });
    }
    if (!isNew) return;
    detail.scrollTop = 0;
    toTop.classList.remove('show');
    if (parseHash().params.get('play') === '1') play();
  }

  function closeDetail() {
    if (detail.hidden) return;
    stopPlayer();
    detail.hidden = true;
    document.body.style.overflow = '';
    setBackgroundInert(false);
    currentMovie = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  // Khóa focus/click phần nền khi detail (dialog) đang mở
  function setBackgroundInert(on) {
    ['main', 'topbar', 'bottomNav', 'footer'].forEach(id => { const n = $(id); if (n) n.inert = on; });
  }

  function stopPlayer() {
    playerWrap.innerHTML = '';
    playerWrap.hidden = true;
    $('detailTop').classList.remove('playing');
    $('detailBar').classList.remove('playing');
    $('dPlay').querySelector('span').textContent = 'Phát';
  }

  function play() {
    if (!currentMovie) return;
    const autoplay = Settings.get('autoplay') !== false;
    const { telegramUrl, note } = Player.buildPlayer(currentMovie, playerWrap, { autoplay });
    playerWrap.hidden = false;
    $('detailTop').classList.add('playing');
    $('detailBar').classList.add('playing');
    $('dPlay').querySelector('span').textContent = 'Xem lại';
    $('dNote').textContent = note || '';
    $('dTelegram').innerHTML = telegramUrl
      ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(telegramUrl)}" target="_blank" rel="noopener">${Icons.external()} Mở trên Telegram</a>`
      : '';
    detail.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderBookmarkBtn() {
    if (!currentMovie) return;
    const on = Bookmarks.has(currentMovie.id);
    const btn = $('dBookmark');
    btn.innerHTML = on ? Icons.bookmarkFill(22) : Icons.bookmark(22);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    btn.setAttribute('aria-label', on ? 'Bỏ lưu phim' : 'Lưu phim');
  }

  function goBack() {
    // Chỉ dùng history.back() khi người dùng đã điều hướng trong app; mở link trực tiếp thì về trang chủ.
    if (state.inAppNav) { history.back(); return; }
    navigate('#/');
  }

  $('dBack').onclick = goBack;
  $('dPlay').onclick = play;
  $('dBookmark').onclick = () => { if (currentMovie) Bookmarks.toggle(currentMovie.id); };
  $('dInfo').onclick = e => {
    const d = $('dDesc');
    const expanded = d.classList.toggle('expanded');
    e.currentTarget.setAttribute('aria-expanded', expanded);
    e.currentTarget.innerHTML = expanded ? Icons.close(20) : Icons.info(22);
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !detail.hidden) goBack(); });

  // ===================== Global events =====================
  document.addEventListener('data:changed', () => {
    RENDER[state.route]();
    if (!detail.hidden && currentMovie) openDetail(currentMovie.id);
  });
  document.addEventListener('bookmarks:changed', () => {
    renderBookmarkBtn();
    if (['bookmarks', 'home', 'settings'].includes(state.route)) RENDER[state.route]();
  });

  $('searchInput').addEventListener('input', e => { state.query = e.target.value; scheduleSearch(); });
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); $('searchInput').blur(); });
  $('searchClear').onclick = () => { state.query = ''; $('searchInput').value = ''; runSearch(); $('searchInput').focus(); };

  // Top bar shadow + scroll-to-top
  const toTop = $('toTop');
  const topbar = $('topbar');
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      topbar.classList.toggle('scrolled', y > 8);
      toTop.classList.toggle('show', y > 600 && detail.hidden);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  toTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  window.addEventListener('hashchange', () => { state.inAppNav = true; onRoute(); });

  // ===================== Boot =====================
  onRoute();
  Store.loadFeed();
  setInterval(() => Store.loadFeed(), 60000); // tự refresh mỗi phút để thấy video mới mà không cần F5
})();
