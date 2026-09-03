#!/usr/bin/env python3
"""从 diagram-design HTML 提取内联 SVG 导出为独立 .svg 文件（源归档可复现）。
用法: python3 scripts/lib/export-diagram-svg.py <input.html> [output.svg]
"""
import re, pathlib, sys

src = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix(".svg")
html = src.read_text(encoding="utf-8")
m = re.search(r"<svg[\s\S]*?</svg>", html)
assert m, f"no <svg> block in {src}"
svg = m.group(0)
if svg.count('xmlns="http://www.w3.org/2000/svg"') == 0:
    svg = svg.replace("<svg viewBox", '<svg xmlns="http://www.w3.org/2000/svg" viewBox', 1)
fonts = ("<style>@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1"
         "&amp;family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500;600&amp;display=swap');</style>")
svg = svg.replace("<defs>", "<defs>" + fonts, 1)
svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg
out.write_text(svg, encoding="utf-8")
import xml.dom.minidom
xml.dom.minidom.parseString(svg)
print(f"OK {out} ({len(svg)} bytes, XML valid)")
