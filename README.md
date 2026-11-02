# Our Days

A shared daily planner for two people. Installable web app (PWA) hosted on GitHub Pages, with sync through Firebase (Authentication with email and password, Cloud Firestore).

## Files
- `index.html` the whole app
- `sw.js` service worker for offline use and fast updates
- `manifest.webmanifest` and `icons/` for installing on phones and laptops
- `firestore.rules` security rules, pasted into Firebase console > Firestore Database > Rules

## Updating
Change `index.html` and push. The live site updates within a minute or two. Installed apps pick up the new version the next time they are opened.
