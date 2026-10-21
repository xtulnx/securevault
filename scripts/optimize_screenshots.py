#!/usr/bin/env python3
"""Compress README captures to bounded WebP files; requires cwebp and ImageMagick."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs/screenshots'
MAX_WIDTH, MAX_HEIGHT, MAX_BYTES = 1440, 960, 160 * 1024


def dimensions(path):
    value = subprocess.check_output(['magick', 'identify', '-ping', '-format', '%w %h', str(path)], text=True)
    return tuple(map(int, value.split()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path, help='Directory containing fresh PNG/JPEG captures')
    parser.add_argument('--check', action='store_true', help='Verify README references, WebP dimensions and byte budgets')
    args = parser.parse_args()
    OUTPUT.mkdir(exist_ok=True)
    if args.source:
        sources = sorted(path for path in args.source.iterdir() if path.suffix.lower() in ('.png', '.jpg', '.jpeg'))
        if not sources:
            parser.error('No PNG/JPEG captures in source directory')
        for source in sources:
            width, height = dimensions(source)
            scale = min(1, MAX_WIDTH / width, MAX_HEIGHT / height)
            resize = [str(max(1, round(width * scale))), str(max(1, round(height * scale)))]
            with tempfile.NamedTemporaryFile(dir=OUTPUT, suffix='.webp') as temporary:
                candidate = Path(temporary.name)
                for quality in (86, 82, 78, 74):
                    subprocess.run(['cwebp', '-quiet', '-q', str(quality), '-m', '6', '-sharp_yuv', '-metadata', 'none', '-resize', *resize, str(source), '-o', str(candidate)], check=True)
                    if candidate.stat().st_size <= MAX_BYTES:
                        break
                if candidate.stat().st_size > MAX_BYTES:
                    raise SystemExit(f'{source.name}: exceeds {MAX_BYTES} bytes; capture a smaller viewport')
                (OUTPUT / (source.stem + '.webp')).write_bytes(candidate.read_bytes())
    if args.check or args.source:
        import re
        references = set(re.findall(r'docs/screenshots/([\w-]+\.webp)', (ROOT / 'README.md').read_text()))
        manifest = []
        for name in sorted(references):
            target = OUTPUT / name
            data = target.read_bytes()
            if data[:4] != b'RIFF' or data[8:12] != b'WEBP':
                raise SystemExit(f'{name}: not WebP')
            width, height = dimensions(target)
            if width > MAX_WIDTH or height > MAX_HEIGHT or len(data) > MAX_BYTES:
                raise SystemExit(f'{name}: exceeds dimension or byte budget')
            manifest.append(dict(file=name, width=width, height=height, bytes=len(data)))
        result = dict(max_width=MAX_WIDTH, max_height=MAX_HEIGHT, max_bytes=MAX_BYTES,
                      encoding='lossy WebP; quality 86 (fallback 82/78/74); method 6; sharp YUV; no metadata; no upscaling',
                      total_bytes=sum(item['bytes'] for item in manifest), images=manifest)
        (OUTPUT / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(dict(images=len(manifest), total_bytes=result['total_bytes'], largest_bytes=max((item['bytes'] for item in manifest), default=0))))


if __name__ == '__main__':
    main()
