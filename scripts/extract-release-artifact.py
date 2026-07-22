#!/usr/bin/env python3
import hashlib
import io
import json
import os
import stat
import sys
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath


def fail(message: str) -> None:
    raise ValueError(message)


def main() -> None:
    if len(sys.argv) != 5:
        fail("usage: extract-release-artifact <plan.json> <artifact-index> <archive.zip> <destination>")
    plan_path, index_text, archive_path, destination_text = sys.argv[1:]
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    artifact = plan["artifacts"][int(index_text)]
    archive = Path(archive_path)
    destination = Path(destination_text)
    archive_bytes = archive.read_bytes()
    if len(archive_bytes) != artifact["size"]:
        fail("retained artifact ZIP size mismatch")
    if "sha256:" + hashlib.sha256(archive_bytes).hexdigest() != artifact["digest"]:
        fail("retained artifact ZIP service digest mismatch")
    prefix = artifact["directory"] + "/"
    expected = {
        item["path"][len(prefix):]: item
        for item in plan["inventory"]
        if item["path"].startswith(prefix)
    }
    if not expected:
        fail("artifact has no frozen inventory")
    destination.mkdir(parents=False, exist_ok=False)
    root = destination.resolve()
    seen = set()
    seen_casefold = set()
    seen_normalized = set()
    extracted = []
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as bundle:
        infos = bundle.infolist()
        if len(infos) > len(expected) + 8:
            fail("retained artifact ZIP has too many entries")
        for info in infos:
            name = info.filename
            normalized = unicodedata.normalize("NFC", name)
            if normalized != name:
                fail("retained artifact ZIP contains a non-NFC path")
            if "\\" in name or name.startswith("/") or "\x00" in name:
                fail("retained artifact ZIP contains an unsafe path")
            parts = PurePosixPath(name.rstrip("/")).parts
            if not parts or any(part in ("", ".", "..") for part in parts):
                fail("retained artifact ZIP contains traversal or an empty path component")
            key = name.rstrip("/")
            if key in seen or key.casefold() in seen_casefold or normalized.casefold() in seen_normalized:
                fail("retained artifact ZIP contains duplicate or colliding paths")
            seen.add(key)
            seen_casefold.add(key.casefold())
            seen_normalized.add(normalized.casefold())
            mode = (info.external_attr >> 16) & 0xFFFF
            if info.flag_bits & 1:
                fail("encrypted retained artifact entries are forbidden")
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                fail("unsupported retained artifact compression")
            if info.is_dir():
                if info.file_size != 0 or (mode and not stat.S_ISDIR(mode)):
                    fail("invalid retained artifact directory entry")
                allowed_directories = {str(PurePosixPath(path).parent) for path in expected if "/" in path}
                if key not in allowed_directories:
                    fail("unexpected retained artifact directory")
                continue
            if mode and not stat.S_ISREG(mode):
                fail("symlink or special retained artifact entry is forbidden")
            item = expected.get(name)
            if item is None:
                fail("unexpected retained artifact file")
            if info.file_size != item["bytes"]:
                fail("retained artifact uncompressed size mismatch")
            if info.file_size > 20_000_000 or info.file_size > max(1, info.compress_size) * 500:
                fail("retained artifact expansion bound exceeded")
            data = bundle.read(info)
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                fail("retained artifact file hash mismatch")
            target = destination.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if root not in target.resolve().parents:
                fail("retained artifact extraction escaped its destination")
            with target.open("xb") as output:
                output.write(data)
            extracted.append(name)
    if sorted(extracted) != sorted(expected):
        fail("retained artifact ZIP is incomplete")
    print(json.dumps(sorted(extracted)))


if __name__ == "__main__":
    main()
