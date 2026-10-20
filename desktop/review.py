"""Pure word, punctuation, and whitespace review for the desktop shortcut."""

from dataclasses import dataclass
import html
import re

TOKEN = re.compile(r"\w+(?:['’]\w+)*|\s+|[^\s]", re.UNICODE)


@dataclass(frozen=True)
class Edit:
    start: int
    end: int
    original: str
    replacement: str


def split_edits(original, corrected):
    """Align tokens by kind, keeping nearby spacing and punctuation independent."""
    before = [(m.group(), m.start(), m.end()) for m in TOKEN.finditer(original)]
    after = [m.group() for m in TOKEN.finditer(corrected)]
    def kind(token):
        return 0 if token.isspace() else 1 if token[0].isalnum() or token[0] == '_' else 2

    width = len(after) + 1
    path = bytearray((len(before) + 1) * width)
    previous = [float(j) for j in range(width)]
    for j in range(1, width):
        path[j] = 2
    for i, (old, _, _) in enumerate(before, 1):
        current = [float(i)] + [0.0] * (width - 1)
        path[i * width] = 1
        for j, new in enumerate(after, 1):
            cost = 0 if old == new else 3 if kind(old) != kind(new) else 0.1 if kind(old) == 0 else 1
            best, direction = previous[j - 1] + cost, 0
            if previous[j] + 1 < best:
                best, direction = previous[j] + 1, 1
            if current[j - 1] + 1 < best:
                best, direction = current[j - 1] + 1, 2
            current[j] = best
            path[i * width + j] = direction
        previous = current

    aligned = []
    i, j = len(before), len(after)
    while i or j:
        direction = path[i * width + j]
        if direction == 0:
            i -= 1
            j -= 1
            aligned.append((before[i][0], after[j]))
        elif direction == 1:
            i -= 1
            aligned.append((before[i][0], ''))
        else:
            j -= 1
            aligned.append(('', after[j]))
    edits = []
    offset = 0
    for old, new in reversed(aligned):
        if old != new:
            # A newly inserted word owns its leading separator, not adjacent words.
            if not old and new and not new.isspace() and (new[0].isalnum() or new[0] == '_') and edits and edits[-1].start == offset == edits[-1].end and edits[-1].replacement.isspace():
                last = edits.pop()
                edits.append(Edit(offset, offset, '', last.replacement + new))
            else:
                edits.append(Edit(offset, offset + len(old), old, new))
        offset += len(old)
    return edits


def apply_selected(original, edits, selected):
    """Apply original-coordinate edits in order; preceding changes re-anchor later ones."""
    result, offset = original, 0
    for index, edit in enumerate(edits):
        if index not in selected:
            continue
        start, end = edit.start + offset, edit.end + offset
        if result[start:end] != edit.original:
            raise ValueError('Edit no longer matches original text')
        result = result[:start] + edit.replacement + result[end:]
        offset += len(edit.replacement) - len(edit.original)
    return result


def edit_context(original, edits, index, selected, radius=65):
    """Render the current change against text with earlier accepted edits applied."""
    edit = edits[index]
    before = apply_selected(original, edits[:index], selected)
    shift = sum(len(e.replacement) - len(e.original) for i, e in enumerate(edits[:index]) if i in selected)
    start, end = edit.start + shift, edit.end + shift
    left = ('…' if start > radius else '') + before[max(0, start - radius):start]
    right = before[end:end + radius] + ('…' if end + radius < len(before) else '')
    def visible(value):
        return html.escape(value.replace(' ', '·').replace('\t', '⇥').replace('\n', '↵')) if value else '∅'
    return (html.escape(left) +
            f"<span foreground='#ffb4ab'><s>{visible(edit.original)}</s></span> → " +
            f"<span foreground='#a6d189'><b>{visible(edit.replacement)}</b></span>" +
            html.escape(right))
