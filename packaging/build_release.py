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


def version_number(version: str) -> str:
    return version[1:] if version.startswith("v") else version


def ad_hoc_sign_macos_app(app_dir: Path) -> None:
    codesign = shutil.which("codesign")
    if not codesign:
        print("Warning: codesign not found; macOS app will remain unsigned.")
        return
    try:
        subprocess.run(
            [codesign, "--force", "--deep", "--sign", "-", str(app_dir)],
            cwd=ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        print("Warning: ad-hoc codesign failed; continuing without a signature.")
        if exc.stderr:
            print(exc.stderr.strip())


def build_macos_app(package_dir: Path, version: str) -> None:
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
          <string>{version_number(version)}</string>
          <key>CFBundleShortVersionString</key>
          <string>{version_number(version)}</string>
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

        BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
        LAUNCHER="$BIN_DIR/../Resources/launch_in_terminal.command"

        if [ ! -x "$LAUNCHER" ]; then
          /usr/bin/osascript -e 'display dialog "启动文件缺失，请重新下载 macOS 版本。" buttons {"OK"} default button "OK" with title "PP Article Library"' >/dev/null 2>&1 || true
          exit 1
        fi

        /usr/bin/open -a Terminal "$LAUNCHER"
        ''',
        executable=True,
    )

    write_text(
        resources / "launch_in_terminal.command",
        r'''
        #!/bin/zsh
        set -u
        unsetopt BG_NICE 2>/dev/null || true
        setopt NO_BG_NICE 2>/dev/null || true

        BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
        PROJECT_ROOT="$(cd "$BIN_DIR/../../.." && pwd)"
        cd "$PROJECT_ROOT" || exit 1

        LOG_DIR="$PROJECT_ROOT/.local/logs"
        mkdir -p "$LOG_DIR"
        LOG_FILE="$LOG_DIR/pp-article-library-$(date +%Y%m%d-%H%M%S).log"
        ln -sf "$LOG_FILE" "$LOG_DIR/latest.log"

        exec > >(/usr/bin/tee -a "$LOG_FILE") 2>&1

        clear
        echo "============================================================"
        echo "PP Article Library"
        echo "============================================================"
        echo
        echo "这个窗口显示启动进度。工作台运行期间请不要关闭它。"
        echo "日志也会保存到：$LOG_FILE"
        echo

        dialog() {
          /usr/bin/osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"PP Article Library\"" >/dev/null 2>&1 || true
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

        pause_on_error() {
          echo
          echo "启动失败。请把上面的报错或日志文件发给维护者。"
          echo "按任意键关闭这个窗口。"
          read -k 1 _unused_key 2>/dev/null || true
        }

        echo "[1/4] 正在查找 Python 3..."
        PYTHON_BIN="$(find_python || true)"
        if [ -z "$PYTHON_BIN" ]; then
          echo
          echo "[错误] 没有找到 Python 3。请先安装 Python 3.10+，然后重新打开。"
          /usr/bin/open "https://www.python.org/downloads/macos/" >/dev/null 2>&1 || true
          dialog "没有找到 Python 3。请先安装 Python 3.10+，然后重新打开 PP Article Library。"
          pause_on_error
          exit 1
        fi
        echo "找到 Python：$PYTHON_BIN"
        echo

        echo "[2/4] 正在检查必需依赖..."
        echo "首次运行可能会下载并安装 PyYAML、requests、openpyxl、PyMuPDF、pypdf。"
        echo "这些会安装到本文件夹的 .deps_macos，不会改你的系统 Python。"
        echo
        "$PYTHON_BIN" scripts/check_deps.py
        deps_status=$?
        if [ "$deps_status" -ne 0 ]; then
          echo
          echo "[错误] 依赖安装失败，退出码：$deps_status"
          pause_on_error
          exit "$deps_status"
        fi
        echo

        URL="http://127.0.0.1:8765"
        if /usr/bin/curl -fsS "$URL/api/config" >/dev/null 2>&1; then
          echo "[3/4] 检测到工作台已经在运行。"
          /usr/bin/open "$URL" >/dev/null 2>&1 || true
          echo "[4/4] 浏览器已打开。可以关闭这个重复启动窗口。"
          sleep 3
          exit 0
        fi

        echo "[3/4] 正在启动本地服务..."
        echo "[4/4] 服务启动后会自动打开浏览器。"
        echo
        echo "工作台运行期间请保留这个窗口；关闭窗口会停止本地服务。"
        echo
        exec "$PYTHON_BIN" scripts/server.py
        ''',
        executable=True,
    )
    ad_hoc_sign_macos_app(app_dir)


def write_package_notes(package_dir: Path, platform: str, version: str) -> None:
    if platform == "macos":
        body = f"""
        PP Article Library {version} macOS

        1. 解压这个文件夹。
        2. 双击 PP Article Library.app。
        3. App 会打开一个“终端 / Terminal”进度窗口：
           - 首次运行会在这里显示依赖安装进度。
           - 看到浏览器打开后，不要关闭这个窗口；关闭窗口会停止本地服务。
        4. 如果 macOS 提示“无法验证”并且不给“打开”按钮：
           - 点“完成”，不要点“移到废纸篓”。
           - 打开“终端 / Terminal”。
           - 输入下面这句，末尾留一个空格：

             xattr -dr com.apple.quarantine

           - 把整个解压后的文件夹拖进终端窗口，按回车。
           - 再双击 PP Article Library.app。

        说明：
        - 这个版本没有 Apple Developer 付费公证，所以 macOS 可能拦截浏览器下载的 App。
        - 上面的命令只是在本机移除“来自互联网下载”的隔离标记。
        - 首次运行只自动安装必需依赖：PyYAML、requests、openpyxl、PyMuPDF、pypdf。
          扫描件 OCR 的 rapidocr / Pillow 不会默认安装，可在需要时再手动安装。
        - 所有 PDF、笔记、API key 都保存在本文件夹内，不会上传到 GitHub。
        - 如果启动失败，请查看 .local/logs/latest.log。
        """
        mac_first_run = f"""
        macOS 第一次打开如果被拦截

        这是免费未公证 App 的 macOS 安全提醒。它不代表 PP Article Library 会上传你的
        PDF、笔记或 API key。完全免提醒需要 Apple Developer 付费签名和公证。

        最短处理方式：

        1. 打开“终端 / Terminal”。
        2. 输入下面这句，末尾留一个空格：

           xattr -dr com.apple.quarantine

        3. 把整个 `{REPO_NAME}-{version}-macOS` 文件夹拖进终端窗口。
        4. 按回车。
        5. 再双击 `PP Article Library.app`。

        如果你把文件夹放在“下载”目录，通常也可以直接复制这一整句：

        xattr -dr com.apple.quarantine "$HOME/Downloads/{REPO_NAME}-{version}-macOS" && open "$HOME/Downloads/{REPO_NAME}-{version}-macOS/PP Article Library.app"
        """
        write_text(package_dir / "MAC_FIRST_RUN.txt", mac_first_run)
    else:
        body = f"""
        PP Article Library {version} Windows

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
    build_macos_app(mac_dir, version)
    write_package_notes(mac_dir, "macos", version)

    copy_public_tree(win_dir, "windows")
    build_windows_launcher(win_dir)
    write_package_notes(win_dir, "windows", version)

    zip_dir(mac_dir, DIST / f"{REPO_NAME}-{version}-macOS.zip")
    zip_dir(win_dir, DIST / f"{REPO_NAME}-{version}-Windows.zip")

    print("Built release assets:")
    print(f"  {DIST / f'{REPO_NAME}-{version}-macOS.zip'}")
    print(f"  {DIST / f'{REPO_NAME}-{version}-Windows.zip'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build PP Article Library release ZIPs.")
    parser.add_argument("--version", default="v0.2.5")
    args = parser.parse_args()
    build(args.version)


if __name__ == "__main__":
    main()
