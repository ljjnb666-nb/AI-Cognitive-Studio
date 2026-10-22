#!/usr/bin/env python3
"""Compare OCR layout modes offline; emit hashes and metrics, no book text."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import statistics
import subprocess
import time
import zipfile

import fitz

MAX_SOURCE_BYTES = 200 * 1024 * 1024
MODES = (3, 6, 11)


def read_documents(archive, root, expected):
    if archive:
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                if (entry.is_dir() or entry.file_size > MAX_SOURCE_BYTES
                        or not entry.filename.lower().endswith('.pdf')):
                    continue
                with source.open(entry) as stream:
                    data = stream.read(MAX_SOURCE_BYTES + 1)
                if len(data) > MAX_SOURCE_BYTES:
                    continue
                fixture = expected.get(hashlib.sha256(data).hexdigest())
                if fixture:
                    yield fixture, data
    else:
        for path in Path(root).rglob('*.pdf'):
            if path.is_symlink() or path.stat().st_size > MAX_SOURCE_BYTES:
                continue
            data = path.read_bytes()
            fixture = expected.get(hashlib.sha256(data).hexdigest())
            if fixture:
                yield fixture, data


def recognize(png, mode):
    started = time.perf_counter()
    completed = subprocess.run(
        ['tesseract', 'stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', str(mode), 'tsv'],
        input=png, capture_output=True, check=True, timeout=90,
    )
    words, confidences = [], []
    for line in completed.stdout.decode('utf-8', 'replace').splitlines()[1:]:
        cells = line.split('\t', 11)
        if len(cells) != 12:
            continue
        word = cells[11].strip()
        if not word:
            continue
        words.append(word)
        try:
            confidence = float(cells[10])
            if confidence >= 0:
                confidences.append(confidence)
        except ValueError:
            pass
    output = ' '.join(words)
    plain = ''.join(output.split())
    return plain, {
        'mode': mode, 'status': 'ok',
        'wall_ms': round((time.perf_counter() - started) * 1000, 1),
        'character_count': len(plain),
        'cjk_character_count': len(re.findall(r'[\u4e00-\u9fff]', plain)),
        'ocr_word_count': len(words),
        'mean_engine_confidence': round(statistics.mean(confidences), 1) if confidences else None,
        'output_sha256': hashlib.sha256(output.encode('utf-8')).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument('--archive')
    where.add_argument('--root')
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text('utf-8'))
    if manifest.get('schema_version') != 1:
        raise ValueError('unsupported manifest version')
    expected = {f['sha256']: f for f in manifest['sources']
                if f['format'] == 'pdf' and f.get('ocr_physical_pages')}
    rows, matched = [], set()
    for fixture, payload in read_documents(args.archive, args.root, expected):
        if fixture['id'] in matched:
            raise ValueError('duplicate source: ' + fixture['id'])
        matched.add(fixture['id'])
        if len(payload) != fixture['size']:
            raise ValueError('source length mismatch: ' + fixture['id'])
        with fitz.open(stream=payload, filetype='pdf') as doc:
            if len(doc) != fixture['total_physical_pages']:
                raise ValueError('page count mismatch: ' + fixture['id'])
            for physical_page in fixture['ocr_physical_pages']:
                if not (1 <= physical_page <= len(doc)):
                    raise ValueError('physical page out of bounds')
                page = doc[physical_page - 1]
                pix = page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6),
                                     colorspace=fitz.csRGB, alpha=False)
                png = pix.tobytes('png')
                metrics, texts = [], []
                for mode in MODES:
                    try:
                        text, row = recognize(png, mode)
                    except Exception as exc:
                        text = ''
                        row = {'mode': mode, 'status': 'error',
                               'error_type': type(exc).__name__}
                    metrics.append(row)
                    texts.append(text)
                pairs = {}
                for i in range(len(MODES)):
                    for j in range(i + 1, len(MODES)):
                        pairs[f'{MODES[i]}_vs_{MODES[j]}'] = round(
                            difflib.SequenceMatcher(None, texts[i], texts[j],
                                                    autojunk=False).ratio(), 3)
                rows.append({'book_id': fixture['id'], 'physical_page': physical_page,
                             'modes': metrics, 'pairwise_similarity': pairs})
    missing = sorted(f['id'] for f in expected.values() if f['id'] not in matched)
    if missing:
        raise ValueError('missing SHA-pinned sources: ' + ','.join(missing))
    rows.sort(key=lambda row: (row['book_id'], row['physical_page']))
    report = {'schema_version': 1, 'corpus_id': manifest['corpus_id'],
              'evidence_level': 'AUTO_CONSISTENCY_PROXY_NOT_ACCURACY',
              'tesseract_modes': list(MODES), 'image_scale': 1.6,
              'book_count': len(matched), 'page_count': len(rows),
              'ocr_executions': sum(len(row['modes']) for row in rows),
              'rows': rows}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(f'Processed {len(matched)} books, {len(rows)} pages; private metadata only')


if __name__ == '__main__':
    main()
