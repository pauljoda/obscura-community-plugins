# MangaDex

Manga and comic book identification via the MangaDex API.

## Capabilities

- `bookByURL`, `bookByName`, `bookByFragment`
- `comicByURL`, `comicByName`, `comicByFragment`
- `mangaByURL`, `mangaByName`, `mangaByFragment`

MangaDex adult ratings are requested only when Obscura runs the plugin with NSFW mode enabled. The plugin itself is not marked NSFW.

## Auth

Create a MangaDex personal client and configure these required auth fields in Obscura:

- `MANGADEX_CLIENT_ID`
- `MANGADEX_CLIENT_SECRET`
- `MANGADEX_USERNAME`
- `MANGADEX_PASSWORD`
