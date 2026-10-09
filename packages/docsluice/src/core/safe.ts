const nullProtoRecordBrand: unique symbol = Symbol('NullProtoRecord');

/** A record created with a null prototype and therefore safe for dynamic keys. */
export type NullProtoRecord<T extends Record<string, unknown>> = T & {
  readonly [nullProtoRecordBrand]: true;
};

/** Creates a record whose dynamic keys cannot affect Object.prototype. */
export function createNullProtoRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(): NullProtoRecord<T> {
  return Object.create(null) as NullProtoRecord<T>;
}
