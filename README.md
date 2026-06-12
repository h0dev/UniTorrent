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

**Config nhúng trong URL** — mỗi người có 1 URL riêng, không cần cấu hình trong Stremio.

## Cách dùng

1. Mở **https://v0mlmko9-jackett-torrserver-addon.hf.space/configure**
2. Điền thông tin Jackett + TorrServer của bạn
3. Click "Tạo URL cá nhân"
4. Copy URL → Stremio → Addons → Install from URL

## Cấu trúc URL

```
https://.../stremio/{uuid}/{base64_config}/manifest.json
https://.../stremio/{uuid}/{base64_config}/stream/{type}/{id}.json
```

Base64 config chứa: Jackett URL, API Key, TorrServer URL, Max Results.
