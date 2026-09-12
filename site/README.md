# SFTPresso landing page

Source for https://jmwerk.github.io/SFTPresso/ — a static page styled as a VS Code workbench.

- `index.html` — the workbench shell plus every "file" the editor can open (as `<template>`s)
- `css/workbench.css` — Dark Modern / Light Modern palettes and layout
- `js/workbench.js` — tabs, hash routing, command palette, menus, terminal, and the demo simulations
- `assets/` — icon and showcase screenshot copied from `resources/` and `assets/showcase/`

No build step. Open `index.html` directly, or serve the folder with any static server.
Deployed by `.github/workflows/pages.yml` on every push to `develop` that touches `site/`.
