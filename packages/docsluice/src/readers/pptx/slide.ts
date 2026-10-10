import type { Cell } from '../../core/model.js';
import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import {
  A_NS,
  C_NS,
  DGM_NS,
  MC_NS,
  namespacedAttribute,
  namespaceScope,
  P_NS,
  parseCoordinate,
  parseSmall,
  R_NS,
} from './presentationml.js';

const MAX_LEVEL = 8;
/** PowerPoint allows 75 columns and spans; wider spans are clamped. */
const MAX_SPAN = 75;

/** One `a:p` with its outline level and bullet (ECMA-376 Part 1, 21.1.2.2). */
export interface PptxParagraph {
  text: string;
  level: number;
  /** `inherit` means no `a:buNone`/`a:buChar`/`a:buAutoNum` on the paragraph itself. */
  bullet: 'inherit' | 'none' | 'char' | 'auto';
  char?: string;
  /** `a:buFont` is a symbol font (Wingdings, Symbol), whose glyphs sit on ordinary letters. */
  symbolFont?: boolean;
  autoType?: string;
  startAt?: number;
}

/** `p:ph`: `type` defaults to `obj`, as in the schema. */
export interface PptxPlaceholder {
  type: string;
  idx?: string;
}

/** A shape with text, a table, a SmartArt diagram or a chart, with its top-left corner on the slide (EMU). */
export interface PptxShape {
  kind: 'text' | 'table' | 'diagram' | 'chart';
  /** Position in the shape tree, used to keep ties in document order. */
  order: number;
  x?: number;
  y?: number;
  placeholder?: PptxPlaceholder;
  paragraphs: PptxParagraph[];
  rows?: Cell[][];
  headerRows?: number;
  /** Relationship id of the diagram data part (`dgm:relIds r:dm`). */
  diagramData?: string;
  /** Relationship id of the chart part (`c:chart r:id`). */
  chartPart?: string;
}

export interface PptxSlideContent {
  shapes: PptxShape[];
  /** True when groups nested deeper than `blockDepth`; their transforms were not applied. */
  depthLimited: boolean;
  /** `p:sld show="0"`: the slide is hidden in a slide show (PPT-5). */
  hidden: boolean;
}

interface Transform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

interface Xfrm {
  off?: [number, number];
  ext?: [number, number];
  chOff?: [number, number];
  chExt?: [number, number];
}

interface Frame {
  ns: string | undefined;
  local: string;
  skipped: boolean;
  shape?: boolean;
  group?: boolean;
  /** Set on `a:xfrm`/`p:xfrm` frames: where its `a:off`, `a:ext` … children go. */
  xfrm?: Xfrm;
  groupXfrm?: Xfrm;
  text?: boolean;
}

interface CellState {
  paragraphs: string[];
  gridSpan: number;
  rowSpan: number;
  merged: boolean;
}

const IDENTITY: Transform = { sx: 1, sy: 1, tx: 0, ty: 0 };

function compose(parent: Transform, xfrm: Xfrm): Transform {
  const [ox, oy] = xfrm.off ?? [0, 0];
  const [cx, cy] = xfrm.ext ?? [0, 0];
  const [chx, chy] = xfrm.chOff ?? [ox, oy];
  const [chcx, chcy] = xfrm.chExt ?? [cx, cy];
  const sx = chcx > 0 && cx > 0 ? cx / chcx : 1;
  const sy = chcy > 0 && cy > 0 ? cy / chcy : 1;
  return {
    sx: parent.sx * sx,
    sy: parent.sy * sy,
    tx: parent.sx * (ox - chx * sx) + parent.tx,
    ty: parent.sy * (oy - chy * sy) + parent.ty,
  };
}

/**
 * Parse a slide, layout or master part with bounded SAX events into its shapes (PPT-3). Group
 * transforms (`a:chOff`/`a:chExt` scaling) are applied so each shape has a slide position. Groups
 * nested deeper than `blockDepth` keep their parent's transform. `mc:Choice` is skipped and
 * `mc:Fallback` read. Nothing here recurses: groups are tracked with explicit stacks (SEC-8).
 */
