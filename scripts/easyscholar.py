"""EasyScholar journal-rank lookup.

The user wires up an EasyScholar secret key (https://www.easyscholar.cc/).
Given a journal name we ask the public ranking endpoint and translate the
response into the workbench's row-update format (SCI / SSCI / 期刊分区 /
我的备注 etc.).

EasyScholar's free tier is rate-limited (≈ 1 request per second, daily quota
per key), so every successful response is cached on disk under
`library/cache/easyscholar/<normalized_name>.json`. Subsequent lookups of
the same journal return the cached payload — they never hit the network
unless the cache file is removed.

The module exposes two layers:
  - `lookup(name, secret_key)`: raw EasyScholar JSON dict (cached).
  - `derive_updates(name, secret_key)`: a `{field: value}` dict ready to
    merge into a workbench paper row, plus a human-readable summary.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from common import ROOT


CACHE_DIR = ROOT / "library" / "cache" / "easyscholar"
# Correct public-API path is /open/getPublicationRank — the earlier
# /openApi/... guess silently served the EasyScholar homepage HTML.
ENDPOINT = "https://www.easyscholar.cc/open/getPublicationRank"
# Be friendly to the free tier: never fire faster than one req every 1.2s.
_MIN_INTERVAL_SECONDS = 1.2
_last_call_at = 0.0


class EasyScholarError(RuntimeError):
    """Raised for any user-visible failure during lookup."""


def _normalize_key(name: str) -> str:
    text = (name or "").lower()
    text = re.sub(r"[^a-z0-9一-鿿]+", "_", text)
    return text.strip("_") or "unknown"


def _cache_path(name: str) -> Path:
    return CACHE_DIR / f"{_normalize_key(name)}.json"


def load_cached(name: str) -> dict[str, Any] | None:
    path = _cache_path(name)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _save_cache(name: str, payload: dict[str, Any]) -> None:
    from common import atomic_write_text
    atomic_write_text(
        _cache_path(name),
        json.dumps(payload, ensure_ascii=False, indent=2),
    )


def _wait_rate_limit() -> None:
    global _last_call_at
    now = time.monotonic()
    elapsed = now - _last_call_at
    if elapsed < _MIN_INTERVAL_SECONDS:
        time.sleep(_MIN_INTERVAL_SECONDS - elapsed)
    _last_call_at = time.monotonic()


def lookup(
    name: str,
    secret_key: str,
    *,
    force_refresh: bool = False,
    timeout: int = 20,
) -> dict[str, Any]:
    """Return the EasyScholar payload for a journal name (cached on disk).

    Raises EasyScholarError on missing key / HTTP failure / non-200 code /
    empty payload.
    """
    name = (name or "").strip()
    if not name:
        raise EasyScholarError("期刊名为空")
    secret_key = (secret_key or "").strip()
    if not secret_key:
        raise EasyScholarError("尚未配置 EasyScholar secretKey")

    if not force_refresh:
        cached = load_cached(name)
        if cached is not None:
            return cached

    import requests  # lazy import — requests lives in .deps_*

    _wait_rate_limit()
    try:
        response = requests.get(
            ENDPOINT,
            params={"secretKey": secret_key, "publicationName": name},
            timeout=timeout,
            headers={"Accept": "application/json"},
        )
    except requests.RequestException as exc:
        raise EasyScholarError(f"网络错误：{exc} (URL={ENDPOINT})") from exc

    if response.status_code >= 400:
        raise EasyScholarError(
            f"EasyScholar HTTP {response.status_code} @ {response.url}: {response.text[:200]}"
        )
    try:
        data = response.json()
    except ValueError as exc:
        # 当 URL 错误或服务异常时，EasyScholar 会回首页 HTML。
        snippet = response.text[:160].replace("\n", " ")
        raise EasyScholarError(
            f"返回非 JSON @ {response.url} (HTTP {response.status_code}): {snippet}"
        ) from exc

    code = data.get("code")
    # EasyScholar 在不同接口下返回 int 200 或字符串 "200"。
    if str(code) != "200":
        raise EasyScholarError(
            f"EasyScholar code={code} msg={data.get('msg', '')} @ {response.url}"
        )

    payload = data.get("data") or {}
    if not payload:
        raise EasyScholarError("EasyScholar 未返回任何分区信息（可能不在库中）")

    _save_cache(name, payload)
    return payload


# ---------------------------------------------------------------------------
# Mapping EasyScholar → workbench row fields
# ---------------------------------------------------------------------------


# 字段中文名映射。key 是 EasyScholar 返回的 officialRank.* 字段名（或
# 这个项目里的别名），value 是写到 `期刊等级_自动` 字符串里的中文标签。
FIELD_LABELS: dict[str, str] = {
    "sciUp": "中科院(升级)",
    "sci": "中科院",
    "sciif": "IF",
    "ssci": "SSCI",
    "ahci": "AHCI",
    "eii": "EI",       # 用户拼写；下面 _collect_official 同时兼容 'ei'
    "esi": "ESI",
    "ccf": "CCF",
    "fms": "FMS",
    "utd24": "UTD24",
    "ajg": "AJG",      # AJG / ABS Academic Journal Guide
    "abs": "ABS",
    "cssci": "CSSCI",
    "cscd": "CSCD",
    "pku": "北大核心",
}

# 用户启用的字段 key → EasyScholar 实际可能用的别名（按序尝试）
FIELD_ALIASES: dict[str, list[str]] = {
    "eii": ["eii", "ei"],
}

# 用户在 settings 里可勾选的字段（按用户原话顺序）
DEFAULT_ENABLED_FIELDS: list[str] = [
    "sciUp",
    "sci",
    "ssci",
    "ahci",
    "eii",
    "esi",
    "fms",
    "utd24",
    "ajg",
    "cssci",
]


def _collect_official(payload: dict[str, Any]) -> dict[str, Any]:
    """Flatten officialRank.all + officialRank.select into one dict."""
    official = payload.get("officialRank") or {}
    merged: dict[str, Any] = {}
    for bucket in (official.get("all") or {}, official.get("select") or {}):
        if isinstance(bucket, dict):
            for k, v in bucket.items():
                if v not in (None, "", []):
                    merged[k] = v
    return merged


def _format_field(label: str, value: Any) -> str:
    """Turn (label, value) → 一个 chip 字符串。

    规则：
    - 值为空 → 返回空串
    - 值看起来是 "是 / yes / Y / true / 1" → 只显示 label（说明被收录）
    - 否则 → 直接拼接 "label+value"，不加冒号（"中科院1区"、"SSCI1区"）
    """
    text = str(value or "").strip()
    if not text:
        return ""
    if text.lower() in {"y", "yes", "true", "1", "是"}:
        return label
    return f"{label}{text}"


def derive_updates(
    name: str,
    secret_key: str,
    *,
    force_refresh: bool = False,
    enabled_fields: list[str] | None = None,
) -> dict[str, Any]:
    """Return {ok, summary, level_text, raw, source}.

    `level_text` 是要写到 `期刊等级_自动` 的字符串，形如
    `中科院(升级):1区；SSCI；FMS:A`。caller 负责把它合并进 row。
    """
    payload = lookup(name, secret_key, force_refresh=force_refresh)
    official = _collect_official(payload)

    fields_to_use = list(enabled_fields or DEFAULT_ENABLED_FIELDS)

    chips: list[str] = []
    seen_labels: set[str] = set()
    for key in fields_to_use:
        label = FIELD_LABELS.get(key)
        if not label or label in seen_labels:
            continue
        # 按别名顺序查值；任意命中即用之
        value = None
        for alias in FIELD_ALIASES.get(key, [key]):
            v = official.get(alias)
            if v not in (None, "", []):
                value = v
                break
        chip = _format_field(label, value)
        if not chip:
            continue
        seen_labels.add(label)
        chips.append(chip)

    level_text = "；".join(chips)
    summary = level_text or "EasyScholar 在所选字段下未返回任何分区信息"

    return {
        "ok": True,
        "summary": summary,
        "level_text": level_text,
        "raw": payload,
        "source": "easyscholar",
    }


def clear_cache(name: str | None = None) -> int:
    """Delete cache. If name given, only that one; else all. Returns count."""
    if not CACHE_DIR.exists():
        return 0
    deleted = 0
    if name:
        path = _cache_path(name)
        if path.exists():
            path.unlink()
            deleted += 1
    else:
        for path in CACHE_DIR.glob("*.json"):
            path.unlink()
            deleted += 1
    return deleted
