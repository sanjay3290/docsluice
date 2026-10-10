import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made deck (CC0-1.0), written from ECMA-376 Part 1, 19 (PresentationML) and 21.4 (diagrams).
// Slide part names do not follow slide order, shapes are written out of reading order, and some
// placeholders take their position from the layout.
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;

let id = 2;
const xfrm = (x, y, cx = 3000000, cy = 500000) =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const para = (text, pPr = '') => `<a:p>${pPr}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
const shape = ({ name = 'Shape', ph, position, paragraphs }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr>${position ?? ''}</p:spPr><p:txBody><a:bodyPr/>${paragraphs.join('')}</p:txBody></p:sp>`;
const tree = (shapes) =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld>`;
const slide = (shapes, show = '') =>
  xml(`<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:p14="${P14}"${show}>${tree(shapes)}</p:sld>`);

// Slide 1 (slide10.xml): title and subtitle placeholders positioned only by the layout.
const titleSlide = slide([
  shape({ ph: '<p:ph type="subTitle" idx="3"/>', paragraphs: [para('Field season review')] }),
  shape({ ph: '<p:ph type="ctrTitle"/>', paragraphs: [para('Estuary'), para('Monitoring 2026')] }),
]);

// Slide 2 (slide2.xml): two columns written right column first; bullets, levels, numbering, symbols.
const columns = slide([
  shape({
    ph: '<p:ph idx="2"/>',
    paragraphs: [para('Right column point'), para('Right detail', '<a:pPr lvl="1"/>')],
  }),
  shape({ ph: '<p:ph type="title"/>', paragraphs: [para('Two columns')] }),
  shape({
    ph: '<p:ph idx="1"/>',
    paragraphs: [
      para('Left column point'),
      para('Left detail', '<a:pPr lvl="1"/>'),
      para('A note without a bullet', '<a:pPr><a:buNone/></a:pPr>'),
    ],
  }),
  shape({
    name: 'Steps',
    position: xfrm(500000, 4000000),
    paragraphs: [
      para('Collect', '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      para('Label', '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      para('Duplicate', '<a:pPr lvl="1"><a:buAutoNum type="alphaLcParenR"/></a:pPr>'),
      para('Ship', '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
    ],
  }),
  shape({
    name: 'Checks',
    position: xfrm(5000000, 4000000),
    paragraphs: [
      para('Tide logged', '<a:pPr><a:buFont typeface="Wingdings"/><a:buChar char="ü"/></a:pPr>'),
      para('Gauge read', '<a:pPr><a:buChar char="–"/></a:pPr>'),
    ],
  }),
]);

// Slide 3 (slide1.xml): a scaled group whose children only sort correctly once transformed, and a table.
const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id++}" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000000" y="4000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr>${shape(
  { name: 'Lower', position: xfrm(0, 1600000), paragraphs: [para('Group lower item')] },
)}${shape({ name: 'Upper', position: xfrm(0, 0), paragraphs: [para('Group upper item')] })}</p:grpSp>`;
const cell = (text, attrs = '') => `<a:tc${attrs}><a:txBody><a:bodyPr/>${para(text)}</a:txBody></a:tc>`;
const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id++}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="6000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid><a:tr h="370840">${cell('Site')}${cell('Readings', ' gridSpan="2"')}${cell('', ' hMerge="1"')}</a:tr><a:tr h="370840">${cell('North', ' rowSpan="2"')}${cell('7.1')}${cell('7.3')}</a:tr><a:tr h="370840">${cell('', ' vMerge="1"')}${cell('6.9')}${cell('7.0')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const groups = slide([
  group,
  shape({ name: 'Between', position: xfrm(1000000, 4500000), paragraphs: [para('Between the group items')] }),
  table,
  shape({ ph: '<p:ph type="title"/>', paragraphs: [para('Groups and tables')] }),
], ' show="0"');

// Speaker notes for slide 2, laid out as PowerPoint writes them: slide image, body and number.
const notes = xml(
  `<p:notes xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">${tree([
    `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`,
    shape({ ph: '<p:ph type="body" idx="1"/>', paragraphs: [para('Start with the left column.'), para('Then compare the right.')] }),
    shape({ ph: '<p:ph type="sldNum" idx="5"/>', paragraphs: [para('2')] }),
  ])}</p:notes>`,
);

