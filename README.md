# Animal Liberation Songbook

Source for the songbook site, built with [MkDocs](https://www.mkdocs.org/) and the Material theme and published
with GitHub Pages.

## Layout

- `docs/` – one Markdown page per song, grouped into `originals/`, `rewrites/`, `other-movements/`, `commercial-artists/`.
  The old Drive "Handouts" folder (event compilations) is archived but not published.
  Sheet music PDFs and recordings live in `docs/files/`.
- `archive/drive-export/` – the original Google Drive files exactly as exported at migration time (Sept 2026).
- `migration/` – the scripts that crawled the public Drive folder and generated `docs/`. They are kept for provenance
  and are not needed for day-to-day edits.

## Editing

Edit or add a Markdown file under `docs/` and add it to the `nav` section of `mkdocs.yml`. Chord charts go inside
a `<pre class="chords">` block so the spacing survives. Pushing to `main` rebuilds and publishes the site.

To preview locally:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/mkdocs serve
```

## License

Songs are licensed CC BY-NC-SA 4.0 unless a page says otherwise.
