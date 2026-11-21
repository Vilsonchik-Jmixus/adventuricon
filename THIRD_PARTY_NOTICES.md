# Сторонние компоненты

Это приложение включает Electron и electron-updater. Сборщик сохраняет лицензионные файлы Electron вместе с установленной программой.

Импорт YouTube использует официальный Windows-бинарник yt-dlp. Его версию и SHA256 можно найти в `resources/media/VERSION.txt`. При подготовке сборки рядом сохраняются лицензионные сведения проекта. Условия распространяются только на соответствующие компоненты, а не на сторонние сайты и медиа.

Официальные сведения: https://github.com/yt-dlp/yt-dlp#license

## FFmpeg

Для локальной конвертации в MP3 приложение запускает отдельный процесс FFmpeg. Оно включает неизменённые `ffmpeg.exe` и DLL из [сборки FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-11-20-12-40), вариант Windows x64 LGPL shared. Лицензия и подробности сборки находятся в `resources/media/ffmpeg/LICENSE.txt` и `resources/media/ffmpeg/BUILD.txt`.

- [Исходный код FFmpeg для этой сборки](https://github.com/FFmpeg/FFmpeg/tree/d59078794d)
- [Сценарии сборки и зависимости](https://github.com/FFmpeg-Builds/FFmpeg-Builds)
