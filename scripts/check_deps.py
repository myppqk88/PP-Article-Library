"""First-run dependency check.

Called from `打开文献工作台.bat` / `.command` before server.py. It checks the
packages required to start and use the workbench. If anything essential is
missing, it installs those packages into either the active virtual environment
or a project-local `.deps*` directory, then re-checks. Optional OCR engines are
reported only in `--strict` mode so they do not block normal startup.

Designed to be fast (~50ms on warm cache) so it's cheap to run on every
launch — that way users don't need to remember to re-pip-install after
a `git pull` that adds a new dep.

Usage:
    python scripts/check_deps.py            # check + auto-install if missing
    python scripts/check_deps.py --strict   # also probe optional OCR engines
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

# Force UTF-8 on Windows console so we can print Chinese + symbols without
# crashing on the default GBK codec. Harmless on Mac/Linux.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent


def _deps_for_platform(create: bool = False) -> Path | None:
    """Return the local dependency dir used by scripts/common.py.

    Homebrew Python on macOS is an externally managed environment, so plain
    `pip install` can fail even when the user owns this project directory.
    Installing into the project-local deps directory keeps the launcher
    self-contained and avoids touching the system Python.
    """
    if sys.platform == "darwin":
        candidates = [ROOT / ".deps_macos", ROOT / ".deps"]
        fallback = ROOT / ".deps_macos"
    elif sys.platform == "win32":
        candidates = [ROOT / ".deps_windows"]
        fallback = ROOT / ".deps_windows"
    else:
        candidates = [ROOT / ".deps_linux"]
        fallback = ROOT / ".deps_linux"

    for candidate in candidates:
        if candidate.exists():
            return candidate
    return fallback if create else None


LOCAL_DEPS = _deps_for_platform()
if LOCAL_DEPS is not None:
    sys.path.insert(0, str(LOCAL_DEPS))

# Map import-name → human-readable description.
# Keep this in sync with requirements.txt.
REQUIRED = {
    "yaml":     "PyYAML (settings.yaml 解析)",
    "requests": "requests (HTTP 客户端)",
    "openpyxl": "openpyxl (papers.xlsx / list.xlsx 读写)",
    "fitz":     "PyMuPDF (PDF 文本抽取 + 高亮)",
    "pypdf":    "pypdf (兼容性 PDF 抽取)",
}

OPTIONAL = {
    "rapidocr_onnxruntime": "rapidocr-onnxruntime (扫描件 OCR)",
    "PIL":      "Pillow (OCR 图像处理)",
    "easyocr":  "easyocr (备选 OCR 引擎，较重)",
}

REQUIRED_PACKAGES = [
    "PyYAML>=6.0",
    "requests>=2.31",
    "openpyxl>=3.1",
    "PyMuPDF>=1.24",
    "pypdf>=4.0",
]


def _missing(modules: dict[str, str]) -> list[tuple[str, str]]:
    missing = []
    for mod, desc in modules.items():
        if importlib.util.find_spec(mod) is None:
            missing.append((mod, desc))
    return missing


def _running_in_venv() -> bool:
    return (
        getattr(sys, "base_prefix", sys.prefix) != sys.prefix
        or hasattr(sys, "real_prefix")
    )


def _install_required() -> int:
    if _running_in_venv():
        cmd = [sys.executable, "-m", "pip", "install", *REQUIRED_PACKAGES]
        install_note = "安装到当前虚拟环境"
    else:
        deps_dir = _deps_for_platform(create=True)
        assert deps_dir is not None
        deps_dir.mkdir(parents=True, exist_ok=True)
        if str(deps_dir) not in sys.path:
            sys.path.insert(0, str(deps_dir))
        cmd = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--target",
            str(deps_dir),
            *REQUIRED_PACKAGES,
        ]
        install_note = f"安装到项目本地依赖目录：{deps_dir.relative_to(ROOT)}"

    print(f"[deps] {install_note}")
    print(f"$ {' '.join(cmd)}")
    print()
    try:
        result = subprocess.run(cmd, cwd=str(ROOT), check=False)
    except Exception as exc:
        print(f"[deps] ✗ 调用 pip 失败：{exc}")
        return 1
    importlib.invalidate_caches()
    return result.returncode


def main() -> int:
    strict = "--strict" in sys.argv

    missing = _missing(REQUIRED)
    if not missing:
        if strict:
            opt_missing = _missing(OPTIONAL)
            if opt_missing:
                print("[deps] 可选依赖未装：")
                for mod, desc in opt_missing:
                    print(f"    · {mod}  ({desc})  — 不影响主流程")
        # All required deps present — silent success
        return 0

    print("=" * 60)
    print("首次运行 / git pull 后检测到缺失依赖，正在自动安装：")
    for mod, desc in missing:
        print(f"  · {mod}  ({desc})")
    print("=" * 60)
    print("说明：通常只有第一次会慢一些，主要时间花在下载 / 安装 PyMuPDF 等 PDF 处理包。")
    print("这些包会装进项目本地 .deps* 目录，不会修改系统 Python。")
    print()

    result_code = _install_required()

    if result_code != 0:
        print()
        print("[deps] [X] pip install 失败（exit code", result_code, "）")
        print("    常见原因：")
        print("      1. 没联网 — 接上网络后重新打开工作台")
        print("      2. Python / pip 安装不完整 — 重新安装 Python 后再试")
        print("      3. Python 版本太老 — 需要 3.9+；当前", sys.version.split()[0])
        print("      4. 某个包没有匹配当前 Python 版本的 wheel — 比如很新的 Python 上有些包还没发布，")
        print("         可以手动跑 pip install <name> 看具体报错，或者降 requirements.txt 里的版本下限")
        return result_code

    # Re-check after install
    still_missing = _missing(REQUIRED)
    if still_missing:
        print()
        print("[deps] [!] pip 跑完了但仍有依赖找不到：")
        for mod, desc in still_missing:
            print(f"    · {mod}  ({desc})")
        print("    可能是装到了别的 Python 环境。当前解释器：", sys.executable)
        return 1

    print()
    print("[deps] [OK] 全部依赖装好了，继续启动…")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
