#!/usr/bin/env python3
"""Copy the static application into a clean GitHub Pages directory, without publishing."""

import argparse
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
from urllib.parse import unquote, urlsplit

DIST = Path(__file__).resolve().parent / 'dist'
ASSETS = (
    'index.html', 'style.css', 'theme.js', 'app.js', 'core.mjs', 'shapes.mjs',
    'ink.mjs', 'page-stack.mjs', 'library.mjs', 'persistence.mjs', 'storage-worker.mjs',
    'fonts/Onest-Variable.ttf', 'fonts/Onest-OFL.txt', '.nojekyll',
)
SOURCE_ASSETS = (
    'README.md', 'AGENTS.md', '.gitignore', 'serve.py', 'prepare_pages.py',
    '.github/workflows/pages.yml', 'tests/core.test.mjs', 'tests/browser-smoke.mjs',
    'tests/storage-browser.mjs', 'tests/test_server.py', 'tests/test_pages.py',
    'tests/fixtures/shape-contours.mjs',
)


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        self.references.extend(value for name, value in attrs
                               if name in ('src', 'href') and value)


def validate_assets(source):
    source = Path(source).resolve()
    for name in ASSETS:
        file = source / name
        if not file.is_file() or file.is_symlink():
            raise ValueError(f'Отсутствует обычный файл: {name}')
        references = []
        if file.suffix == '.html':
            links = Links()
            links.feed(file.read_text())
            references = links.references
        elif file.suffix == '.css':
            references = re.findall(r'''url\(\s*['"]?([^'"\s)]+)''', file.read_text())
        elif file.suffix in ('.js', '.mjs'):
            references = re.findall(
                r'''(?:\bfrom\s+|\bimport\s*|\bnew\s+URL\s*\(\s*)['"]([^'"]+)['"]''',
                file.read_text())
        for reference in references:
            url = urlsplit(reference)
            if url.scheme or url.netloc or url.path.startswith('/'):
                raise ValueError(f'{name}: нужен относительный путь: {reference}')
            if not url.path:
                continue
            target = (file.parent / unquote(url.path)).resolve()
            if url.path.endswith('/'):
                target /= 'index.html'
            if not target.is_relative_to(source) or target.relative_to(source).as_posix() not in ASSETS:
                raise ValueError(f'{name}: ссылка вне пакета Pages: {reference}')


def prepare(output, source=DIST):
    source = Path(source).resolve()
    output = Path(output)
    validate_assets(source)
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError(f'Папка назначения должна быть пустой: {output}')
    output.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    return output.resolve()


def prepare_source(output):
    """Make a clean source snapshot without local history, old fonts or private files."""
    root = DIST.parent
    for name in SOURCE_ASSETS:
        if not (root / name).is_file() or (root / name).is_symlink():
            raise ValueError(f'Отсутствует обычный файл исходников: {name}')
    output = Path(output)
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError(f'Папка назначения должна быть пустой: {output}')
    prepare(output / 'dist')
    for name in SOURCE_ASSETS:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, target)
    return output.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('_site'))
    parser.add_argument('--source', action='store_true', help='Подготовить чистые исходники для нового репозитория')
    args = parser.parse_args()
    try:
        output = prepare_source(args.output) if args.source else prepare(args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    print(f'Пакет GitHub Pages готов: {output}\nНичего не опубликовано.')


if __name__ == '__main__':
    main()
