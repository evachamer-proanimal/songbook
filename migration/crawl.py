import re, json, sys, html, urllib.request, time
RK = "0-6oHaeJdMs5Te2c5uJYRfWQ"
ROOT = "0B659fY6sR4iHeVFoSXEwX1dHNlk"
UA = {"User-Agent": "Mozilla/5.0"}

def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")

def list_folder(fid):
    h = fetch(f"https://drive.google.com/drive/folders/{fid}?resourcekey={RK}")
    items = []
    seen = set()
    for m in re.finditer(r'aria-label="([^"]+?)" data-handled-by-drag-and-drop="true" ssk=\'5:[A-Za-z0-9]+:([0-9A-Za-z_-]{20,})', h):
        label = html.unescape(m.group(1)); iid = m.group(2)
        iid = re.sub(r'-0-16$', '', iid)
        if iid in seen: continue
        seen.add(iid)
        # split label into name + type suffix
        types = ["Shortcut to Shared folder","Shortcut to Google Docs","Shortcut to PDF","Shortcut to Audio","Shortcut to Microsoft Word",
                 "Shared folder","Google Docs","Google Sheets","Google Slides","Microsoft Word","PDF","Audio","Video","Image","Text"]
        kind = None
        for t in types:
            if label.endswith(" "+t):
                kind = t; name = label[:-len(t)-1]; break
        if kind is None:
            # generic: last words
            mm = re.match(r'^(.*) (Shortcut to .+|[A-Z][A-Za-z ]+)$', label)
            name, kind = (mm.group(1), mm.group(2)) if mm else (label, "Unknown")
        items.append({"id": iid, "name": name, "kind": kind})
    return items

def crawl(fid, path):
    out = []
    items = list_folder(fid)
    print(f"{'/'.join(path) or 'ROOT'}: {len(items)} items", file=sys.stderr)
    for it in items:
        it["path"] = path
        out.append(it)
        if it["kind"] == "Shared folder":
            time.sleep(0.5)
            out += crawl(it["id"], path + [it["name"]])
    return out

if __name__ == "__main__":
    tree = crawl(ROOT, [])
    json.dump(tree, open("tree.json","w"), indent=1, ensure_ascii=False)
    from collections import Counter
    print(Counter(i["kind"] for i in tree), file=sys.stderr)
    print(len(tree), "total", file=sys.stderr)
