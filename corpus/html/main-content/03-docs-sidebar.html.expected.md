Docs / Guide / Limits

- Introduction
- Limits
- Errors

# Configuring limits

Every extraction runs under a budget of bytes, cells, characters and time that callers can lower per call.

```
extract(bytes, { limits: { cells: 10000 } })
```

When a limit is reached, the reader stops and the document reports what was left out in its warnings.