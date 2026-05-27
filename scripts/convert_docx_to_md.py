#!/usr/bin/env python3
"""Convert DOCX to Markdown using mammoth -> html2text.

Usage:
  python3 scripts/convert_docx_to_md.py "docs/Hospital Details.docx" "docs/Hospital Details.md"
"""
import sys
from pathlib import Path

import mammoth
import html2text


def convert(src_path: Path, dst_path: Path) -> int:
    with src_path.open("rb") as f:
        result = mammoth.convert_to_html(f)
        html = result.value
        messages = result.messages

    md = html2text.html2text(html)
    dst_path.write_text(md, encoding="utf-8")

    if messages:
        print("Conversion warnings:")
        for m in messages:
            print(m)
    print(f"Wrote: {dst_path}")
    return 0


def main(argv):
    if len(argv) != 3:
        print("Usage: convert_docx_to_md.py <input.docx> <output.md>")
        return 2
    src = Path(argv[1])
    dst = Path(argv[2])
    if not src.exists():
        print(f"Input not found: {src}")
        return 3
    return convert(src, dst)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
