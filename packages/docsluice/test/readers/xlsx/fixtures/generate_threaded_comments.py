# SPDX-License-Identifier: CC0-1.0
"""Rebuild the self-authored threaded-comments package from the feature fixture."""

from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


HERE = Path(__file__).parent
SOURCE = HERE / 'headers_comments_hidden_tables_defined_names.xlsx'
DEFAULT_OUTPUT = HERE / 'threaded_comments.xlsx'

REPLACEMENTS = {
    '[Content_Types].xml': (
        b'</Types>',
        b'<Override PartName="/xl/threadedComments/threadedComment1.xml" '
        b'ContentType="application/vnd.ms-excel.threadedcomments+xml"/>'
        b'<Override PartName="/xl/persons/person.xml" '
        b'ContentType="application/vnd.ms-excel.person+xml"/></Types>',
    ),
    'xl/_rels/workbook.xml.rels': (
        b'</Relationships>',
        b'<Relationship Id="rIdPerson" '
        b'Type="http://schemas.microsoft.com/office/2017/10/relationships/person" '
        b'Target="persons/person.xml"/></Relationships>',
    ),
    'xl/worksheets/_rels/sheet1.xml.rels': (
        b'</Relationships>',
        b'<Relationship Id="rId5" '
        b'Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" '
        b'Target="../threadedComments/threadedComment1.xml"/></Relationships>',
    ),
    'xl/workbook.xml': (
        b'<definedName name="FeatureRange">',
        b'<definedName name="FeatureRange" localSheetId="0">',
    ),
}

PEOPLE = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/person">
  <person displayName="Threaded Author" id="{person-a}" userId="private-user-a" providerId="AD"/>
  <person displayName="Reply Author" id="{person-b}" userId="private-user-b" providerId="AD"/>
  <person displayName="Unused Person" id="{unused-person}" userId="unused" providerId="AD"/>
</personList>
'''

THREADED_COMMENTS = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">
  <threadedComment ref="A3" dT="2026-10-09T12:00:00Z" personId="{person-a}" id="{comment-a}"><text>Threaded comment</text></threadedComment>
  <threadedComment ref="A3" dT="2026-10-09T12:01:00Z" personId="{person-b}" id="{comment-b}" parentId="{comment-a}"><text>Thread reply</text><ext:text xmlns:ext="urn:fixture-extension">Injected extension text</ext:text></threadedComment>
</ThreadedComments>
'''


def main() -> None:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    output_entries: list[tuple[str, bytes]] = []
    with ZipFile(SOURCE) as source:
        for name in source.namelist():
            data = source.read(name)
            replacement = REPLACEMENTS.get(name)
            if replacement:
                before, after = replacement
                if before not in data:
                    raise ValueError(f'Expected source marker is missing from {name}')
                data = data.replace(before, after, 1)
            output_entries.append((name, data))
    output_entries.extend(
        [
            ('xl/persons/person.xml', PEOPLE),
            ('xl/threadedComments/threadedComment1.xml', THREADED_COMMENTS),
        ]
    )
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in output_entries:
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)


if __name__ == '__main__':
    main()
