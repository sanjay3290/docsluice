// Generate the JSON Schema (2020-12) of docsluice's JSON output from `src/core/model.ts` (MOD-2).
// The model's TypeScript declarations are the single source: interfaces become objects with
// `additionalProperties: false`, unions become `oneOf`/`enum`, TSDoc becomes `description`.
// Usage: node scripts/generate-schema.mjs [out-file]   (the build writes schema.json at the package
// root, where both `exports` and node10-style resolution find `docsluice/schema.json`)
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import ts from 'typescript';

const packageRoot = new URL('..', import.meta.url);

/** The JSON Schema for a `toJSON()` document of this package version. */
export function generateSchema() {
  const source = readFileSync(new URL('src/core/model.ts', packageRoot), 'utf8');
  const { version } = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
  const file = ts.createSourceFile('model.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      declarations.set(statement.name.text, statement);
  }
  const defs = {};
  const pending = ['DocsluiceDocument'];
  const queued = new Set(pending);
  const reference = (name) => {
    if (!declarations.has(name)) throw new Error(`model.ts: unknown type ${name}`);
    if (!queued.has(name)) {
      queued.add(name);
      pending.push(name);
    }
    return { $ref: `#/$defs/${name}` };
  };

  const describe = (node, schema) => {
    const comment = ts
      .getJSDocCommentsAndTags(node)
      .filter(ts.isJSDoc)
      .map((doc) => (typeof doc.comment === 'string' ? doc.comment : ts.getTextOfJSDocComment(doc.comment)))
      .filter(Boolean)
      .join('\n');
    return comment ? { description: comment.replaceAll(/\s+/g, ' ').trim(), ...schema } : schema;
  };

  const literal = (node) => {
    if (ts.isStringLiteral(node.literal)) return node.literal.text;
    if (ts.isNumericLiteral(node.literal)) return Number(node.literal.text);
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return null;
    throw new Error(`model.ts: unsupported literal ${node.getText()}`);
  };

  /** `string & {}`: TypeScript's way of keeping a literal union open to any string. */
  const isOpenString = (node) =>
    ts.isParenthesizedTypeNode(node) &&
    ts.isIntersectionTypeNode(node.type) &&
    node.type.types.some((part) => part.kind === ts.SyntaxKind.StringKeyword);

  const objectSchema = (members) => {
    const properties = {};
    const required = [];
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type)
        throw new Error('model.ts: only properties are supported');
      const name = member.name.getText();
      properties[name] = describe(member, convert(member.type));
      if (!member.questionToken) required.push(name);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  };

  function convert(node) {
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: 'string' };
      case ts.SyntaxKind.NumberKeyword:
        return { type: 'number' };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: 'boolean' };
      case ts.SyntaxKind.NullKeyword:
        return { type: 'null' };
    }
    if (ts.isLiteralTypeNode(node)) {
      const value = literal(node);
      return value === null ? { type: 'null' } : { const: value };
    }
    if (ts.isParenthesizedTypeNode(node)) return convert(node.type);
    if (ts.isArrayTypeNode(node)) return { type: 'array', items: convert(node.elementType) };
    if (ts.isTupleTypeNode(node)) {
      const items = node.elements.map((element) =>
        convert(ts.isNamedTupleMember(element) ? element.type : element),
      );
      return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length };
    }
    if (ts.isTypeLiteralNode(node)) return objectSchema(node.members);
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText();
      if (name === 'Array' && node.typeArguments?.length === 1)
        return { type: 'array', items: convert(node.typeArguments[0]) };
      // Raw child bytes are base64 text in JSON, and only with `toJSON(doc, { bytes: 'base64' })`.
      if (name === 'Uint8Array') return { type: 'string', contentEncoding: 'base64' };
      return reference(name);
    }
    if (ts.isUnionTypeNode(node)) {
      const open = node.types.some(isOpenString);
      const parts = node.types.filter((part) => !isOpenString(part));
      if (parts.every((part) => ts.isLiteralTypeNode(part) && literal(part) !== null)) {
        const values = parts.map(literal);
        // An open union documents its known values and accepts any string.
        return open ? { type: 'string', examples: values } : { enum: values };
      }
      const keywords = new Map([
        [ts.SyntaxKind.StringKeyword, 'string'],
        [ts.SyntaxKind.NumberKeyword, 'number'],
        [ts.SyntaxKind.BooleanKeyword, 'boolean'],
      ]);
      const primitive = (part) =>
        keywords.get(part.kind) ??
        (ts.isLiteralTypeNode(part) && literal(part) === null ? 'null' : undefined);
      if (parts.every((part) => primitive(part) !== undefined)) return { type: parts.map(primitive) };
      return { oneOf: parts.map(convert) };
    }
    throw new Error(`model.ts: unsupported type ${node.getText()}`);
  }

  while (pending.length > 0) {
    const name = pending.shift();
    const declaration = declarations.get(name);
    defs[name] = describe(
      declaration,
      ts.isInterfaceDeclaration(declaration) ? objectSchema(declaration.members) : convert(declaration.type),
    );
  }
  const sorted = {};
  for (const name of Object.keys(defs).sort()) sorted[name] = defs[name];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:docsluice:schema:document:v${version.split('.')[0]}`,
    title: 'docsluice document',
    description: `The JSON form of a docsluice document (toJSON), docsluice ${version}. Generated from src/core/model.ts.`,
    $ref: '#/$defs/DocsluiceDocument',
    $defs: sorted,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? fileURLToPath(new URL('schema.json', packageRoot));
  writeFileSync(out, `${JSON.stringify(generateSchema(), null, 2)}\n`);
}
