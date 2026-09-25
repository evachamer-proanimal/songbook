#!/usr/bin/env python3
"""Convert the Drive export in raw/ (described by tree_downloaded.json) into a MkDocs docs/ tree.

Run from the repo root:  .venv/bin/python migration/build_site.py
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
RAW = os.path.join(HERE, "raw")
DOCS = os.path.join(REPO, "docs")
FILES = os.path.join(DOCS, "files")
TREE = json.load(open(os.path.join(HERE, "tree_downloaded.json")))

SECTIONS = {
    # Drive top folder -> (docs subdir, nav title, title_from_drive_name)
    "Animal Liberation Originals": ("originals", "Animal Liberation Originals", False),
    "Rewrites": ("rewrites", "Rewrites", False),
    "Rewrites/Holiday Songs": ("rewrites/holiday-songs", "Holiday Songs", False),
    "Other Movements": ("other-movements", "Songs from Other Movements", False),
    "Handouts": ("handouts", "Handouts", True),
}

# Per-item fixes keyed by Drive item name.
OVERRIDES = {
    "Lyrics-Hallelujah Rewrite for ASM Vigils.docx": {
        "title": "Hallelujah Rewrite for ASM Vigils",
        "credits": ["Music: Leonard Cohen · Lyrics: Sarah Hewson"],
    },
    "Ceasefire Chorus_Lyrics & Recordings": {"title": "Ceasefire Chorus (Lyrics & Recordings)"},
    "Lyrics": {"title": "Lyrics Handout"},
}

# ---------------------------------------------------------------- helpers

def safe(name):
    return re.sub(r"[^\w\s.\-()&'’“”,!?]", "_", name).strip()


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[’'\"“”]", "", s)
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "untitled"


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


VARIANT_WORDS = {"chords", "chord", "lyrics", "lyric", "only", "letras"}
JOIN_WORDS = {"with", "and", "&", "-", "–", "w/"}
ATTACH_WORDS = {"sheet", "music", "harmony", "violin", "recording", "demo", "lyrics", "chords"}


def base_title(name, is_doc=True):
    """Drive item name -> (grouping base, variant kind)."""
    n = re.sub(r"\.(docx?|pdf|mp3)$", "", name, flags=re.I)
    n = re.sub(r"^\d+[\s.\-]+", "", n)  # leading numbers like "4 Hallelujah..."
    n = re.sub(r"^Lyrics-", "", n)
    n = re.sub(r"\s*[-–]\s*For DxE Songbook$", "", n, flags=re.I)
    lower = n.lower()
    if re.search(r"lyrics?\s*only|letras$|^lyrics-", lower) or name.lower().startswith("lyrics-"):
        kind = "lyrics"
    elif re.search(r"\bchords?\b", lower):
        kind = "chords"
    else:
        kind = "main"
    words = n.split()
    strip = VARIANT_WORDS | (ATTACH_WORDS if not is_doc else set())
    changed = True
    while words and changed:
        changed = False
        w = words[-1].lower().strip("()")
        if w in strip:
            words.pop(); changed = True
            while words and words[-1].lower() in JOIN_WORDS:
                words.pop()
        elif w in JOIN_WORDS and len(words) > 1:
            words.pop(); changed = True
    base = " ".join(words).strip(" -–:")
    return (base or n), kind


# ---------------------------------------------------------------- chord detection

CHORD_TOKEN = re.compile(
    r"""^(
        \(?N\.?C\.?\)? |
        \(?[A-G](\#|b|♭|♯)?(maj|min|m|M|sus|dim|aug|add|°|ø|\+)?\d{0,2}(sus\d|add\d|maj\d|[b\#]\d)?(/[A-G](\#|b)?)?\*?\)? |
        \(?x\s?\d+\)? | \d+x | \| | -+ | –|— | \.\.\. | / | riff | \(riff\) |
        (intro|outro|chorus|verse|bridge|capo|fret)\S*
    )$""",
    re.I | re.X,
)
STRUCT_RE = re.compile(r"^(intro|outro|chorus|verse|bridge|capo|fret)", re.I)


def unescape_md(s):
    return re.sub(r"\\([\\`*_{}\[\]()#+\-.!|>~])", r"\1", s)


def is_chord_line(line, lenient=False):
    t = unescape_md(line).strip()
    if not t:
        return False
    toks = t.split()
    real = [x for x in toks if not STRUCT_RE.match(x)]
    if not real:
        return False
    if not all(CHORD_TOKEN.match(x) for x in toks):
        return False
    # guard against a lone lyric word like "A" or "Am"
    if len(real) == 1 and len(real[0]) <= 2 and re.match(r"^[A-G]m?$", real[0]):
        return lenient or line.startswith((" ", "\t"))
    return True


def count_chord_lines(text):
    return sum(1 for l in text.splitlines() if is_chord_line(l))


# ---------------------------------------------------------------- source loading

def load_doc_markdown(path_md):
    return open(path_md, encoding="utf-8").read().replace("﻿", "")


def pandoc(path, to="gfm"):
    return subprocess.run(
        ["pandoc", path, "-f", "docx", "-t", to, "--wrap=none"], capture_output=True, text=True, check=True
    ).stdout


def has_table(md):
    return any(l.lstrip().startswith("|") for l in md.splitlines())


def load_word(path):
    """Word docs (not Docs exports): pandoc plain text; collapse the blank line after chord lines."""
    txt = pandoc(path, "plain")
    lines = txt.splitlines()
    lenient = count_chord_lines(txt) >= 2
    out, i = [], 0
    while i < len(lines):
        out.append(lines[i])
        if is_chord_line(lines[i], lenient) and i + 1 < len(lines) and not lines[i + 1].strip():
            i += 1  # drop the blank between chord line and its lyric
        i += 1
    return "\n".join(out)


def clean_gfm(md):
    # pandoc keeps Docs-internal bookmark links that have no target here
    md = re.sub(r"\[(<u>)?(.+?)(</u>)?\]\(#[a-z0-9]+\)", r"\2", md)
    return md


# ---------------------------------------------------------------- parsing a song doc

LINK_MD = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
URL_RE = re.compile(r"(?<![\(\"'>])(https?://[^\s\)\]>\"']+)")


def tidy_title(t):
    t = unescape_md(t)
    t = re.sub(r"^[\*_#\s]+|[\*_\s]+$", "", t).strip(" “”\"'")
    t = re.sub(r"\s{2,}", " ", t)
    if t.isupper() and len(t) > 3:
        t = t.title().replace("'S ", "'s ").replace("’S ", "’s ")
    return t


def parse_song(md, fallback_title):
    """Return dict(title, credits[], links[], body)."""
    lines = [l.rstrip() for l in md.strip("\n").splitlines()]
    hdr = []
    for l in lines:
        if not l.strip():
            break
        hdr.append(l)
    title, credits, links = None, [], []
    body_start = 0
    lenient = count_chord_lines(md) >= 2
    if hdr and len(hdr) <= 6 and not is_chord_line(hdr[0], lenient):
        cand = tidy_title(hdr[0])
        if "http" in cand or "[" in cand or len(cand) > 60:
            cand = None
        title = cand
        consumed = 1 if cand else 0
        for l in hdr[consumed:] if cand else []:
            s = l.strip()
            if is_chord_line(l, lenient):
                break
            m = LINK_MD.findall(s)
            u = URL_RE.findall(s)
            if m:
                links += [(t, url) for t, url in m]
                consumed += 1
            elif u:
                label = re.sub(URL_RE, "", s).strip(" :-–") or "Link"
                if label.lower() in ("link to recording", "recording", "recording link", "link"):
                    label = "Recording"
                links += [(label, url) for url in u]
                consumed += 1
            elif len(s) <= 90 and not re.search(r"[.!?]$", s.rstrip(")")) and len(credits) < 3:
                credits.append(unescape_md(re.sub(r"[\*_]", "", s)).strip())
                consumed += 1
            else:
                break
        body_start = consumed
    if not title:
        title = fallback_title
    body = "\n".join(lines[body_start:]).strip("\n")
    body = re.sub(r"^(link to recording|recording):?\s*$", "", body, flags=re.I | re.M)
    return {"title": title, "credits": credits, "links": links, "body": body}


# ---------------------------------------------------------------- rendering

def render_pre(block_lines):
    out = []
    for l in block_lines:
        l = unescape_md(l.rstrip()).expandtabs(8)
        l = html.escape(l, quote=False)
        l = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", l)
        l = LINK_MD.sub(lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', l)
        l = URL_RE.sub(lambda m: f'<a href="{m.group(1)}">{m.group(1)}</a>', l)
        out.append(l)
    return '<pre class="chords">' + "\n".join(out) + "</pre>\n"


def render_body(body):
    """Blocks with chord lines -> <pre>; the rest stays Markdown."""
    lenient = count_chord_lines(body) >= 2
    blocks, cur = [], []
    for l in body.splitlines():
        if l.strip():
            cur.append(l)
        elif cur:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)
    out = []
    for b in blocks:
        if any(is_chord_line(l, lenient) for l in b):
            out.append(render_pre(b))
        else:
            para = []
            for l in b:
                l = l.replace("\t", " ").rstrip()
                if not l.endswith("  ") and not l.lstrip().startswith(("|", "<", "#", "- ", "* ", "1.")):
                    l += "  "
                para.append(l)
            out.append("\n".join(para) + "\n")
    return "\n".join(out)


def render_page(title, credits, links, variants, attachments, sources):
    """variants: list of (label, rendered_body). attachments: list of (label, relpath)."""
    lines = [f"---\ntitle: \"{title.replace(chr(34), chr(39))}\"\n---\n", f"# {title}\n"]
    if credits:
        lines.append("*" + " · ".join(credits) + "*\n")
    if links:
        seen = set()
        for label, url in links:
            if url in seen:
                continue
            seen.add(url)
            lines.append(f"- [{label}]({url})")
        lines.append("")
    if len(variants) == 1:
        lines.append(variants[0][1])
    else:
        for label, rendered in variants:
            lines.append(f'=== "{label}"\n')
            lines.append("\n".join(("    " + l) if l.strip() else "" for l in rendered.splitlines()))
            lines.append("")
    if attachments:
        if variants:
            lines.append("\n## Files\n")
        for label, rel in attachments:
            lines.append(f"- [{label}]({rel})")
        lines.append("")
        for label, rel in attachments:
            if rel.lower().endswith(".pdf"):
                lines.append(
                    f'<object data="{rel}" type="application/pdf" width="100%" height="700">'
                    f'<p><a href="{rel}">{label}</a></p></object>\n'
                )
            elif rel.lower().endswith((".mp3", ".m4a", ".wav")):
                lines.append(f'<audio controls preload="none" src="{rel}"></audio>\n')
    lines.append("\n<!-- sources: " + "; ".join(sources) + " -->\n")
    return "\n".join(lines)


# ---------------------------------------------------------------- main

def main():
    if os.path.isdir(DOCS):
        for entry in os.listdir(DOCS):
            p = os.path.join(DOCS, entry)
            if entry in ("stylesheets", "CNAME"):
                continue
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(FILES, exist_ok=True)

    items = [i for i in TREE if i["kind"] != "Shared folder" and i.get("files") and not i.get("error")]
    skipped = []

    by_section = defaultdict(list)
    for it in items:
        p = it["path"]
        if not p and it["name"].startswith("How to"):
            continue  # README content is rewritten as index.md
        top = "/".join(p[:2]) if len(p) >= 2 and "/".join(p[:2]) in SECTIONS else p[0]
        if top not in SECTIONS:
            skipped.append((it["name"], "unknown folder " + "/".join(p)))
            continue
        rawdir = os.path.join(RAW, *[safe(x) for x in p])
        it["rawdir"] = rawdir
        f0 = os.path.join(rawdir, it["files"][0])
        with open(f0, "rb") as fh:
            head = fh.read(200)
        if b"<!doctype html" in head.lower() or b"<html" in head.lower():
            skipped.append((it["name"], "not publicly downloadable (Drive asks for sign-in)"))
            continue
        by_section[top].append(it)

    nav = [{"Home": "index.md"}]
    all_pages = []

    for top, (subdir, navtitle, title_from_name) in SECTIONS.items():
        sec_items = by_section.get(top, [])
        outdir = os.path.join(DOCS, subdir)
        os.makedirs(outdir, exist_ok=True)
        groups = defaultdict(lambda: {"docs": [], "attach": []})
        for it in sec_items:
            is_doc = it["kind"] in ("Google Docs", "Microsoft Word")
            b, kind = base_title(it["name"], is_doc)
            if is_doc:
                groups[norm(b)]["docs"].append((it, kind, b))
            else:
                groups[norm(b)]["attach"].append((it, b))
        # attachment-only groups: try to attach to a doc group by prefix
        for key in list(groups):
            g = groups[key]
            if g["docs"] or not g["attach"]:
                continue
            for it, b in list(g["attach"]):
                cands = [k for k, gg in groups.items() if gg["docs"] and k and (key.startswith(k) or k.startswith(key))]
                cands.sort(key=len, reverse=True)
                if cands:
                    groups[cands[0]]["attach"].append((it, b))
                    g["attach"].remove((it, b))
            if not g["attach"]:
                del groups[key]

        pages, used_titles = [], {}
        for key, g in groups.items():
            variants, credits, links, sources = [], [], [], []
            title = None
            drive_base = None
            docs_sorted = sorted(g["docs"], key=lambda d: {"main": 0, "chords": 1, "lyrics": 2}[d[1]])
            for it, kind, b in docs_sorted:
                drive_base = drive_base or b
                f = os.path.join(it["rawdir"], it["files"][0])
                ov = OVERRIDES.get(it["name"], {})
                if it["kind"] == "Google Docs":
                    md = load_doc_markdown(f)
                    if has_table(md) or title_from_name:
                        docx = os.path.join(it["rawdir"], it["files"][1])
                        body_md = clean_gfm(pandoc(docx, "gfm")) if has_table(md) else None
                        if body_md is None:
                            parsed = parse_song(md, b)
                            parsed["title"] = b
                            rendered = render_body(parsed["body"])
                        else:
                            parsed = {"title": b, "credits": [], "links": [], "body": body_md}
                            rendered = body_md + "\n"
                    else:
                        parsed = parse_song(md, b)
                        rendered = render_body(parsed["body"])
                    sources.append(f"gdoc:{it['id']}")
                else:
                    txt = load_word(f)
                    parsed = parse_song(txt, b)
                    rendered = render_body(parsed["body"])
                    sources.append(f"drive:{it['id']}")
                if "title" in ov:
                    parsed["title"] = ov["title"]
                if "credits" in ov:
                    parsed["credits"] = ov["credits"]
                if title is None and (kind == "main" or len(docs_sorted) == 1 or "title" in ov):
                    title = parsed["title"]
                for c in parsed["credits"]:
                    if c not in credits:
                        credits.append(c)
                for l in parsed["links"]:
                    if l not in links:
                        links.append(l)
                label = {"main": "Chords & lyrics" if count_chord_lines(parsed["body"]) else "Song",
                         "chords": "Chords", "lyrics": "Lyrics"}[kind]
                variants.append((label, rendered))
            title = title or drive_base
            # de-dupe variant labels
            counts, fixed = defaultdict(int), []
            for lab, r in variants:
                counts[lab] += 1
                fixed.append((lab if counts[lab] == 1 else f"{lab} ({counts[lab]})", r))
            variants = fixed
            attachments = []
            for it, b in g["attach"]:
                src = os.path.join(it["rawdir"], it["files"][0])
                fname = safe(it["name"])
                if not re.search(r"\.(pdf|mp3)$", fname, re.I):
                    fname += {"PDF": ".pdf", "Audio": ".mp3"}.get(it["kind"], "")
                dest_dir = os.path.join(FILES, subdir)
                os.makedirs(dest_dir, exist_ok=True)
                shutil.copy2(src, os.path.join(dest_dir, fname))
                depth = subdir.count("/") + 1
                rel = "../" * depth + f"files/{subdir}/{fname}".replace(" ", "%20")
                label = re.sub(r"\.(pdf|mp3)$", "", it["name"], flags=re.I)
                attachments.append((label, rel))
                sources.append(f"drive:{it['id']}")
                title = title or b
            title = title or key
            # same title twice in a section -> fall back to the Drive name for the second
            if norm(title) in used_titles and drive_base and norm(drive_base) != norm(title):
                title = drive_base
            elif norm(title) in used_titles:
                first = used_titles[norm(title)]
                title = f"{title} ({docs_sorted[0][0]['name'] if docs_sorted else 'alt'})"
            used_titles[norm(title)] = title
            slug = slugify(title)
            fn = slug + ".md"
            n = 2
            while os.path.exists(os.path.join(outdir, fn)):
                fn = f"{slug}-{n}.md"; n += 1
            with open(os.path.join(outdir, fn), "w", encoding="utf-8") as fh:
                fh.write(render_page(title, credits, links, variants, attachments, sources))
            pages.append((title, f"{subdir}/{fn}"))
        pages.sort(key=lambda p: norm(p[0]))
        all_pages += pages
        entry = [{t: p} for t, p in pages]
        if "/" in subdir:
            parent_title = SECTIONS[top.split("/")[0]][1]
            for navitem in nav:
                if parent_title in navitem:
                    navitem[parent_title].append({navtitle: entry})
        else:
            nav.append({navtitle: entry})

    with open(os.path.join(DOCS, "index.md"), "w", encoding="utf-8") as fh:
        fh.write(INDEX_MD.format(n=len(all_pages)))

    import yaml
    cfg = {
        "site_name": "Animal Liberation Songbook",
        "site_description": "Songs, chords, lyrics and sheet music for the animal rights movement.",
        "site_url": "https://evachamer-proanimal.github.io/songbook/",
        "repo_url": "https://github.com/evachamer-proanimal/songbook",
        "edit_uri": "edit/main/docs/",
        "theme": {
            "name": "material",
            "palette": [
                {"media": "(prefers-color-scheme: light)", "scheme": "default", "primary": "green", "accent": "green",
                 "toggle": {"icon": "material/brightness-7", "name": "Switch to dark mode"}},
                {"media": "(prefers-color-scheme: dark)", "scheme": "slate", "primary": "green", "accent": "green",
                 "toggle": {"icon": "material/brightness-4", "name": "Switch to light mode"}},
            ],
            "features": ["navigation.instant", "navigation.tracking", "navigation.top", "search.suggest",
                         "search.highlight", "content.tabs.link", "content.action.edit", "toc.integrate"],
            "icon": {"logo": "material/music-note"},
        },
        "extra_css": ["stylesheets/songbook.css"],
        "markdown_extensions": ["attr_list", "md_in_html", "tables",
                                {"pymdownx.tabbed": {"alternate_style": True}}, "pymdownx.superfences", "pymdownx.magiclink"],
        "plugins": ["search"],
        "nav": nav,
    }
    with open(os.path.join(REPO, "mkdocs.yml"), "w") as fh:
        yaml.safe_dump(cfg, fh, sort_keys=False, allow_unicode=True, width=200)

    os.makedirs(os.path.join(DOCS, "stylesheets"), exist_ok=True)
    with open(os.path.join(DOCS, "stylesheets", "songbook.css"), "w") as fh:
        fh.write(CSS)

    json.dump({"pages": all_pages, "skipped": skipped}, open(os.path.join(HERE, "build_report.json"), "w"),
              indent=1, ensure_ascii=False)
    print(f"{len(all_pages)} pages written; {len(skipped)} items skipped", file=sys.stderr)
    for s in skipped:
        print("  SKIPPED:", s, file=sys.stderr)


INDEX_MD = """---
title: Welcome
---

# Animal Liberation Songbook

A living collection of songs for the animal rights movement: originals, rewrites of familiar tunes,
and songs borrowed from other movements for justice. Use the search box or browse the sections in the sidebar.

Music has been used in many past social justice movements to build morale, clarify values, promote
solidarity and group identity, and to communicate messages to outsiders. This songbook exists to build
and support a comparable musical culture within the animal rights movement. All songs with a nonviolent
and antispeciesist message are welcome.

## Submissions

Please email comments, suggestions, and submissions. When submitting, include as much musical
information as you have: lyrics, chords, sheet music, and recordings.

*Submission address coming soon.*

## Collaboration

You are encouraged to contact songwriters for collaborative purposes. Ask via the submissions address for contact information.

## Copyright

All works are licensed under [Creative Commons BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
unless otherwise noted on the song's page. These works are free to use, distribute, and adapt with attribution
and without commercial gain.

*{n} songs and handouts in the collection.*
"""

CSS = """
pre.chords {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.82rem;
  line-height: 1.4;
  white-space: pre;
  overflow-x: auto;
  background: none;
  padding: 0;
  margin: 0 0 1.2em 0;
  color: var(--md-typeset-color);
}
pre.chords strong { color: var(--md-accent-fg-color); }
.md-typeset h1 + p em { color: var(--md-default-fg-color--light); }
.md-typeset table:not([class]) td p { margin: 0.2em 0; }
@media print {
  .md-header, .md-sidebar, .md-footer, .md-tabs { display: none !important; }
  pre.chords { font-size: 10pt; }
}
"""

if __name__ == "__main__":
    main()
