from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import zipfile
from pathlib import Path

from common import ROOT, clean_piece, load_settings, project_path, read_csv, rel, unique_path


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def existing_hashes() -> set[str]:
    settings = load_settings()
    rows = read_csv(project_path(settings["index"]["csv"]))
    hashes = {row.get("文件哈希", "") for row in rows if row.get("文件哈希")}
    inbox = project_path(settings["paths"]["inbox"])
    if inbox.exists():
        for pdf in inbox.rglob("*"):
            if pdf.is_file() and pdf.suffix.lower() == ".pdf":
                try:
                    hashes.add(sha256_file(pdf))
                except OSError:
                    pass
    return hashes


def clean_pdf_name(name: str, fallback: str) -> str:
    raw = Path(name).name
    if not raw.lower().endswith(".pdf"):
        raw = f"{fallback}.pdf"
    stem = clean_piece(Path(raw).stem, 100)
    return f"{stem}.pdf"


def copy_pdf(path: Path, inbox: Path, seen: set[str]) -> tuple[str, str]:
    digest = sha256_file(path)
    if digest in seen:
        return "duplicate", ""
    seen.add(digest)
    target = unique_path(inbox / clean_pdf_name(path.name, path.stem))
    shutil.copy2(path, target)
    return "copied", rel(target)


def import_zip(path: Path, inbox: Path, seen: set[str]) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    try:
        with zipfile.ZipFile(path) as zf:
            pdf_infos = [
                info
                for info in zf.infolist()
                if not info.is_dir() and info.filename.lower().endswith(".pdf")
            ]
            for i, info in enumerate(pdf_infos, start=1):
                data = zf.read(info)
                digest = sha256_bytes(data)
                if digest in seen:
                    results.append(("duplicate", ""))
                    continue
                seen.add(digest)
                fallback = f"{path.stem}_{i}"
                target = unique_path(inbox / clean_pdf_name(info.filename, fallback))
                target.write_bytes(data)
                results.append(("extracted", rel(target)))
    except zipfile.BadZipFile:
        results.append(("bad_zip", rel(path)))
    except OSError:
        results.append(("error", rel(path)))
    return results


def iter_pdfs(source: Path) -> list[Path]:
    if not source.exists():
        return []
    if source.is_file() and source.suffix.lower() == ".pdf":
        return [source]
    return sorted([p for p in source.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf"])


def iter_zips(source: Path) -> list[Path]:
    if not source.exists():
        return []
    if source.is_file() and source.suffix.lower() == ".zip":
        return [source]
    return sorted([p for p in source.rglob("*") if p.is_file() and p.suffix.lower() == ".zip"])


def main() -> None:
    parser = argparse.ArgumentParser(description="把外部 PDF 和 zip 内 PDF 去重复制到 inbox。")
    parser.add_argument("--pdf-source", action="append", default=[], help="PDF 文件或文件夹来源。")
    parser.add_argument("--zip-source", action="append", default=[], help="zip 文件或文件夹来源。")
    args = parser.parse_args()

    settings = load_settings()
    inbox = project_path(settings["paths"]["inbox"])
    inbox.mkdir(parents=True, exist_ok=True)
    seen = existing_hashes()

    stats = {
        "pdf_sources": 0,
        "zip_sources": 0,
        "copied": 0,
        "extracted": 0,
        "duplicate": 0,
        "bad_zip": 0,
        "error": 0,
    }

    for raw in args.pdf_source:
        source = Path(raw).expanduser()
        if not source.is_absolute():
            source = ROOT / source
        for pdf in iter_pdfs(source):
            stats["pdf_sources"] += 1
            status, _ = copy_pdf(pdf, inbox, seen)
            stats[status] = stats.get(status, 0) + 1

    for raw in args.zip_source:
        source = Path(raw).expanduser()
        if not source.is_absolute():
            source = ROOT / source
        for zpath in iter_zips(source):
            stats["zip_sources"] += 1
            for status, _ in import_zip(zpath, inbox, seen):
                stats[status] = stats.get(status, 0) + 1

    print("导入到 inbox 完成：")
    for key in ["pdf_sources", "zip_sources", "copied", "extracted", "duplicate", "bad_zip", "error"]:
        print(f"{key}: {stats.get(key, 0)}")


if __name__ == "__main__":
    main()
