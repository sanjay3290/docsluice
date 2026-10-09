"""Create matching CC0 DOC and DOCX fixtures from the shared FODT source."""

from pathlib import Path
import argparse
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET


SOURCE = Path(__file__).with_name("doc-legacy.fodt")
LICENSE = """SPDX-License-Identifier: CC0-1.0
Source: made for docsluice with LibreOfficeDev 26.8 from scripts/corpus/doc-legacy.fodt
Notes: matching DOC/DOCX sample for legacy text recall, heading, table and encoding coverage.
"""


def convert(source: Path, output: Path, profile: Path, target: str) -> None:
    subprocess.run(
        [
            "soffice",
            "--headless",
            f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to",
            target,
            "--outdir",
            str(output),
            str(source),
        ],
        check=True,
    )


def native_docx_text(path: Path) -> str:
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    paragraphs = []
    for paragraph in root.iter(f"{namespace}p"):
        value = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t"))
        if value:
            paragraphs.append(value)
    return "\n".join(paragraphs) + "\n"


def main() -> None:
    default_output = Path(__file__).resolve().parents[2] / "corpus" / "doc"
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="docsluice-doc-fixtures-") as temporary:
        work = Path(temporary)
        source = work / "doc-legacy.fodt"
        source.write_bytes(SOURCE.read_bytes())
        profile = work / "profile"
        convert(source, args.output, profile, "doc:MS Word 97")
        convert(source, args.output, profile, "docx:Office Open XML Text")

    doc = args.output / "doc-legacy.doc"
    docx = args.output / "doc-legacy.docx"
    (args.output / "doc-legacy.doc.license").write_text(LICENSE, encoding="utf-8")
    (args.output / "doc-legacy.docx.license").write_text(LICENSE, encoding="utf-8")
    (args.output / "doc-legacy.docx.native.txt").write_text(native_docx_text(docx), encoding="utf-8")


if __name__ == "__main__":
    main()
