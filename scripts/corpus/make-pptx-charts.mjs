import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made deck (CC0-1.0) with a bar, a line and a pie chart, written from ECMA-376 Part 1, 19
// (PresentationML) and 21.2 (DrawingML charts). Each chart keeps its data in cached series values,
// as PowerPoint writes them; the embedded workbook the charts would link to is left out.
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;

let id = 2;
const para = (text) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
const shape = ({ ph, x, y, text }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Shape"/><p:cNvSpPr/><p:nvPr>${ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="8000000" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${para(text)}</p:txBody></p:sp>`;
const chartFrame = (relId, y) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id++}" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="500000" y="${y}"/><a:ext cx="8000000" cy="4000000"/></p:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${relId}"/></a:graphicData></a:graphic></p:graphicFrame>`;
const slide = (shapes) =>
  xml(
    `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`,
  );

const cache = (kind, values, format) =>
  `<c:${kind}Cache>${format ? `<c:formatCode>${format}</c:formatCode>` : ''}<c:ptCount val="${values.length}"/>${values
    .map((value, index) => (value === undefined ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`))
    .join('')}</c:${kind}Cache>`;
const column = (index) => String.fromCharCode(66 + index);
const series = (index, name, categories, values) =>
  `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>Sheet1!$${column(index)}$1</c:f>${cache('str', [name])}</c:strRef></c:tx>` +
  `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${categories.length + 1}</c:f>${cache('str', categories)}</c:strRef></c:cat>` +
  `<c:val><c:numRef><c:f>Sheet1!$${column(index)}$2:$${column(index)}$${values.length + 1}</c:f>${cache('num', values, 'General')}</c:numRef></c:val></c:ser>`;
const title = (text) =>
  `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>${para(text)}</c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
const axes = '<c:axId val="1001"/><c:axId val="1002"/>';
const axisPair = (axisTitle) =>
  `<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="1002"/></c:catAx>` +
  `<c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${axisTitle ? `<c:title><c:tx><c:rich><a:bodyPr/>${para(axisTitle)}</c:rich></c:tx></c:title>` : ''}<c:crossAx val="1001"/></c:valAx>`;
const chartSpace = (body) =>
  xml(
    `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:roundedCorners val="0"/><c:chart>${body}<c:plotVisOnly val="1"/></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`,
  );

const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
// A clustered column chart with two series and an axis title (not part of the table).
const bar = chartSpace(
  `${title('Samples per quarter')}<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series(0, 'North site', quarters, [12, 18, 25, 9])}${series(1, 'South site', quarters, [7, 11, 30, 14])}<c:gapWidth val="150"/>${axes}</c:barChart>${axisPair('Samples')}</c:plotArea><c:legend><c:legendPos val="r"/></c:legend>`,
);
// A line chart without a title, whose second series misses one cached point.
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];
const line = chartSpace(
  `<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series(0, 'Salinity', months, [31.2, 30.8, 29.5, 28.9, 30.1])}${series(1, 'Temperature', months, [8.5, 9.1, undefined, 13.4, 15.8])}<c:marker val="1"/>${axes}</c:lineChart>${axisPair()}</c:plotArea>`,
);
// A pie chart with one series.
const pie = chartSpace(
  `${title('Sample types')}<c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/>${series(0, 'Share', ['Water', 'Sediment', 'Biota'], [55, 30, 15])}<c:firstSliceAng val="0"/></c:pieChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend>`,
);

const charts = [bar, line, pie];
const titles = ['Samples', 'Conditions', 'Mix'];
const slides = titles.map((text, index) =>
  slide([
    shape({ ph: '<p:ph type="title"/>', x: 500000, y: 300000, text }),
    shape({ x: 500000, y: 5600000, text: `Chart ${index + 1} of 3, synthetic data.` }),
    chartFrame('rIdChart', 1200000),
  ]),
);

const files = {
  '[Content_Types].xml': xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="${CT}.presentationml.slide+xml"/>`).join('')}${charts.map((_, index) => `<Override PartName="/ppt/charts/chart${index + 1}.xml" ContentType="${CT}.drawingml.chart+xml"/>`).join('')}</Types>`,
  ),
  '_rels/.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  ),
  'ppt/presentation.xml': xml(
    `<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  ),
  'ppt/_rels/presentation.xml.rels': xml(
    `<Relationships xmlns="${PKG}">${slides.map((_, index) => `<Relationship Id="rIdSlide${index + 1}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
  ),
};
slides.forEach((content, index) => {
  files[`ppt/slides/slide${index + 1}.xml`] = content;
  files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rIdChart" Type="${R}/chart" Target="../charts/chart${index + 1}.xml"/></Relationships>`,
  );
  files[`ppt/charts/chart${index + 1}.xml`] = charts[index];
  files[`ppt/charts/_rels/chart${index + 1}.xml.rels`] = xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/package" Target="../embeddings/Missing_Workbook${index + 1}.xlsx"/></Relationships>`,
  );
});
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/pptx/charts.pptx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/pptx/charts.pptx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-pptx-charts.mjs\nRequirements: PPT-6\nNotes: a clustered column chart with two series and an axis title, a line chart without a title whose second series misses a cached point, and a pie chart; each chart keeps only cached values and its embedded workbook is absent.\n',
);
