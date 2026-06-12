---
title: Jackett TorrServer Addon
emoji: ⚡
colorFrom: blue
colorTo: purple
sdk: docker
pinned: false
---

# Jackett TorrServer Stremio Addon

Stremio addon: tìm torrent qua Jackett, phát qua TorrServer hoặc Stremio built-in torrent client.

Config là **per-user** — mỗi người tự điền thông tin Jackett/TorrServer của riêng mình trong Stremio.

## Cài đặt

1. Mở `https://v0mlmko9-jackett-torrserver-addon.hf.space/`
2. Click nút "Mở trong Stremio" hoặc copy manifest URL
3. Trong Stremio → Addons → Install from URL
4. Vào **Settings** của addon → điền:
   - **Jackett Server URL**: Địa chỉ Jackett (VD: http://192.168.1.100:9117)
   - **Jackett API Key**: API key từ Jackett Dashboard
   - **TorrServer URL** (tùy chọn): Để trống nếu muốn dùng Stremio built-in torrent
5. Tìm phim và xem! 🎬

## Environment Variables (fallback cho shared hosting)

Nếu không config trong Stremio, addon sẽ dùng:
- `JACKETT_URL`
- `JACKETT_API_KEY`
- `TORRSERVER_URL`
