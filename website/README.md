# clawpatch Website

Static single-page site for the early `clawpatch` CLI.

Files:

- `index.html`: self-contained page
- `favicon.svg`: browser icon
- `social-card.svg`: link preview card
- `social-card.png`: raster link preview card for Open Graph/Twitter
- `robots.txt`: crawler policy with sitemap reference
- `sitemap.xml`: canonical single-page sitemap

Preview:

```bash
cd website
python3 -m http.server 8000
```

Keep copy aligned with the implemented CLI:

- provider: local Codex CLI, plus test mocks
- review: sequential feature review
- fix: `clawpatch fix --finding <id>`
- no auto-commit, PR creation, or landing yet
- no direct model API providers; coding harnesses only
