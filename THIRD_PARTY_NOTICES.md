# Сторонние компоненты

Это приложение включает Electron и electron-updater. Сборщик сохраняет лицензионные файлы Electron вместе с установленной программой.

Импорт YouTube использует официальный бинарник yt-dlp для соответствующей системы. Версия, SHA256, ссылки на исходники и лицензионные сведения находятся в папке `media` рядом с ресурсами приложения.

Официальные сведения: https://github.com/yt-dlp/yt-dlp#license

## FFmpeg

Для локальной конвертации в MP3 приложение запускает отдельный процесс FFmpeg. На Linux и macOS используется системная установка FFmpeg. Сборка для Windows включает неизменённые `ffmpeg.exe` и DLL из [FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-11-20-12-40), вариант Windows x64 LGPL shared. Лицензия и подробности сборки находятся в `resources/media/ffmpeg/LICENSE.txt` и `resources/media/ffmpeg/BUILD.txt`.

- [Исходный код FFmpeg для этой сборки](https://github.com/FFmpeg/FFmpeg/tree/d59078794d)
- [Сценарии сборки и зависимости](https://github.com/FFmpeg-Builds/FFmpeg-Builds)
