// Danh sách phim mẫu. Bạn thay bằng phim của bạn.
// videoUrl hỗ trợ 3 loại:
//  1. Link MP4 trực tiếp (kể cả link Telegram dạng https://api.telegram.org/file/bot<token>/...mp4)
//  2. Link Telegram public dạng https://t.me/tenkenh/123  -> web sẽ nhúng player Telegram
//  3. Link YouTube https://www.youtube.com/watch?v=... hoặc https://youtu.be/...
const DEFAULT_MOVIES = [
  {
    id: 1,
    title: "Big Buck Bunny",
    year: 2024,
    rating: 8.2,
    quality: "FHD",
    genres: ["Hoạt hình", "Hài"],
    poster: "https://picsum.photos/seed/bunny/400/600",
    backdrop: "https://picsum.photos/seed/bunnybg/1200/500",
    desc: "Chú thỏ khổng lồ hài hước trả đũa ba loài gặm nhấm trong rừng. Phim demo dùng để test trình phát video.",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
  },
  {
    id: 2,
    title: "Elephants Dream",
    year: 2023,
    rating: 7.9,
    quality: "HD",
    genres: ["Viễn tưởng", "Hoạt hình"],
    poster: "https://picsum.photos/seed/elephant/400/600",
    backdrop: "https://picsum.photos/seed/elephantbg/1200/500",
    desc: "Hai nhà du hành khám phá cỗ máy khổng lồ bí ẩn. Phim mã nguồn mở đầu tiên trên thế giới.",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4"
  },
  {
    id: 3,
    title: "Sintel - Nữ Chiến Binh",
    year: 2024,
    rating: 8.7,
    quality: "FHD",
    genres: ["Hành động", "Viễn tưởng"],
    poster: "https://picsum.photos/seed/sintel/400/600",
    backdrop: "https://picsum.photos/seed/sintelbg/1200/500",
    desc: "Sintel lên đường tìm chú rồng con năm xưa. Hành trình đầy cảm xúc giữa tuyết trắng và lửa rồng.",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4"
  },
  {
    id: 4,
    title: "Tears of Steel",
    year: 2022,
    rating: 7.5,
    quality: "HD",
    genres: ["Khoa học", "Tình cảm"],
    poster: "https://picsum.photos/seed/steel/400/600",
    backdrop: "https://picsum.photos/seed/steelbg/1200/500",
    desc: "40 năm sau cuộc chia tay ở Amsterdam, nhóm khoa học gia tái hợp để cứu thế giới khỏi robot.",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4"
  },
  {
    id: 5,
    title: "For Bigger Blazes",
    year: 2025,
    rating: 8.0,
    quality: "CAM",
    genres: ["Hài", "Quảng cáo"],
    poster: "https://picsum.photos/seed/blazes/400/600",
    backdrop: "https://picsum.photos/seed/blazesbg/1200/500",
    desc: "Phim ngắn demo trình phát. Bạn hãy thay bằng link Telegram của bạn trong trang Đăng phim.",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
  },
  {
    id: 6,
    title: "Demo Link Telegram",
    year: 2025,
    rating: 9.0,
    quality: "FHD",
    genres: ["Hành động", "Chiếu rạp"],
    poster: "https://picsum.photos/seed/telegramdemo/400/600",
    backdrop: "https://picsum.photos/seed/telegrambg/1200/500",
    desc: "Ví dụ minh họa: khi bạn dán link Telegram dạng https://t.me/tenkenh/123, web sẽ tự nhúng player Telegram. Hãy thay link này bằng bài đăng thật trong kênh của bạn.",
    videoUrl: "https://t.me/durov/383"
  },
  {
    id: 7,
    title: "Subaru Outback",
    year: 2023,
    rating: 7.2,
    quality: "HD",
    genres: ["Phiêu lưu", "Tài liệu"],
    poster: "https://picsum.photos/seed/subaru/400/600",
    backdrop: "https://picsum.photos/seed/subarubg/1200/500",
    desc: "Hành trình khám phá thiên nhiên hoang dã. Thay poster dọc (tỉ lệ 2:3) và link video của bạn dễ dàng.",
    videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4"
  },
  {
    id: 8,
    title: "Thử Nghiệm YouTube",
    year: 2024,
    rating: 8.4,
    quality: "HD",
    genres: ["Hài", "Viễn tưởng"],
    poster: "https://picsum.photos/seed/youtube/400/600",
    backdrop: "https://picsum.photos/seed/youtubebg/1200/500",
    desc: "Ví dụ link YouTube. Chỉ cần dán link YouTube, web tự chuyển sang dạng nhúng.",
    videoUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
  }
];
