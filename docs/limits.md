# Limits

Every extraction runs under these limits. A document and all of its children share one budget, so an attachment cannot reset them. Change them per call with `limits`:

```js
await extract(bytes, { limits: { cells: 100_000, timeMs: 5_000 } });
```

When a limit is reached, docsluice stops reading, keeps what it has, sets `stats.truncated`, and adds a `TRUNCATED` or `DEPTH_LIMIT` warning. With `onLimit: 'throw'` it throws `LimitExceededError` instead. `inputBytes` and `compressionRatio` always throw: a partial bomb is still a bomb.

<!-- limits-table -->

The values come from `DEFAULT_LIMITS`, which is exported. The site generator builds this table from the package itself.
