# clawpatch Website

Static single-page site for the `clawpatch` CLI.

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

- providers: installed coding harnesses listed in [Providers](../docs/providers.md)
- review: bounded parallel feature reviews
- fix: `clawpatch fix --finding <id>`
- PR creation: explicit `clawpatch open-pr --patch <id>`; no automatic landing
- provider integrations use coding harnesses, which own model API access
