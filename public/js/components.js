// Component tái sử dụng (vanilla JS). Tất cả trả về HTMLElement hoặc chuỗi HTML.
(function () {
  const svg = (path, opts = {}) => {
    const { size = 22, fill = 'none', stroke = 'currentColor', sw = 2 } = opts;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  };

  const Icons = {
    play: (s = 18) => svg('<path d="M7 4.5v15l12-7.5z"/>', { size: s, fill: 'currentColor', stroke: 'none' }),
    star: (s = 13) => svg('<path d="M12 2.5l2.9 6.2 6.7.8-5 4.6 1.4 6.7L12 17.4 6 20.8l1.4-6.7-5-4.6 6.7-.8z"/>', { size: s, fill: 'currentColor', stroke: 'none' }),
    bookmark: (s = 22) => svg('<path d="M6 3.5h12a1 1 0 011 1V21l-7-4.2L5 21V4.5a1 1 0 011-1z"/>', { size: s }),
    bookmarkFill: (s = 22) => svg('<path d="M6 3.5h12a1 1 0 011 1V21l-7-4.2L5 21V4.5a1 1 0 011-1z"/>', { size: s, fill: 'currentColor', stroke: 'none' }),
    close: (s = 18) => svg('<path d="M6 6l12 12M18 6L6 18"/>', { size: s, sw: 2.2 }),
    search: (s = 22) => svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/>', { size: s }),
    film: (s = 22) => svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>', { size: s }),
    tv: (s = 22) => svg('<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M8 3l4 3 4-3"/>', { size: s }),
    arrowRight: (s = 14) => svg('<path d="M5 12h14M13 6l6 6-6 6"/>', { size: s, sw: 2.2 }),
    calendar: (s = 14) => svg('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>', { size: s }),
    tag: (s = 14) => svg('<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V4a1 1 0 011-1h9l7.6 7.6a2 2 0 010 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>', { size: s }),
    info: (s = 20) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', { size: s }),
    external: (s = 16) => svg('<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5"/>', { size: s }),
    upload: (s = 20) => svg('<path d="M12 16V5m0 0L8 9m4-4l4 4"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/>', { size: s }),
    plus: (s = 20) => svg('<path d="M12 5v14M5 12h14"/>', { size: s, sw: 2.2 }),
    trash: (s = 20) => svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', { size: s }),
    chevron: (s = 18) => svg('<path d="M9 6l6 6-6 6"/>', { size: s }),
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Poster fallback: SVG nội bộ, không gọi mạng khi ảnh lỗi
  function posterFallback(landscape) {
    const w = landscape ? 480 : 400, h = landscape ? 270 : 600;
    const s = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='#131819'/><g fill='none' stroke='#3a4448' stroke-width='6' stroke-linecap='round'><rect x='${w / 2 - 44}' y='${h / 2 - 34}' width='88' height='68' rx='10'/><path d='M${w / 2 - 26} ${h / 2 - 34}v68M${w / 2 + 26} ${h / 2 - 34}v68'/></g></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  function wireImage(img, landscape) {
    if (!img) return;
    const done = () => img.classList.add('loaded');
    if (img.complete && img.naturalWidth) done(); else img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => { img.onerror = null; img.src = posterFallback(landscape); done(); }, { once: true });
  }

  function ratingHtml(rating, size = 13) {
    if (rating == null || rating === '') return '';
    return `<span class="rating">${Icons.star(size)}${escapeHtml(Number(rating).toFixed(1))}</span>`;
  }

  function movieCard(m, opts = {}) {
    const landscape = !!(opts.landscape || m.landscape);
    const eager = !!opts.eager;
    const subParts = [];
    if (m.rating != null) subParts.push(ratingHtml(m.rating, 12));
    if (m.tgDate) subParts.push(`<span>${escapeHtml(m.tgDate)}</span>`);
    else if (m.year) subParts.push(`<span>${escapeHtml(m.year)}</span>`);

    const card = el(`
      <a class="card${landscape ? ' landscape' : ''}" href="#/movie/${encodeURIComponent(m.id)}" aria-label="${escapeHtml(m.title)}">
        <div class="poster">
          <img ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" src="${escapeHtml(m.poster)}" alt="" />
          ${m.tgNew ? '<span class="badge new">MỚI</span>' : (m.quality && m.quality !== 'TELE' ? `<span class="badge">${escapeHtml(m.quality)}</span>` : '')}
          ${Bookmarks.has(m.id) ? `<span class="bm" aria-hidden="true">${Icons.bookmarkFill(13)}</span>` : ''}
          <div class="play-hint"><span>${Icons.play(20)}</span></div>
        </div>
        <div class="card-body">
          <h3>${escapeHtml(m.title)}</h3>
          <div class="sub">${subParts.join('')}</div>
        </div>
      </a>`);
    wireImage(card.querySelector('img'), landscape);
    return card;
  }

  function sectionHeader(title, opts = {}) {
    const right = opts.href
      ? `<a class="more" href="${escapeHtml(opts.href)}">Xem tất cả ${Icons.arrowRight()}</a>`
      : (opts.count != null ? `<span class="count">${escapeHtml(opts.count)}</span>` : '');
    return `<div class="section-head"><h2>${escapeHtml(title)}</h2>${right}</div>`;
  }

  function mediaRow(title, movies, opts = {}) {
    if (!movies || !movies.length) return null;
    const section = el(`<section class="section">${sectionHeader(title, opts)}<div class="row-scroll${opts.landscape ? ' landscape' : ''}"></div></section>`);
    const row = section.querySelector('.row-scroll');
    const frag = document.createDocumentFragment();
    movies.slice(0, opts.limit || 20).forEach(m => frag.appendChild(movieCard(m, { landscape: opts.landscape })));
    row.appendChild(frag);
    return section;
  }

  function skeletonCard(landscape) {
    return el(`<div class="skel-card${landscape ? ' landscape' : ''}"><div class="skel poster"></div><div class="skel line"></div><div class="skel line short"></div></div>`);
  }
  function skeletonRow(count = 6, landscape = false) {
    const row = el(`<div class="row-scroll${landscape ? ' landscape' : ''}" aria-busy="true"></div>`);
    for (let i = 0; i < count; i++) row.appendChild(skeletonCard(landscape));
    return row;
  }
  function skeletonGrid(count = 9, landscape = false) {
    const grid = el(`<div class="grid${landscape ? ' landscape' : ''}" aria-busy="true"></div>`);
    for (let i = 0; i < count; i++) grid.appendChild(skeletonCard(landscape));
    return grid;
  }

  function emptyState({ icon, title, text, actionHtml = '' }) {
    return el(`<div class="empty"><div class="ico">${icon || Icons.film(28)}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text || '')}</p>${actionHtml}</div>`);
  }

  function fillGrid(container, movies, opts = {}) {
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    movies.forEach(m => frag.appendChild(movieCard(m, opts)));
    container.appendChild(frag);
  }

  window.UI = { Icons, escapeHtml, el, posterFallback, wireImage, ratingHtml, movieCard, mediaRow, sectionHeader, skeletonRow, skeletonGrid, emptyState, fillGrid };
})();
