"""Build the three self-hosted mobile font subsets with fontTools + Brotli."""
import argparse
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source_dir", type=Path, help="title-source.woff, text-source.ttf, ui-source.ttf and OFL-*.txt")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
mobile = root / "src/remote/mobile-ui"
output = mobile / "fonts"
output.mkdir(exist_ok=True)

base = set(range(0x20, 0x100)) | set(range(0x2000, 0x2070)) | set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFEF))
ui = set(base)
for file in mobile.iterdir():
    if file.suffix in {".html", ".js", ".css"}:
        ui.update(ord(char) for char in file.read_text(encoding="utf-8") if 0x3400 <= ord(char) <= 0x9FFF)
body = set(ui)
for lead in range(0xA1, 0xF8):
    for trail in range(0xA1, 0xFF):
        try:
            body.update(map(ord, bytes([lead, trail]).decode("gb2312")))
        except UnicodeDecodeError:
            pass

for role, source, family, characters, weight in [
    ("title", "title-source.woff", "Huahua Title", ui, 600),
    ("text", "text-source.ttf", "Huahua Text", body, 400),
    ("ui", "ui-source.ttf", "Huahua UI", ui, 400),
]:
    font = TTFont(args.source_dir / source)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight}, inplace=True)
    font["OS/2"].usWeightClass = weight
    for record in font["name"].names:
        if record.nameID in {1, 3, 4, 6, 16}:
            value = family.replace(" ", "") if record.nameID == 6 else family
            record.string = value.encode(record.getEncoding())
        elif record.nameID in {2, 17}:
            record.string = "Regular".encode(record.getEncoding())
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=characters)
    subsetter.subset(font)
    font.flavor = "woff2"
    target = output / f"huahua-{role}-v1.woff2"
    font.save(target)
    (output / f"OFL-{role}.txt").write_bytes((args.source_dir / f"OFL-{role}.txt").read_bytes())
    print(f"{target.name}: {target.stat().st_size:,} bytes; {len(font.getBestCmap())} characters")
