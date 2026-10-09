import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modelPath = join(packageRoot, 'src/core/model.ts');
const packagePath = join(packageRoot, 'package.json');
const outputPath = join(packageRoot, 'schema.json');
const modelText = readFileSync(modelPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const sourceFile = ts.createSourceFile(modelPath, modelText, ts.ScriptTarget.Latest, true);

const declarations = new Map();
for (const statement of sourceFile.statements) {
  if (
    (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
    statement.name &&
    isExported(statement)
  ) {
    declarations.set(statement.name.text, statement);
  }
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function reference(name) {
  return { $ref: `#/$defs/${name}` };
}

function combineUnion(schemas) {
  // A broad string member subsumes any literal alternatives, as it does in TypeScript.
  if (
    schemas.some((schema) => schema.type === 'string' && !('const' in schema)) &&
    schemas.every((schema) => schema.type === 'string' || typeof schema.const === 'string')
  ) {
    return { type: 'string' };
  }
  if (schemas.length === 1) return schemas[0];
  return { anyOf: schemas };
}

function convertType(typeNode) {
  if (ts.isParenthesizedTypeNode(typeNode)) return convertType(typeNode.type);
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' };
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' };
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' };
  if (typeNode.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword || typeNode.kind === ts.SyntaxKind.VoidKeyword)
    return {};
  if (ts.isLiteralTypeNode(typeNode)) {
    const literal = typeNode.literal;
    if (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal)) {
      return { const: ts.isStringLiteral(literal) ? literal.text : Number(literal.text) };
    }
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { const: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { const: false };
    if (literal.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
  }
  if (ts.isUnionTypeNode(typeNode)) return combineUnion(typeNode.types.map(convertType));
  if (ts.isIntersectionTypeNode(typeNode)) {
    const members = typeNode.types.map(convertType);
    // TypeScript's `string & {}` is a common idiom for retaining literal completions
    // while allowing plugins to add arbitrary string ids.
    if (members.some((member) => member.type === 'string')) return { type: 'string' };
    return { allOf: members };
  }
  if (ts.isArrayTypeNode(typeNode)) return { type: 'array', items: convertType(typeNode.elementType) };
  if (ts.isTupleTypeNode(typeNode)) {
    const items = typeNode.elements.map((element) =>
      ts.isNamedTupleMember(element) ? convertType(element.type) : convertType(element),
    );
    return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length };
  }
  if (ts.isTypeLiteralNode(typeNode)) return objectSchema(typeNode.members);
  if (ts.isIndexedAccessTypeNode(typeNode)) return convertIndexedAccess(typeNode);
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText(sourceFile);
    if (name === 'Array' || name === 'ReadonlyArray') {
      const item = typeNode.typeArguments?.[0];
      return { type: 'array', items: item ? convertType(item) : {} };
    }
    if (name === 'Uint8Array') return { type: 'string', contentEncoding: 'base64' };
    if (name === 'Record') {
      const valueType = typeNode.typeArguments?.[1];
      return { type: 'object', additionalProperties: valueType ? convertType(valueType) : {} };
    }
    if (name === 'Date') return { type: 'string', format: 'date-time' };
    if (declarations.has(name)) return reference(name);
    throw new Error(`Unsupported public model type reference: ${name}`);
  }
  if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return convertType(typeNode.type);
  }
  throw new Error(`Unsupported public model syntax: ${ts.SyntaxKind[typeNode.kind]}`);
}

function convertIndexedAccess(typeNode) {
  if (
    ts.isTypeReferenceNode(typeNode.objectType) &&
    ts.isLiteralTypeNode(typeNode.indexType) &&
    ts.isStringLiteral(typeNode.indexType.literal)
  ) {
    return propertyType(typeNode.objectType.typeName.getText(sourceFile), typeNode.indexType.literal.text);
  }
  throw new Error(`Unsupported indexed access in public model: ${typeNode.getText(sourceFile)}`);
}

function propertyType(typeName, propertyName) {
  const declaration = declarations.get(typeName);
  if (!declaration) throw new Error(`Unknown public model type: ${typeName}`);
  if (ts.isInterfaceDeclaration(declaration)) {
    const member = declaration.members.find(
      (candidate) =>
        ts.isPropertySignature(candidate) && candidate.name?.getText(sourceFile) === propertyName,
    );
    if (!member?.type) throw new Error(`Unknown property ${typeName}.${propertyName}`);
    return convertType(member.type);
  }
  if (ts.isUnionTypeNode(declaration.type)) {
    return combineUnion(
      declaration.type.types.map((memberType) => {
        if (!ts.isTypeReferenceNode(memberType)) {
          throw new Error(`Unsupported union member in ${typeName}: ${memberType.getText(sourceFile)}`);
        }
        return propertyType(memberType.typeName.getText(sourceFile), propertyName);
      }),
    );
  }
  throw new Error(`Cannot resolve property ${typeName}.${propertyName}`);
}

function objectSchema(members) {
  const properties = {};
  const required = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
    const name = member.name.text;
    properties[name] = convertType(member.type);
    if (!member.questionToken) required.push(name);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function convertDeclaration(declaration) {
  if (ts.isInterfaceDeclaration(declaration)) return objectSchema(declaration.members);
  return convertType(declaration.type);
}

const majorVersion = packageJson.version.split('.')[0];
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://github.com/sanjay3290/docsluice/schema/v${majorVersion}`,
  title: 'docsluice JSON document',
  description: 'The serialized document model returned by docsluice toJSON().',
  $ref: '#/$defs/DocsluiceDocument',
  $defs: Object.fromEntries(
    [...declarations.entries()].map(([name, declaration]) => [name, convertDeclaration(declaration)]),
  ),
};

const formatting = await prettier.resolveConfig(outputPath);
const generated = await prettier.format(JSON.stringify(schema), {
  ...formatting,
  filepath: outputPath,
  parser: 'json',
});
writeFileSync(outputPath, generated);