// Slide 4 (slide3.xml): SmartArt, footer placeholders and alternate content.
const diagram = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id++}" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="6000000" cy="2500000"/></p:xfrm><a:graphic><a:graphicData uri="${DGM}"><dgm:relIds xmlns:dgm="${DGM}" r:dm="rIdData" r:lo="rIdLayout" r:qs="rIdStyle" r:cs="rIdColors"/></a:graphicData></a:graphic></p:graphicFrame>`;
const alternate = `<mc:AlternateContent><mc:Choice Requires="p14">${shape({ name: 'New', position: xfrm(1000000, 4200000), paragraphs: [para('Choice text (skipped)')] })}</mc:Choice><mc:Fallback>${shape({ name: 'Old', position: xfrm(1000000, 4200000), paragraphs: [para('Fallback text')] })}</mc:Fallback></mc:AlternateContent>`;
const smartArt = slide([
  shape({ ph: '<p:ph type="ftr" idx="11"/>', position: xfrm(3000000, 6000000), paragraphs: [para('Synthetic data only')] }),
  shape({ ph: '<p:ph type="sldNum" idx="12"/>', position: xfrm(7000000, 6000000), paragraphs: [para('4')] }),
  shape({ ph: '<p:ph type="dt" idx="10"/>', position: xfrm(500000, 6000000), paragraphs: [para('1/1/2026')] }),
  alternate,
  diagram,
  shape({ ph: '<p:ph type="title"/>', paragraphs: [para('Process')] }),
]);
const point = (modelId, type, text) =>
  `<dgm:pt modelId="${modelId}"${type ? ` type="${type}"` : ''}>${text === undefined ? '' : `<dgm:t><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t>`}</dgm:pt>`;
const cxn = (src, dest, type) => `<dgm:cxn modelId="c${src}${dest}" srcId="${src}" destId="${dest}"${type ? ` type="${type}"` : ''}/>`;
const data = xml(
  `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst>${[
    point('0', 'doc'),
    point('1', '', 'Plan'),
    point('2', '', 'Sample'),
    point('3', '', 'Core samples'),
    point('4', '', 'Report'),
    point('5', 'pres', 'Presentation text (skipped)'),
    point('6', 'sibTrans', 'Arrow (skipped)'),
  ].join('')}</dgm:ptLst><dgm:cxnLst>${[cxn('0', '1'), cxn('0', '2'), cxn('2', '3'), cxn('0', '4'), cxn('1', '6', 'presOf')].join('')}</dgm:cxnLst></dgm:dataModel>`,
);

const layoutShapes = [
  shape({ ph: '<p:ph type="ctrTitle"/>', position: xfrm(500000, 1000000), paragraphs: [para('Layout title')] }),
  shape({ ph: '<p:ph type="subTitle" idx="3"/>', position: xfrm(500000, 3000000), paragraphs: [para('Layout subtitle')] }),
  shape({ ph: '<p:ph type="title"/>', position: xfrm(500000, 300000), paragraphs: [para('Layout title')] }),
  shape({ ph: '<p:ph idx="1"/>', position: xfrm(500000, 1500000), paragraphs: [para('Left')] }),
  shape({ ph: '<p:ph idx="2"/>', position: xfrm(5000000, 1500000), paragraphs: [para('Right')] }),
];
const layout = xml(`<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">${tree(layoutShapes)}</p:sldLayout>`);
const master = xml(
  `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">${tree([
    shape({ ph: '<p:ph type="title"/>', position: xfrm(500000, 300000), paragraphs: [para('Master title')] }),
  ])}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
);

// Slide order: slide10, slide2, slide1, slide3 — part names deliberately out of order (PPT-1).
const slides = [
  ['slide10.xml', titleSlide],
  ['slide2.xml', columns],
  ['slide1.xml', groups],
  ['slide3.xml', smartArt],
];
const layoutRel = `<Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
const files = {
  '[Content_Types].xml': xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>${slides.map(([name]) => `<Override PartName="/ppt/slides/${name}" ContentType="${CT}.slide+xml"/>`).join('')}<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/><Override PartName="/ppt/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/></Types>`,
  ),
  '_rels/.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  ),
  'ppt/presentation.xml': xml(
    `<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  ),
  'ppt/_rels/presentation.xml.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rIdMaster" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${[...slides]
      .reverse()
      .map(([name]) => `<Relationship Id="rIdSlide${slides.findIndex(([other]) => other === name) + 1}" Type="${R}/slide" Target="slides/${name}"/>`)
      .join('')}</Relationships>`,
  ),
  'ppt/slideLayouts/slideLayout1.xml': layout,
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  ),
  'ppt/slideMasters/slideMaster1.xml': master,
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
  ),
  'ppt/diagrams/data1.xml': data,
};
for (const [name, content] of slides) {
  files[`ppt/slides/${name}`] = content;
  files[`ppt/slides/_rels/${name}.rels`] = xml(
    `<Relationships xmlns="${PKG}">${layoutRel}${name === 'slide3.xml' ? `<Relationship Id="rIdData" Type="${R}/diagramData" Target="../diagrams/data1.xml"/>` : ''}${name === 'slide2.xml' ? `<Relationship Id="rIdNotes" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>` : ''}</Relationships>`,
  );
}
files['ppt/notesSlides/notesSlide1.xml'] = notes;
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/pptx/reading-order.pptx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/pptx/reading-order.pptx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-pptx-reading-order.mjs\nRequirements: PPT-1, PPT-2, PPT-3, PPT-4, PPT-5\nNotes: slide part names out of slide order; title and body placeholders positioned by the layout; two columns written right first; bullets, levels, numbering and symbol bullets; a scaled group; a table with spans; SmartArt; footer, date and slide-number placeholders; alternate content; speaker notes on slide 2; slide 3 hidden.\n',
);
