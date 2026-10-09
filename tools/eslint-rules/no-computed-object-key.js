import ts from 'typescript';
import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator.withoutDocs;
const SAFE_INDEXABLE_NAMES = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Map',
  'ReadonlyMap',
  'Set',
  'ReadonlySet',
]);

function isLiteralKey(node) {
  return node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number');
}

function isNullProtoRecordType(type) {
  return (
    type.aliasSymbol?.getName() === 'NullProtoRecord' &&
    type.aliasSymbol.declarations?.some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .endsWith('/packages/docsluice/src/core/safe.ts'),
    )
  );
}

function isSafeGlobalCollectionOrTypedArray(type, program) {
  const symbol = type.getSymbol();
  return (
    SAFE_INDEXABLE_NAMES.has(symbol?.getName()) &&
    symbol.declarations?.some((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    )
  );
}

function isSafeType(type, checker, program) {
  if (type.isUnion()) {
    return type.types.every((part) => isSafeType(part, checker, program));
  }

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return false;
  }

  if (isNullProtoRecordType(type)) return true;

  if (type.flags & ts.TypeFlags.StringLike) {
    return true;
  }

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return true;
  }

  return isSafeGlobalCollectionOrTypedArray(type, program);
}

function hasAnyOrUnknown(type) {
  if (type.isUnion()) {
    return type.types.some(hasAnyOrUnknown);
  }
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

function isObjectCreateNullTs(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.Identifier &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'create' &&
    node.arguments[0]?.kind === ts.SyntaxKind.NullKeyword
  );
}

function isConstNullProtoRecord(node, checker, seen = new Set()) {
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    !declaration.initializer ||
    seen.has(symbol)
  ) {
    return false;
  }
  seen.add(symbol);
  if (isObjectCreateNullTs(declaration.initializer)) return true;
  return ts.isIdentifier(declaration.initializer)
    ? isConstNullProtoRecord(declaration.initializer, checker, seen)
    : false;
}

function isObjectAssign(node) {
  return (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Object' &&
    node.callee.property.name === 'assign'
  );
}

export default createRule({
  name: 'no-computed-object-key',
  meta: {
    type: 'problem',
    docs: { description: 'Disallow computed keys on unsafe plain objects.' },
    schema: [],
    messages: {
      unsafeComputedKey: 'Computed keys require an array, collection, string, or null-prototype record.',
      unsafeObjectAssign: 'Object.assign cannot copy values typed as any or unknown.',
      unsafeObjectSpread: 'Object spread cannot copy values typed as any or unknown.',
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      MemberExpression(node) {
        if (!node.computed || isLiteralKey(node.property)) return;

        if (isConstNullProtoRecord(services.esTreeNodeToTSNodeMap.get(node.object), checker)) return;
        const type = services.getTypeAtLocation(node.object);
        if (!isSafeType(type, checker, services.program)) {
          context.report({ node, messageId: 'unsafeComputedKey' });
        }
      },

      CallExpression(node) {
        if (!isObjectAssign(node)) return;
        if (node.arguments.some((argument) => hasAnyOrUnknown(services.getTypeAtLocation(argument)))) {
          context.report({ node, messageId: 'unsafeObjectAssign' });
        }
      },

      SpreadElement(node) {
        if (node.parent.type !== 'ObjectExpression') return;
        if (hasAnyOrUnknown(services.getTypeAtLocation(node.argument))) {
          context.report({ node, messageId: 'unsafeObjectSpread' });
        }
      },
    };
  },
});
