# SubRip (SRT)

The SubRip reader (`docsluice/srt`) gives one paragraph per cue. Blocks are separated by blank lines; the timing line (`00:00:01,000 --> 00:00:04,200`) is the block's first or second line, and the lines after it are the cue text.

- The cue's time range is its `loc.path`, normalized to `hh:mm:ss.mmm-hh:mm:ss.mmm` (`00:00:01.000-00:00:04.200`). Inside a container the child path comes first (`subs/a.srt/00:00:01.000-00:00:02.000`).
- Formatting tags (`<i>`, `<b>`, `<font …>`) are removed and `&amp;`, `&lt;`, `&gt;`, `&nbsp;`, `&lrm;` and `&rlm;` decoded, in one linear pass.
- A block without a valid timing line is skipped; one `UNREADABLE_PART` warning gives the count. Cues without text are not emitted.

Detection: a cue number line followed by a SubRip timing line, or a `.srt` name on plain text. `hostile/srt` holds a large cue count and bad timings.
