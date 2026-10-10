import type { Budget } from '../../core/budget.js';

/**
 * Office Math (ECMA-376 Part 1, 22.1) as linear text (DOC-11): fractions `a/b`, scripts `x^2`
 * and `x_i`, radicals `√(x)`, n-ary operators `∑_(i=1)^n i`, delimiters `(a|b)` and matrices
 * row by row `[1, 0; 0, 1]`. Elements arrive as SAX events; each open element is a node on an
 * explicit stack, so nesting never recurses (SEC-8).
 */

/** Elements whose text is an argument of the enclosing structure rather than inline text. */
const ARGUMENTS = new Set(['e', 'num', 'den', 'sub', 'sup', 'deg', 'fName', 'lim', 'mr', 'oMath']);

interface MathNode {
  name: string;
  text: string;
  args: Array<[string, string]>;
  /** Property values from the element's `m:*Pr` child (`chr`, `begChr`, `degHide`...). */
  props: Map<string, string | undefined>;
}

export class MathBuilder {
  readonly #budget: Budget;
  readonly #stack: MathNode[] = [];

  constructor(budget: Budget) {
    this.#budget = budget;
  }

  /** Open a node for an Office Math element. Always `true`: the caller closes it later. */
  open(name: string): boolean {
    this.#budget.tick();
    // Content outside `m:oMath` (a stray `m:e` in a run) has no equation to join.
    if (this.#stack.length === 0 && name !== 'oMath' && name !== 'oMathPara') return false;
    this.#stack.push({ name, text: '', args: [], props: new Map() });
    return true;
  }

  /** A property of the innermost structure, from `m:chr m:val="∑"` and similar. */
  property(name: string, value: string | undefined): void {
    this.#budget.tick();
    this.#stack.at(-1)?.props.set(name, value);
  }

  text(text: string): void {
    this.#budget.tick();
    const node = this.#stack.at(-1);
    if (node) node.text += text;
  }

  /** Close the innermost node. Returns the equation's text when the outermost node closes. */
  close(): string | undefined {
    this.#budget.tick();
    const node = this.#stack.pop();
    if (!node) return undefined;
    const parent = this.#stack.at(-1);
    // A matrix that is the whole content of a delimiter takes the delimiter's brackets.
    const bare = node.name === 'm' && parent?.name === 'e' && this.#stack.at(-2)?.name === 'd';
    const text = this.#render(node, bare);
    if (!parent) return text;
    if (ARGUMENTS.has(node.name)) parent.args.push([node.name, text]);
    else parent.text += text;
    return undefined;
  }

  #render(node: MathNode, bare: boolean): string {
    const arg = (name: string): string => {
      for (const [key, value] of node.args) {
        this.#budget.tick();
        if (key === name) return value;
      }
      return '';
    };
    const all = (name: string): string[] => {
      const values: string[] = [];
      for (const [key, value] of node.args) {
        this.#budget.tick();
        if (key === name) values.push(value);
      }
      return values;
    };
    const prop = (name: string, fallback: string): string =>
      node.props.has(name) ? (node.props.get(name) ?? fallback) : fallback;
    const on = (name: string): boolean => {
      if (!node.props.has(name)) return false;
      const value = node.props.get(name);
      return value === undefined || value === '1' || value === 'on' || value === 'true';
    };
    const scripts = (sub: string, sup: string): string =>
      (sub ? `_${wrap(sub, this.#budget)}` : '') + (sup ? `^${wrap(sup, this.#budget)}` : '');
    switch (node.name) {
      case 'f':
        return `${wrap(arg('num'), this.#budget)}/${wrap(arg('den'), this.#budget)}`;
      case 'sSup':
        return wrap(arg('e'), this.#budget) + scripts('', arg('sup'));
      case 'sSub':
        return wrap(arg('e'), this.#budget) + scripts(arg('sub'), '');
      case 'sSubSup':
        return wrap(arg('e'), this.#budget) + scripts(arg('sub'), arg('sup'));
      case 'sPre':
        return scripts(arg('sub'), arg('sup')) + wrap(arg('e'), this.#budget);
      case 'rad': {
        const degree = on('degHide') ? '' : arg('deg');
        const sign = degree === '' ? '√' : degree === '3' ? '∛' : degree === '4' ? '∜' : `√[${degree}]`;
        return `${sign}(${arg('e')})`;
      }
      case 'nary': {
        const sub = on('subHide') ? '' : arg('sub');
        const sup = on('supHide') ? '' : arg('sup');
        const body = arg('e');
        // The default operator is the integral (22.1.2.20).
        return prop('chr', '∫') + scripts(sub, sup) + (body ? ` ${body}` : '');
      }
      case 'd':
        return prop('begChr', '(') + all('e').join(prop('sepChr', '|')) + prop('endChr', ')');
      case 'm': {
        const rows = all('mr').join('; ');
        return bare ? rows : `[${rows}]`;
      }
      case 'mr':
        return all('e').join(', ');
      case 'eqArr':
        return all('e').join('\n');
      case 'oMathPara':
        return all('oMath').join('\n') + node.text;
      case 'func': {
        const body = arg('e');
        return arg('fName') + (enclosed(body, this.#budget) ? body : `(${body})`);
      }
      case 'limLow':
        return arg('e') + scripts(arg('lim'), '');
      case 'limUpp':
        return arg('e') + scripts('', arg('lim'));
      case 'acc':
        // The default accent is a combining circumflex (22.1.2.20).
        return arg('e') + prop('chr', '̂');
      default: {
        // Arguments, `m:oMath`, and boxes, bars, group characters and phantoms: their content in order.
        let text = node.text;
        for (const [, value] of node.args) {
          this.#budget.tick();
          text += value;
        }
        return text;
      }
    }
  }
}

/** One character, a number, or text already in matching parentheses needs no parentheses. */
function wrap(text: string, budget: Budget): string {
  if (text.length <= 1 || enclosed(text, budget)) return text;
  for (let index = 0; index < text.length; index++) {
    budget.tick();
    const code = text.charCodeAt(index);
    if ((code < 48 || code > 57) && code !== 46) return `(${text})`;
  }
  return text;
}

/** `(…)` where the first parenthesis closes at the end, so `(a)+(b)` is not enclosed. */
function enclosed(text: string, budget: Budget): boolean {
  if (text.length < 2 || text[0] !== '(' || text.at(-1) !== ')') return false;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    budget.tick();
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0 && index < text.length - 1) return false;
    }
  }
  return depth === 0;
}
