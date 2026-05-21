from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import textwrap
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
APP_NAME = "PP Article Library"
REPO_NAME = "PP-Article-Library"


def run(cmd: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(
        cmd,
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else ""


def tracked_files() -> list[Path]:
    raw = run(["git", "ls-files", "-z"], capture=True)
    files: list[Path] = []
    for item in raw.split("\0"):
        if not item:
            continue
        path = Path(item)
        if path.parts and path.parts[0] in {"dist", "build"}:
            continue
        files.append(path)
    return files


def copy_public_tree(target: Path, platform: str) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for rel in tracked_files():
        if rel.parts and rel.parts[0] == "packaging":
            continue
        if platform == "macos" and rel.suffix.lower() in {".bat", ".cmd", ".command", ".sh"}:
            continue
        if platform == "windows" and rel.suffix.lower() in {".bat", ".cmd", ".command", ".sh"}:
            continue
        src = ROOT / rel
        dst = target / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def write_text(path: Path, content: str, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8", newline="\n")
    if executable:
        mode = path.stat().st_mode
        path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def build_macos_app(package_dir: Path) -> None:
    app_dir = package_dir / f"{APP_NAME}.app"
    contents = app_dir / "Contents"
    macos = contents / "MacOS"
    resources = contents / "Resources"
    macos.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)

    write_text(
        contents / "Info.plist",
        f"""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
          "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleName</key>
          <string>{APP_NAME}</string>
          <key>CFBundleDisplayName</key>
          <string>{APP_NAME}</string>
          <key>CFBundleIdentifier</key>
          <string>io.github.myppqk88.pp-article-library</string>
          <key>CFBundleVersion</key>
          <string>0.2.0</string>
          <key>CFBundleShortVersionString</key>
          <string>0.2.0</string>
          <key>CFBundleExecutable</key>
          <string>{APP_NAME}</string>
          <key>CFBundlePackageType</key>
          <string>APPL</string>
          <key>LSMinimumSystemVersion</key>
          <string>11.0</string>
          <key>NSHighResolutionCapable</key>
          <true/>
        </dict>
        </plist>
        """,
    )

    write_text(
        macos / APP_NAME,
        r'''
        #!/bin/zsh
        set -u
        unsetopt BG_NICE 2>/dev/null || true

        BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
        PROJECT_ROOT="$(cd "$BIN_DIR/../../.." && pwd)"
        cd "$PROJECT_ROOT" || exit 1

        LOG_DIR="$PROJECT_ROOT/.local/logs"
        mkdir -p "$LOG_DIR"
        LOG_FILE="$LOG_DIR/pp-article-library-$(date +%Y%m%d-%H%M%S).log"
        ln -sf "$LOG_FILE" "$LOG_DIR/latest.log"

        dialog() {
          /usr/bin/osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"PP Article Library\"" >/dev/null 2>&1 || true
        }

        notify() {
          /usr/bin/osascript -e "display notification \"$1\" with title \"PP Article Library\"" >/dev/null 2>&1 || true
        }

        find_python() {
          for py in \
            /opt/homebrew/bin/python3 \
            /usr/local/bin/python3 \
            /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
            python3
          do
            if command -v "$py" >/dev/null 2>&1; then
              command -v "$py"
              return 0
            fi
          done
          local framework_py
          framework_py="$(ls -1 /Library/Frameworks/Python.framework/Versions/*/bin/python3 2>/dev/null | tail -n 1)"
          if [ -n "$framework_py" ] && [ -x "$framework_py" ]; then
            echo "$framework_py"
            return 0
          fi
          return 1
        }

        PYTHON_BIN="$(find_python || true)"
        if [ -z "$PYTHON_BIN" ]; then
          dialog "没有找到 Python 3。请先安装 Python 3.10+，然后重新打开 PP Article Library。"
          /usr/bin/open "https://www.python.org/downloads/macos/"
          exit 1
        fi

        notify "正在启动。首次运行会自动安装依赖，可能需要几分钟。"
        {
          echo "[$(date)] Launching PP Article Library"
          echo "Project root: $PROJECT_ROOT"
          echo "Python: $PYTHON_BIN"
          "$PYTHON_BIN" scripts/check_deps.py
          deps_status=$?
          if [ "$deps_status" -ne 0 ]; then
            echo "Dependency check failed: $deps_status"
            exit "$deps_status"
          fi

          "$PYTHON_BIN" scripts/server.py --no-browser &
          SERVER_PID=$!
          URL="http://127.0.0.1:8765"
          for i in {1..80}; do
            if /usr/bin/curl -fsS "$URL/api/config" >/dev/null 2>&1; then
              /usr/bin/open "$URL" >/dev/null 2>&1 || true
              break
            fi
            if ! /bin/kill -0 "$SERVER_PID" >/dev/null 2>&1; then
              wait "$SERVER_PID"
              exit $?
            fi
            sleep 0.25
          done
          wait "$SERVER_PID"
        } >>"$LOG_FILE" 2>&1

        exit_status=$?
        if [ "$exit_status" -ne 0 ]; then
          dialog "启动失败。日志位置：$LOG_FILE"
          /usr/bin/open -R "$LOG_FILE" >/dev/null 2>&1 || true
        fi
        exit "$exit_status"
        ''',
        executable=True,
    )


def write_package_notes(package_dir: Path, platform: str) -> None:
    if platform == "macos":
        body = """
        PP Article Library v0.2.0 macOS

        1. 解压这个文件夹。
        2. 双击 PP Article Library.app。
        3. 如果 macOS 提示无法验证开发者：
           - 点“完成”，不要点“移到废纸篓”。
           - 右键 / 双指点按 PP Article Library.app。
           - 选择“打开”。
           - 之后浏览器会自动打开本地工作台。

        说明：
        - 这个版本没有 Apple 付费签名，所以第一次打开仍可能有安全提示。
        - 所有 PDF、笔记、API key 都保存在本文件夹内，不会上传到 GitHub。
        - 如果启动失败，请查看 .local/logs/latest.log。
        """
    else:
        body = """
        PP Article Library v0.2.0 Windows

        1. 解压这个文件夹。
        2. 双击 Start PP Article Library.bat。
        3. 首次运行会自动检测 Python 和安装依赖。
        4. 浏览器会自动打开本地工作台。

        说明：
        - 如果提示找不到 Python，请先安装 Python 3.10+，安装时勾选 Add Python to PATH。
        - 所有 PDF、笔记、API key 都保存在本文件夹内，不会上传到 GitHub。
        """
    write_text(package_dir / "START_HERE.txt", body)


def build_windows_launcher(package_dir: Path) -> None:
    write_text(
        package_dir / "Start PP Article Library.bat",
        r'''
        @echo off
        chcp 65001 >nul
        cd /d "%~dp0"

        set "PYEXE="

        for /f "delims=" %%X in ('where python 2^>nul') do (
            if not defined PYEXE set "PYEXE=%%X"
        )
        if defined PYEXE (
            if /i "%PYEXE:WindowsApps=%" neq "%PYEXE%" set "PYEXE="
        )
        if defined PYEXE goto :found

        for /f "delims=" %%X in ('where py 2^>nul') do (
            if not defined PYEXE set "PYEXE=%%X"
        )
        if defined PYEXE goto :found

        set "TRY=D:\Anaconda\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=C:\Anaconda3\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=%USERPROFILE%\anaconda3\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
        set "TRY=%USERPROFILE%\miniconda3\python.exe"
        if exist "%TRY%" set "PYEXE=%TRY%" & goto :found

        echo.
        echo [Startup Failed] Python not found. Install Python 3.10+ and retry:
        echo   https://www.python.org/downloads/  (check "Add Python to PATH")
        echo.
        pause
        exit /b 1

        :found
        echo [Python] %PYEXE%

        "%PYEXE%" scripts\check_deps.py
        if errorlevel 1 (
            echo.
            echo [Startup Failed] Dependencies not ready. See above for details.
            pause
            exit /b 1
        )

        "%PYEXE%" scripts\server.py
        pause
        ''',
    )


def zip_dir(source_dir: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(source_dir.rglob("*")):
            rel = path.relative_to(source_dir.parent)
            info = zipfile.ZipInfo.from_file(path, rel.as_posix())
            if path.is_dir():
                info.filename = info.filename.rstrip("/") + "/"
                zf.writestr(info, b"")
                continue
            mode = path.stat().st_mode
            info.external_attr = (mode & 0xFFFF) << 16
            with path.open("rb") as f:
                zf.writestr(info, f.read(), compress_type=zipfile.ZIP_DEFLATED)


def build(version: str) -> None:
    DIST.mkdir(exist_ok=True)
    mac_dir = DIST / f"{REPO_NAME}-{version}-macOS"
    win_dir = DIST / f"{REPO_NAME}-{version}-Windows"
    for path in (mac_dir, win_dir):
        if path.exists():
            shutil.rmtree(path)

    copy_public_tree(mac_dir, "macos")
    build_macos_app(mac_dir)
    write_package_notes(mac_dir, "macos")

    copy_public_tree(win_dir, "windows")
    build_windows_launcher(win_dir)
    write_package_notes(win_dir, "windows")

    zip_dir(mac_dir, DIST / f"{REPO_NAME}-{version}-macOS.zip")
    zip_dir(win_dir, DIST / f"{REPO_NAME}-{version}-Windows.zip")

    print("Built release assets:")
    print(f"  {DIST / f'{REPO_NAME}-{version}-macOS.zip'}")
    print(f"  {DIST / f'{REPO_NAME}-{version}-Windows.zip'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build PP Article Library release ZIPs.")
    parser.add_argument("--version", default="v0.2.0")
    args = parser.parse_args()
    build(args.version)


if __name__ == "__main__":
    main()
