import { afterAll, describe, it } from 'vitest';
import tseslint from 'typescript-eslint';
import { RuleTester } from '@typescript-eslint/rule-tester';
import type { RuleModule } from '@typescript-eslint/utils/ts-eslint';
// @ts-expect-error The local rule is JavaScript, so its test supplies the module type.
import ruleImplementation from '../../../../tools/eslint-rules/no-computed-object-key.js';

const rule = ruleImplementation as RuleModule<
  'unsafeComputedKey' | 'unsafeObjectAssign' | 'unsafeObjectSpread'
>;

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: { allowDefaultProject: ['*.ts'] },
      tsconfigRootDir: new URL('.', import.meta.url).pathname,
    },
  },
});

ruleTester.run('no-computed-object-key', rule, {
  valid: [
    { code: 'const items: number[] = []; items[index] = 1; items[index];' },
    { code: 'const bytes = new Uint8Array(4); bytes[index] = 1; bytes[index];' },
    { code: 'const values = new Map<string, number>(); values[key] = 1; values[key];' },
    { code: 'const values = new Set<string>(); values[key];' },
    {
      code: 'type BuiltinMap = globalThis.Map<string, number>; declare const values: BuiltinMap; values[key];',
    },
    {
      code: 'type BuiltinBytes = globalThis.Uint8Array; declare const bytes: BuiltinBytes; bytes[index];',
    },
    { code: 'const tuple: [string, number] = ["", 0]; tuple[index];' },
    { code: 'declare const choices: number[] | [number]; choices[index];' },
    { code: 'const text = "value"; text[index];' },
    { code: 'const record = Object.create(null); record[key] = value; record[key];' },
    {
      code: `import type { NullProtoRecord } from '../../src/core/safe.js';
        declare const record: NullProtoRecord<Record<string, unknown>>;
        record[key] = value;
        record[key];`,
    },
    { code: 'const record = {}; record["name"]; record[0] = "safe";' },
  ],
  invalid: [
    {
      code: 'const record: Record<string, unknown> = {}; record[key] = value;',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'const record: Record<string, unknown> = {}; record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'declare const record: Record<string, unknown>; let value: unknown; value = record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'type NullProtoRecord<T> = T; declare const record: NullProtoRecord<Record<string, unknown>>; record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'export {}; type Map = Record<string, unknown>; declare const record: Map; declare const fileKey: string; record[fileKey] = "x";',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'export {}; interface Set { [key: string]: unknown } declare const record: Set; declare const fileKey: string; record[fileKey];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'export {}; type Uint8Array = Record<string, unknown>; declare const record: Uint8Array; declare const fileKey: string; record[fileKey] = "x";',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'declare const record: { safe: string } | Record<string, string>; record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'declare const record: number[] | Record<string, number>; record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'declare const record: any; record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'declare const record: unknown; record[key];',
      errors: [{ messageId: 'unsafeComputedKey' }],
    },
    {
      code: 'declare const target: object; declare const source: any; Object.assign(target, source);',
      errors: [{ messageId: 'unsafeObjectAssign' }],
    },
    {
      code: 'declare const source: unknown; const copy = { ...source };',
      errors: [{ messageId: 'unsafeObjectSpread' }],
    },
    {
      code: 'declare const source: any; const copy = { ...source };',
      errors: [{ messageId: 'unsafeObjectSpread' }],
    },
  ],
});
