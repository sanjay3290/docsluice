"""Password-protected OOXML fixtures for the decryption tests (#90), saved by LibreOffice.

LibreOffice writes [MS-OFFCRYPTO] Agile encryption (AES-256, SHA-512, 100,000 spins) when a
document is stored to an OOXML filter with a Password property. Start LibreOffice listening first:

    soffice --headless --invisible --norestore --accept="socket,host=localhost,port=2002;urp;" &
    python3 scripts/corpus/make-encrypted-ooxml.py

The sources are the synthetic corpus sources in scripts/corpus/src (CC0-1.0); the password is
"docsluice". Output: packages/docsluice/test/office/fixtures/libreoffice/encrypted.{docx,xlsx,pptx}.
"""

import os

import uno
from com.sun.star.beans import PropertyValue

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "packages", "docsluice", "test", "office", "fixtures", "libreoffice")
JOBS = [
    ("headings-outline.fodt", "encrypted.docx", "MS Word 2007 XML"),
    ("workbook-values-formulas.fods", "encrypted.xlsx", "Calc MS Excel 2007 XML"),
    ("deck-hidden-notes.fodp", "encrypted.pptx", "Impress MS PowerPoint 2007 XML"),
]


def prop(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def main():
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    context = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    os.makedirs(OUT, exist_ok=True)
    for source, target, filter_name in JOBS:
        url = uno.systemPathToFileUrl(os.path.join(ROOT, "scripts", "corpus", "src", source))
        document = desktop.loadComponentFromURL(url, "_blank", 0, (prop("Hidden", True),))
        destination = uno.systemPathToFileUrl(os.path.join(OUT, target))
        document.storeToURL(destination, (prop("FilterName", filter_name), prop("Password", "docsluice")))
        document.close(True)
        with open(os.path.join(OUT, target + ".license"), "w", encoding="utf-8") as license_file:
            license_file.write(
                "SPDX-License-Identifier: CC0-1.0\n"
                f"Source: made for docsluice with LibreOffice from scripts/corpus/src/{source} "
                "by scripts/corpus/make-encrypted-ooxml.py (password: docsluice)\n"
            )


if __name__ == "__main__":
    main()
