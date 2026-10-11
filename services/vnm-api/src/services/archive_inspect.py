"""Inspect outer archives before extraction; reject paths and links outside staging."""
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import zipfile

path, kind = sys.argv[1:3]
names = []
total = 0
limit = int(os.environ.get("MAX_EXTRACT_SIZE_MB", "262144")) * 1024 * 1024
file_limit = int(os.environ.get("MAX_IMPORT_FILES", "500000"))

def add(name, size=0, link=False):
    global total
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if not name:
        return
    if link or "\\" in name or re.search(r"[\x00-\x1f:]", name) or name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/")):
        raise ValueError("Archive contains an unsafe path or link: " + name)
    names.append(name)
    total += int(size)
    if total > limit or len(names) > file_limit:
        raise ValueError("Archive exceeds the configured extraction size/file limit")

if kind == "zip":
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            mode = entry.external_attr >> 16
            add(entry.filename, entry.file_size, stat.S_ISLNK(mode) or bool(entry.flag_bits & 1))
elif kind == "tar.bz2":
    with tarfile.open(path, "r:bz2") as archive:
        for entry in archive:
            add(entry.name, entry.size, not (entry.isdir() or entry.isfile()))
elif kind == "rar":
    output = subprocess.check_output(["7z", "l", "-slt", path], text=True)
    entries = output.split("----------", 1)[1]
    for block in re.split(r"\n\s*\n", entries):
        values = dict(line.split(" = ", 1) for line in block.splitlines() if " = " in line)
        if "Path" in values:
            attributes = values.get("Attributes", "")
            add(values["Path"], values.get("Size", 0), values.get("Encrypted") == "+" or "Symbolic Link" in values or "Hard Link" in values or "l" in attributes)
else:
    raise ValueError("Unsupported archive format")
if not names:
    raise ValueError("Archive is empty")
roots = {name.split("/")[0] for name in names}
single = next(iter(roots)) if len(roots) == 1 else None
if single and not any(name.startswith(single + "/") for name in names):
    single = None
print(json.dumps({"singleFolder": single, "files": len(names), "bytes": total}))
