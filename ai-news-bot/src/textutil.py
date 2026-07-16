"""X（Twitter）のツイート長を扱うユーティリティ。

X の重み付き文字数（weighted length）の簡易実装:
- 日本語などの全角文字・絵文字は 2 としてカウント
- 半角英数字・記号は 1 としてカウント
- URL は実際の長さに関わらず一律 23 としてカウント（t.co 短縮のため）
- 上限は 280

正確な twitter-text 実装の近似だが、余裕（マージン）を持たせて運用する。
"""

from __future__ import annotations

import re

from .config import URL_WEIGHT

# URL は t.co 短縮により一律 URL_WEIGHT でカウントされる
_URL_RE = re.compile(r"https?://\S+")

# 全角として扱う Unicode 範囲（CJK・かな・全角記号・ハングルなど）
_WIDE_RANGES = (
    (0x1100, 0x115F),   # ハングル字母
    (0x2E80, 0x303E),   # CJK 部首・記号
    (0x3041, 0x33FF),   # かな・CJK 記号
    (0x3400, 0x4DBF),   # CJK 拡張A
    (0x4E00, 0x9FFF),   # CJK 統合漢字
    (0xA000, 0xA4CF),   # イ文字
    (0xAC00, 0xD7A3),   # ハングル音節
    (0xF900, 0xFAFF),   # CJK 互換漢字
    (0xFE30, 0xFE4F),   # CJK 互換形
    (0xFF00, 0xFF60),   # 全角英数・記号
    (0xFFE0, 0xFFE6),   # 全角通貨記号など
    (0x20000, 0x3FFFD),  # CJK 拡張B以降
)


def _char_weight(ch: str) -> int:
    """1文字の重み（全角・絵文字は2、それ以外は1）。"""
    o = ord(ch)
    if o >= 0x1F000:  # 絵文字・記号類はおおむね2幅
        return 2
    for lo, hi in _WIDE_RANGES:
        if lo <= o <= hi:
            return 2
    return 1


def weighted_len(text: str) -> int:
    """X の重み付き文字数（近似）を返す。URL は一律 URL_WEIGHT で数える。"""
    total = 0
    last = 0
    for m in _URL_RE.finditer(text):
        total += sum(_char_weight(ch) for ch in text[last : m.start()])
        total += URL_WEIGHT
        last = m.end()
    total += sum(_char_weight(ch) for ch in text[last:])
    return total


def truncate_to_weight(text: str, max_weight: int) -> str:
    """重み付き文字数が max_weight を超えないように末尾を切り詰める。

    切り詰めた場合は末尾に「…」を付ける（この記号分も収まるように処理する）。
    """
    total = 0
    out: list[str] = []
    for ch in text:
        w = _char_weight(ch)
        if total + w > max_weight:
            # 「…」（重み2）分の余地を残して確定
            trimmed = "".join(out).rstrip()
            return f"{trimmed}…"
        total += w
        out.append(ch)
    return text
