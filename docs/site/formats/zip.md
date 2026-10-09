# ZIP archives

**Status:** low-level archive indexing only. `openZip()` validates and indexes ZIP entries under the supplied budget, and readers can request bounded entry data. The default extraction registry has no ZIP container reader, so `extract()` does not emit archive children.
