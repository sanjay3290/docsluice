"""Create the small self-authored legacy Office fixtures in corpus/ole."""

from pathlib import Path
import argparse
import subprocess
import tempfile


PRESENTATION = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:body><office:presentation>
  <presentation:page presentation:style-name="Default" draw:name="Slide 1">
   <draw:frame presentation:class="title" svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm">
    <draw:text-box><text:p>DocSluice CFB fixture from LibreOffice</text:p></draw:text-box>
   </draw:frame>
  </presentation:page>
 </office:presentation></office:body>
</office:document>
'''


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


def main() -> None:
    default_output = Path(__file__).resolve().parents[2] / "corpus" / "ole"
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="docsluice-ole-fixtures-") as temporary:
        work = Path(temporary)
        source = work / "source"
        source.mkdir()
        (source / "libreoffice.txt").write_text(
            "DocSluice CFB fixture from LibreOffice.\nSecond line for stream contents.\n",
            encoding="utf-8",
        )
        (source / "libreoffice.csv").write_text("Item,Count\nPaper,3\n", encoding="utf-8")
        (source / "libreoffice.fodp").write_text(PRESENTATION, encoding="utf-8")
        profile = work / "profile"
        convert(source / "libreoffice.txt", args.output, profile, "doc")
        convert(source / "libreoffice.csv", args.output, profile, "xls")
        convert(source / "libreoffice.fodp", args.output, profile, "ppt")


if __name__ == "__main__":
    main()
