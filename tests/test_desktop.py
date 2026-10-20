"""Run with python -m unittest discover -s tests -p 'test_desktop.py'."""
import importlib.machinery
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop'))
from review import apply_selected, edit_context, split_edits

SCRIPT = importlib.machinery.SourceFileLoader('desktop_grammar', str(ROOT / 'desktop/lg-grammar')).load_module()


class EditTests(unittest.TestCase):
    def test_independent_edits_and_reanchoring(self):
        original = 'i  recieved teh adress.'
        corrected = 'I received the address.'
        edits = split_edits(original, corrected)
        self.assertEqual([(e.original, e.replacement) for e in edits],
                         [('i', 'I'), ('  ', ' '), ('recieved', 'received'),
                          ('teh', 'the'), ('adress', 'address')])
        self.assertEqual(apply_selected(original, edits, {1, 4}), 'i recieved teh address.')
        self.assertEqual(apply_selected(original, edits, set(range(len(edits)))), corrected)
        self.assertIn('recieved', edit_context(original, edits, 2, {1}))
        self.assertIn("i <span", edit_context(original, edits, 2, {1}))

    def test_punctuation_insertions_repeats_unicode_and_partial_subsets(self):
        cases = [('teh adress,, arrived', 'the address, arrived.'),
                 ('We work.', 'We will not work.'),
                 ('📝 i  recieved.\n\nDas ist ein Frage.', '📝 I received.\n\nDas ist eine Frage.'),
                 ('x & < >', 'x & < >!')]
        for original, corrected in cases:
            edits = split_edits(original, corrected)
            self.assertEqual(apply_selected(original, edits, set(range(len(edits)))), corrected)
        edits = split_edits('📝 i  recieved.', '📝 I received.')
        self.assertEqual(apply_selected('📝 i  recieved.', edits, {0}), '📝 I  recieved.')
        edits = split_edits('We work.', 'We will not work.')
        self.assertEqual(apply_selected('We work.', edits, {0}), 'We will work.')
        self.assertEqual(apply_selected('We work.', edits, {1}), 'We not work.')
        self.assertIn('&amp;', edit_context('x & < >', split_edits('x & < >', 'x & < >!'), 0, set()))


class DialogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / 'dialogs'
        self.answers = Path(self.tmp.name) / 'answers'
        stub = Path(self.tmp.name) / 'rofi-stub'
        stub.write_text('#!/usr/bin/env python3\nimport os, sys\nfrom pathlib import Path\n'
                        'data = sys.stdin.read()\n'
                        'with Path(os.environ["DIALOG_LOG"]).open("a") as f:\n'
                        '    f.write(repr((sys.argv[1:], data)) + "\\n")\n'
                        'path = Path(os.environ["DIALOG_ANSWERS"])\n'
                        'items = path.read_text().splitlines()\n'
                        'path.write_text("\\n".join(items[1:]))\n'
                        'print(items[0])\n')
        stub.chmod(0o755)
        for key, value in {'LG_ROFI': str(stub), 'DIALOG_LOG': str(self.log),
                           'DIALOG_ANSWERS': str(self.answers)}.items():
            p = patch.dict(os.environ, {key: value})
            p.start()
            self.addCleanup(p.stop)

    def run_flow(self, answers, original='teh adress', corrected='the address', replaceable=True):
        self.answers.write_text('\n'.join(answers))
        saved = []
        with patch.object(SCRIPT, 'active_window', return_value={'class': 'editor', 'address': 'test'}), \
             patch.object(SCRIPT, 'clipboard_read', return_value='saved clipboard'), \
             patch.object(SCRIPT, 'grab_text', return_value=(original, replaceable)), \
             patch.object(SCRIPT, 'check_text', return_value=(corrected, {'en'})), \
             patch.object(SCRIPT, 'clipboard_write', side_effect=lambda text: saved.append(text)), \
             patch.object(SCRIPT, 'apply_text') as apply, \
             patch.object(SCRIPT, 'notify'):
            self.assertEqual(SCRIPT.main(), 0)
        return apply.call_args_list, saved, self.log.read_text() if self.log.exists() else ''
    def test_all_dialogs_enable_mouse_selection(self):
        _, _, dialogs = self.run_flow(
            ['Accept all remaining', 'Copy reviewed text'], replaceable=False
        )
        rows = [line for line in dialogs.splitlines() if "'-dmenu'" in line]
        self.assertEqual(len(rows), 2)
        for line in rows:
            for option in ("'-hover-select'", "'-me-select-entry'", "''", "'-me-accept-entry'", "'MousePrimary'"):
                self.assertIn(option, line)


    def test_skip_accept_applies_only_reviewed_edit(self):
        applied, clipboard, dialogs = self.run_flow(['Skip', 'Accept'])
        self.assertEqual(applied[0].args[1], 'teh address')
        self.assertEqual(clipboard, ['saved clipboard', 'saved clipboard'])
        self.assertEqual(dialogs.count("'-dmenu'"), 2)
        self.assertIn('Open Grammar 1/2', dialogs)
        self.assertIn('Open Grammar 2/2', dialogs)
        self.assertIn('Apply all corrections', dialogs)

    def test_accept_all_and_copy_honor_prior_skips(self):
        applied, _, dialogs = self.run_flow(['Apply all corrections'])
        self.assertEqual(applied[0].args[1], 'the address')
        self.assertEqual(dialogs.count("'-dmenu'"), 1)
        applied, _, _ = self.run_flow(['Skip', 'Accept all remaining'])
        self.assertEqual(applied[0].args[1], 'teh address')
        applied, clipboard, _ = self.run_flow(['Skip', 'Copy corrected text'])
        self.assertFalse(applied)
        self.assertEqual(clipboard[-1], 'teh address')

    def test_cancel_and_skip_all_do_not_paste(self):
        for answers in (['Accept', 'Cancel'], ['Skip', 'Skip']):
            applied, clipboard, _ = self.run_flow(answers)
            self.assertFalse(applied)
            self.assertEqual(clipboard[-1], 'saved clipboard')

    def test_terminal_copy_requires_explicit_choice(self):
        applied, clipboard, _ = self.run_flow(['Accept all remaining', 'Copy reviewed text'], replaceable=False)
        self.assertFalse(applied)
        self.assertEqual(clipboard[-1], 'the address')

    def test_auto_apply_bypasses_dialog(self):
        with patch.object(SCRIPT, 'AUTO_APPLY', True):
            applied, _, dialogs = self.run_flow([])
        self.assertEqual(applied[0].args[1], 'the address')
        self.assertEqual(dialogs, '')


if __name__ == '__main__':
    unittest.main()
