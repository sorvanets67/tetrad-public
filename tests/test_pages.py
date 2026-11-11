import shutil
import tempfile
import unittest
from pathlib import Path

from prepare_pages import ASSETS, SOURCE_ASSETS, DIST, prepare, prepare_source, validate_assets


class PagesPackageTests(unittest.TestCase):
    def test_clean_source_snapshot_can_be_packaged_again_without_local_history(self):
        with tempfile.TemporaryDirectory() as folder:
            output = prepare_source(Path(folder) / 'github')
            actual = {file.relative_to(output).as_posix()
                      for file in output.rglob('*') if file.is_file()}
            self.assertEqual(actual, set(SOURCE_ASSETS) | {'dist/' + name for name in ASSETS})
            self.assertFalse((output / '.git').exists())
            self.assertFalse(any('FT40' in name for name in actual))
            prepare(Path(folder) / 'site', output / 'dist')

    def test_package_has_only_runtime_assets_and_licensed_font(self):
        with tempfile.TemporaryDirectory() as folder:
            output = prepare(Path(folder) / 'repository')
            actual = {file.relative_to(output).as_posix()
                      for file in output.rglob('*') if file.is_file()}
            self.assertEqual(actual, set(ASSETS))
            self.assertTrue((output / 'index.html').is_file())
            self.assertTrue((output / '.nojekyll').is_file())
            self.assertFalse(any('FT40' in name for name in actual))
            for name in ASSETS:
                self.assertEqual((output / name).read_bytes(), (DIST / name).read_bytes())
            validate_assets(output)

    def test_existing_files_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            notes = Path(folder) / 'backup.json'
            notes.write_text('my notes')
            with self.assertRaisesRegex(ValueError, 'должна быть пустой'):
                prepare(folder)
            self.assertEqual(notes.read_text(), 'my notes')
            self.assertEqual(list(Path(folder).iterdir()), [notes])

    def test_missing_assets_and_root_paths_fail_before_creating_output(self):
        for replacement in ('/app.js', 'missing.js'):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / 'dist'
                shutil.copytree(DIST, source)
                index = source / 'index.html'
                index.write_text(index.read_text().replace('src="app.js?', f'src="{replacement}?'))
                output = Path(folder) / 'site'
                with self.assertRaises(ValueError):
                    prepare(output, source)
                self.assertFalse(output.exists())

    def test_symlinks_cannot_publish_files_from_outside_dist(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'dist'
            shutil.copytree(DIST, source)
            secret = Path(folder) / 'secret.txt'
            secret.write_text('private')
            module = source / 'core.mjs'
            module.unlink()
            module.symlink_to(secret)
            with self.assertRaises(ValueError):
                prepare(Path(folder) / 'site', source)


if __name__ == '__main__':
    unittest.main()
