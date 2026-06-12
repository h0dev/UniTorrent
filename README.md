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

## Cấu hình

Sau khi deploy, mở URL Space → điền thông tin:
- **Jackett URL**: Địa chỉ server Jackett (VD: http://192.168.1.100:9117)
- **Jackett API Key**: API key từ Jackett Dashboard
- **TorrServer URL** (tùy chọn): Địa chỉ TorrServer (VD: http://192.168.1.100:8090)

Hoặc cấu hình qua biến môi trường:
- `JACKETT_URL`
- `JACKETT_API_KEY`
- `TORRSERVER_URL`

## Thêm vào Stremio

Mở URL: `https://v0mlmko9-jackett-torrserver-addon.hf.space/manifest.json`
→ Stremio → Addons → Install from URL
