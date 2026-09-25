import json, re, os, sys, time, html, urllib.request, urllib.error, subprocess
from crawl import fetch, list_folder  # reuse
RK = "0-6oHaeJdMs5Te2c5uJYRfWQ"
tree = json.load(open("tree.json"))

def resolve_shortcut(iid):
    req = urllib.request.Request(f"https://drive.google.com/file/d/{iid}/view", headers={"User-Agent":"Mozilla/5.0"}, method="HEAD")
    try:
        urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        pass
    # follow manually to capture final URL
    class NoRedir(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            raise urllib.error.HTTPError(newurl, code, "redir", hdrs, fp)
    op = urllib.request.build_opener(NoRedir)
    try:
        op.open(urllib.request.Request(f"https://drive.google.com/file/d/{iid}/view", headers={"User-Agent":"Mozilla/5.0"}), timeout=60)
    except urllib.error.HTTPError as e:
        m = re.search(r'/d/([A-Za-z0-9_-]{20,})', e.filename or "")
        return m.group(1) if m else None
    return None

# 1. resolve shortcuts, expand shortcut folders
expanded = []
for it in tree:
    if it["kind"].startswith("Shortcut to"):
        tgt = resolve_shortcut(it["id"])
        print("shortcut", it["name"], "->", tgt, file=sys.stderr)
        it["shortcut_id"] = it["id"]; it["id"] = tgt
        it["kind"] = it["kind"].replace("Shortcut to ", "")
        expanded.append(it)
        if it["kind"] == "Shared folder" and tgt:
            def crawl(fid, path):
                out=[]
                for c in list_folder(fid):
                    c["path"]=path; out.append(c)
                    if c["kind"]=="Shared folder": out += crawl(c["id"], path+[c["name"]])
                return out
            sub = crawl(tgt, it["path"]+[it["name"]])
            print("  expanded", len(sub), "items", file=sys.stderr)
            expanded += sub
    else:
        expanded.append(it)
tree = expanded
json.dump(tree, open("tree_resolved.json","w"), indent=1, ensure_ascii=False)

# 2. download
os.makedirs("raw", exist_ok=True)
def safe(name): return re.sub(r'[^\w\s.\-()&\'’“”,!?]', '_', name).strip()
def dl(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0: return "cached"
    cmd = ["curl", "-sL", "-A", "Mozilla/5.0", "-o", dest, url]
    subprocess.run(cmd, check=True)
    # detect drive virus-scan confirm HTML
    with open(dest, "rb") as f: head = f.read(2000)
    if b"<!DOCTYPE html" in head and b"drive.google.com" in head or b"Google Drive - Virus scan" in head:
        subprocess.run(["curl","-sL","-A","Mozilla/5.0","-o",dest, f"https://drive.usercontent.google.com/download?id={url.split('id=')[-1]}&export=download&confirm=t"], check=True)
    return os.path.getsize(dest)

log = []
for it in tree:
    if it["kind"] == "Shared folder" or not it.get("id"): continue
    d = os.path.join("raw", *[safe(p) for p in it["path"]]); os.makedirs(d, exist_ok=True)
    base = safe(it["name"])
    try:
        if it["kind"] == "Google Docs":
            r1 = dl(f"https://docs.google.com/document/d/{it['id']}/export?format=md", os.path.join(d, base + ".md"))
            r2 = dl(f"https://docs.google.com/document/d/{it['id']}/export?format=docx", os.path.join(d, base + ".docx"))
            it["files"] = [base+".md", base+".docx"]; res = (r1, r2)
        else:
            ext = {"PDF":".pdf","Audio":".mp3","Microsoft Word":".docx"}.get(it["kind"], "")
            fname = base if base.lower().endswith(ext) or not ext else base + ext
            res = dl(f"https://drive.google.com/uc?export=download&id={it['id']}", os.path.join(d, fname))
            it["files"] = [fname]
        print("ok", "/".join(it["path"]), it["name"], res, file=sys.stderr)
    except Exception as e:
        print("FAIL", it["name"], e, file=sys.stderr); it["error"] = str(e)
    time.sleep(0.3)
json.dump(tree, open("tree_downloaded.json","w"), indent=1, ensure_ascii=False)
