// Player: MP4 trực tiếp / bài đăng Telegram / YouTube / Eporner. Logic giữ nguyên từ bản cũ.
(function () {
  function youtubeId(url) {
    const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
    return m ? m[1] : null;
  }

  // Eporner: nhận link watch (hd-porn/<id>/...) hoặc link embed (embed/<id>).
  // Embed chính thức: https://www.eporner.com/embed/<id>
  function epornerId(url) {
    const m = String(url).match(/eporner\.com\/(?:embed\/|hd-porn\/|video-)([A-Za-z0-9]{5,})/);
    return m ? m[1] : null;
  }

  // Trả về { telegramUrl, note } để UI hiển thị nút "Mở trên Telegram" và ghi chú.
  function buildPlayer(movie, wrap, { autoplay = true } = {}) {
    const url = (movie.videoUrl || '').trim();
    const esc = UI.escapeHtml;
    const auto = autoplay ? 1 : 0;
    const isHttp = /^https?:\/\//i.test(url);

    const yt = youtubeId(url);
    if (yt) {
      wrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${yt}?autoplay=${auto}&rel=0" title="${esc(movie.title)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
      return { telegramUrl: null, note: '' };
    }
    const ep = epornerId(url);
    if (ep) {
      wrap.innerHTML = `<iframe src="https://www.eporner.com/embed/${ep}" title="${esc(movie.title)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
      return { telegramUrl: null, note: '' };
    }
    if (isHttp && url.includes('t.me/')) {
      // Kênh phải là public thì embed mới chạy
      const embedUrl = url.split('?')[0] + '?embed=1';
      wrap.innerHTML = `<iframe src="${esc(embedUrl)}" title="${esc(movie.title)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
      return { telegramUrl: url, note: 'Video nhúng từ Telegram. Nếu không phát được, chọn “Mở trên Telegram” (kênh phải để công khai).' };
    }
    // Mặc định: file MP4 trực tiếp (kể cả /api/tg-stream)
    wrap.innerHTML = `<video controls ${autoplay ? 'autoplay' : ''} playsinline preload="metadata" src="${esc(url)}"></video>`;
    return { telegramUrl: null, note: '' };
  }

  window.Player = { youtubeId, epornerId, buildPlayer };
})();
