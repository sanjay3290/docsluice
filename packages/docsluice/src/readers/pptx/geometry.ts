import type { Budget } from '../../core/budget.js';
import type { XmlElement } from '../../xml/index.js';

export const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export interface Point {
  x: number;
  y: number;
}

export interface Transform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export const IDENTITY_TRANSFORM: Transform = { sx: 1, sy: 1, tx: 0, ty: 0 };

export function isElement(
  value: XmlElement | string,
  namespace: string,
  localName: string,
): value is XmlElement {
  return typeof value !== 'string' && value.namespaceURI === namespace && value.localName === localName;
}

export function directChild(
  parent: XmlElement,
  namespace: string,
  localName: string,
  budget: Budget,
): XmlElement | undefined {
  for (const child of parent.children) {
    budget.tick();
    if (isElement(child, namespace, localName)) return child;
  }
  return undefined;
}

export function* directChildren(
  parent: XmlElement,
  namespace: string,
  localName: string,
  budget: Budget,
): IterableIterator<XmlElement> {
  for (const child of parent.children) {
    budget.tick();
    if (isElement(child, namespace, localName)) yield child;
  }
}

export function safeInteger(value: string | undefined, budget: Budget): number | undefined {
  if (value === undefined) return undefined;
  for (let index = 0; index < value.length; index += 1) budget.tick();
  if (!/^-?\d+$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function transformElement(
  element: XmlElement | undefined,
  budget: Budget,
): {
  point?: Point;
  scale?: Point;
} {
  if (!element) return {};
  const off = directChild(element, DRAWING_NS, 'off', budget);
  const ext = directChild(element, DRAWING_NS, 'ext', budget);
  const chExt = directChild(element, DRAWING_NS, 'chExt', budget);
  const x = safeInteger(off?.attrs.get('x'), budget);
  const y = safeInteger(off?.attrs.get('y'), budget);
  const cx = safeInteger(ext?.attrs.get('cx'), budget);
  const cy = safeInteger(ext?.attrs.get('cy'), budget);
  const chcx = safeInteger(chExt?.attrs.get('cx'), budget);
  const chcy = safeInteger(chExt?.attrs.get('cy'), budget);
  return {
    ...(x !== undefined && y !== undefined ? { point: { x, y } } : {}),
    ...(cx !== undefined && cy !== undefined && chcx !== undefined && chcy !== undefined
      ? { scale: { x: chcx === 0 ? Number.NaN : cx / chcx, y: chcy === 0 ? Number.NaN : cy / chcy } }
      : {}),
  };
}

function shapeTransformElement(shape: XmlElement, budget: Budget): XmlElement | undefined {
  const propertyName = shape.localName === 'graphicFrame' ? 'xfrm' : 'spPr';
  const propertyNamespace = PRESENTATION_NS;
  const property = directChild(shape, propertyNamespace, propertyName, budget);
  if (!property) return undefined;
  if (propertyName === 'xfrm') return property;
  return directChild(property, DRAWING_NS, 'xfrm', budget);
}

export function shapePosition(shape: XmlElement, budget: Budget): Point | undefined {
  const info = transformElement(shapeTransformElement(shape, budget), budget);
  return info.point;
}

export function shapePointInParent(shape: XmlElement, parent: Transform, budget: Budget): Point | undefined {
  const point = shapePosition(shape, budget);
  if (!point) return undefined;
  return applyTransform(point, parent);
}

export function groupTransform(group: XmlElement, parent: Transform, budget: Budget): Transform {
  const properties = directChild(group, PRESENTATION_NS, 'grpSpPr', budget);
  const xfrm = properties ? directChild(properties, DRAWING_NS, 'xfrm', budget) : undefined;
  const info = transformElement(xfrm, budget);
  const off = info.point;
  const scale = info.scale;
  if (!off || !scale || !Number.isFinite(scale.x) || !Number.isFinite(scale.y)) return parent;
  const chOff = directChild(xfrm!, DRAWING_NS, 'chOff', budget);
  const childX = safeInteger(chOff?.attrs.get('x'), budget) ?? 0;
  const childY = safeInteger(chOff?.attrs.get('y'), budget) ?? 0;
  const composed = {
    sx: parent.sx * scale.x,
    sy: parent.sy * scale.y,
    tx: parent.sx * (off.x - childX * scale.x) + parent.tx,
    ty: parent.sy * (off.y - childY * scale.y) + parent.ty,
  };
  return Object.values(composed).every(Number.isFinite) ? composed : parent;
}

export function applyTransform(point: Point, transform: Transform): Point | undefined {
  const transformed = { x: transform.sx * point.x + transform.tx, y: transform.sy * point.y + transform.ty };
  return Number.isFinite(transformed.x) && Number.isFinite(transformed.y) ? transformed : undefined;
}

export function placeholderKey(type: string, index: string): string {
  return `${type}\u0000${index}`;
}

export function placeholderInfo(
  shape: XmlElement,
  budget: Budget,
): { type: string; index: string } | undefined {
  const nv = directChild(shape, PRESENTATION_NS, 'nvSpPr', budget);
  const nvPr = nv ? directChild(nv, PRESENTATION_NS, 'nvPr', budget) : undefined;
  const placeholder = nvPr ? directChild(nvPr, PRESENTATION_NS, 'ph', budget) : undefined;
  if (!placeholder) return undefined;
  const type = placeholder.attrs.get('type') ?? 'obj';
  const index = placeholder.attrs.get('idx') ?? '0';
  return { type, index };
}
