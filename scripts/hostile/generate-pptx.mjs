import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile PPTX packages: groups nested 1,000 deep, a SmartArt parent cycle, a span flood and
// prototype-named relationship ids, placeholders and shapes.
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const directory = new URL('../../hostile/pptx/', import.meta.url);
await mkdir(directory, { recursive: true });

/** `slides` is a list of [relationship id, spTree XML, extra slide relationships]. */
function pptx(slides, extra = {}) {
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${slides.map(([id], index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${PKG}">${slides.map(([id], index) => `<Relationship Id="${id}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
    ...extra,
  };
  slides.forEach(([, tree, rels], index) => {
    files[`ppt/slides/slide${index + 1}.xml`] =
      `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`;
    if (rels) files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = `<Relationships xmlns="${PKG}">${rels}</Relationships>`;
  });
  const entries = Object.create(null);
  for (const [name, content] of Object.entries(files)) {
    entries[name] = [strToU8(content), { mtime: new Date('1980-01-01T00:00:00Z') }];
  }
  return zipSync(entries, { level: 9 });
}

const text = (value, ph = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;

// Groups nested 1,000 deep: DEPTH_LIMIT at blockDepth, then the XML depth budget truncates.
const group = (inner) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="2" cy="2"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;
let nested = text('deep');
for (let depth = 0; depth < 1000; depth++) nested = group(nested);
await writeFile(new URL('deep-groups-1000.pptx', directory), pptx([['rId1', `${text('before')}${nested}`]]));

// A SmartArt data part whose parOf connections form a cycle, plus 10,000 points.
const diagramFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="d"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="${DGM}"><dgm:relIds xmlns:dgm="${DGM}" r:dm="__proto__"/></a:graphicData></a:graphic></p:graphicFrame>`;
const points = Array.from(
  { length: 10_000 },
  (_, index) => `<dgm:pt modelId="${index}"><dgm:t><a:p><a:r><a:t>n${index}</a:t></a:r></a:p></dgm:t></dgm:pt>`,
).join('');
const cycle = Array.from({ length: 10_000 }, (_, index) => `<dgm:cxn modelId="c${index}" srcId="${(index + 1) % 10_000}" destId="${index}"/>`).join('');
await writeFile(
  new URL('smartart-cycle.pptx', directory),
  pptx([['rId1', diagramFrame, `<Relationship Id="__proto__" Type="${R}/diagramData" Target="../diagrams/data1.xml"/>`]], {
    'ppt/diagrams/data1.xml': `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst>${points}</dgm:ptLst><dgm:cxnLst>${cycle}</dgm:cxnLst></dgm:dataModel>`,
  }),
);

// A table whose cells claim huge spans, and prototype-named ids, placeholders and slides.
const spanCell = '<a:tc gridSpan="999999" rowSpan="999999"><a:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc>';
const spanTable = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="t"><a:tbl><a:tr>${spanCell.repeat(50)}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
await writeFile(
  new URL('proto-names-spans.pptx', directory),
  pptx([
    ['__proto__', `${text('__proto__', '<p:ph type="__proto__" idx="constructor"/>')}${spanTable}`, `<Relationship Id="constructor" Type="${R}/slideLayout" Target="../slideLayouts/missing.xml"/>`],
    ['constructor', text('ok', '<p:ph type="title"/>')],
  ]),
);