export function parseSlide(input: Uint8Array, ctx: XmlContext): PptxSlideContent {
  const shapes: PptxShape[] = [];
  const frames: Frame[] = [];
  const scopes: Map<string, string>[] = [];
  const transforms: Transform[] = [IDENTITY];
  const maxGroupDepth = ctx.budget.limits.blockDepth;
  let groupDepth = 0;
  let depthLimited = false;
  let hidden = false;
  let order = 0;
  let shape: PptxShape | undefined;
  let shapeXfrm: Xfrm | undefined;
  let paragraph: PptxParagraph | undefined;
  let row: Cell[] | undefined;
  let cell: CellState | undefined;
  let tableFull = false;

  const finishCell = (state: CellState): void => {
    if (!shape?.rows || !row || tableFull) return;
    if (!ctx.budget.addCells(1)) {
      tableFull = true;
      return;
    }
    const value: Cell = { text: state.merged ? '' : state.paragraphs.join('\n') };
    if (!state.merged && state.rowSpan > 1) value.rowSpan = Math.min(state.rowSpan, MAX_SPAN);
    if (!state.merged && state.gridSpan > 1) value.colSpan = Math.min(state.gridSpan, MAX_SPAN);
    row.push(value);
  };

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        scopes.push(namespaceScope(attrs, ctx.budget));
        const parent = frames.at(-1);
        const ns = info.namespaceURI;
        const local = info.localName;
        const skipped = (parent?.skipped ?? false) || (ns === MC_NS && local === 'Choice');
        const frame: Frame = { ns, local, skipped };
        if (!parent && ns === P_NS && local === 'sld') {
          const show = attrs.get('show');
          hidden = show === '0' || show === 'false';
        }
        frames.push(frame);
        if (skipped) return;
        const parentLocal = parent?.ns === P_NS || parent?.ns === A_NS ? parent.local : undefined;

        if (ns === P_NS) {
          switch (local) {
            case 'grpSp':
              groupDepth++;
              if (groupDepth > maxGroupDepth) {
                depthLimited = true;
              } else {
                transforms.push(transforms.at(-1)!);
                frame.group = true;
              }
              return;
            case 'sp':
            case 'graphicFrame':
            case 'cxnSp':
            case 'pic':
              if (shape) return;
              shape = { kind: 'text', order: order++, paragraphs: [] };
              shapeXfrm = undefined;
              frame.shape = true;
              return;
            case 'ph':
              if (shape && !shape.placeholder) {
                shape.placeholder = { type: attrs.get('type') ?? 'obj' };
                const idx = attrs.get('idx');
                if (idx !== undefined) shape.placeholder.idx = idx;
              }
              return;
            case 'xfrm':
              if (shape && parentLocal === 'graphicFrame' && !shapeXfrm) frame.xfrm = shapeXfrm = {};
              return;
          }
          return;
        }
        if (ns === DGM_NS && local === 'relIds' && shape) {
          const id = namespacedAttribute(attrs, 'dm', R_NS, scopes, ctx.budget);
          if (id !== undefined) {
            shape.kind = 'diagram';
            shape.diagramData = id;
          }
          return;
        }
        if (ns === C_NS && local === 'chart' && shape && shape.kind === 'text') {
          const id = namespacedAttribute(attrs, 'id', R_NS, scopes, ctx.budget);
          if (id !== undefined) {
            shape.kind = 'chart';
            shape.chartPart = id;
          }
          return;
        }
        if (ns !== A_NS) return;
        switch (local) {
          case 'xfrm':
            if (parentLocal === 'grpSpPr' && frames.at(-3)?.group) {
              frame.xfrm = frames.at(-3)!.groupXfrm = {};
            } else if (shape && parentLocal === 'spPr' && !shapeXfrm) {
              frame.xfrm = shapeXfrm = {};
            }
            return;
          case 'off':
          case 'ext':
          case 'chOff':
          case 'chExt': {
            const target = parent?.xfrm;
            if (!target) return;
            const first = parseCoordinate(attrs.get(local === 'off' || local === 'chOff' ? 'x' : 'cx'));
            const second = parseCoordinate(attrs.get(local === 'off' || local === 'chOff' ? 'y' : 'cy'));
            if (first === undefined || second === undefined) return;
            if (local === 'off') target.off = [first, second];
            else if (local === 'ext') target.ext = [first, second];
            else if (local === 'chOff') target.chOff = [first, second];
            else target.chExt = [first, second];
            return;
          }
          case 'p':
            if (shape) paragraph = { text: '', level: 0, bullet: 'inherit' };
            return;
          case 'pPr':
            if (paragraph && parentLocal === 'p') {
              paragraph.level = Math.min(parseSmall(attrs.get('lvl'), 99) ?? 0, MAX_LEVEL);
            }
            return;
          case 'buNone':
            if (paragraph && parentLocal === 'pPr') paragraph.bullet = 'none';
            return;
          case 'buFont':
            if (paragraph && parentLocal === 'pPr') {
              const face = (attrs.get('typeface') ?? '').toLowerCase();
              if (face.startsWith('wingdings') || face === 'symbol' || face.startsWith('webdings')) {
                paragraph.symbolFont = true;
              }
            }
            return;
          case 'buChar':
            if (paragraph && parentLocal === 'pPr') {
              paragraph.bullet = 'char';
              const char = attrs.get('char');
              if (char !== undefined) paragraph.char = char.slice(0, 4);
            }
            return;
          case 'buAutoNum':
            if (paragraph && parentLocal === 'pPr') {
              paragraph.bullet = 'auto';
              paragraph.autoType = attrs.get('type') ?? 'arabicPeriod';
              const startAt = parseSmall(attrs.get('startAt'), 32_767);
              if (startAt !== undefined) paragraph.startAt = startAt;
            }
            return;
          case 't':
            if (paragraph && (parentLocal === 'r' || parentLocal === 'fld')) frame.text = true;
            return;
          case 'br':
            if (paragraph && parentLocal === 'p') paragraph.text += '\n';
            return;
          case 'tbl':
            if (shape && !shape.rows) {
              shape.kind = 'table';
              shape.rows = [];
              shape.headerRows = 0;
            }
            return;
          case 'tblPr':
            if (shape?.rows && parentLocal === 'tbl') {
              const firstRow = attrs.get('firstRow');
              if (firstRow === '1' || firstRow === 'true') shape.headerRows = 1;
            }
            return;
          case 'tr':
            if (shape?.rows && parentLocal === 'tbl') row = [];
            return;
          case 'tc':
            if (row && parentLocal === 'tr') {
              const flag = (name: string): boolean => attrs.get(name) === '1' || attrs.get(name) === 'true';
              cell = {
                paragraphs: [],
                gridSpan: parseSmall(attrs.get('gridSpan'), 999_999) ?? 1,
                rowSpan: parseSmall(attrs.get('rowSpan'), 999_999) ?? 1,
                merged: flag('hMerge') || flag('vMerge'),
              };
            }
            return;
        }
      },
      onText(text) {
        const frame = frames.at(-1);
        if (frame?.text && !frame.skipped && paragraph) paragraph.text += text;
      },
      onClose() {
        ctx.budget.tick();
        const frame = frames.pop();
        scopes.pop();
        if (!frame || frame.skipped) return;
        if (frame.ns === P_NS) {
          if (frame.local === 'grpSp') {
            if (frame.group) transforms.pop();
            groupDepth--;
          } else if (frame.shape && shape) {
            const offset = shapeXfrm?.off;
            if (offset) {
              const transform = transforms.at(-1)!;
              shape.x = transform.sx * offset[0] + transform.tx;
              shape.y = transform.sy * offset[1] + transform.ty;
            }
            shapes.push(shape);
            shape = undefined;
            shapeXfrm = undefined;
          }
          return;
        }
        if (frame.ns !== A_NS) return;
        if (frame.local === 'xfrm' && frame.xfrm && frame.xfrm !== shapeXfrm) {
          // A group's own transform, applied to everything inside it.
          transforms[transforms.length - 1] = compose(transforms.at(-2) ?? IDENTITY, frame.xfrm);
        } else if (frame.local === 'p' && paragraph) {
          if (cell) cell.paragraphs.push(paragraph.text);
          else shape?.paragraphs.push(paragraph);
          paragraph = undefined;
        } else if (frame.local === 'tc' && cell) {
          finishCell(cell);
          cell = undefined;
        } else if (frame.local === 'tr' && row) {
          if (row.length > 0) shape?.rows?.push(row);
          row = undefined;
        }
      },
    },
    ctx,
  );
  return { shapes, depthLimited, hidden };
}
