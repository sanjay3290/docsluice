# Subtitles (SRT and VTT)

SRT and WebVTT readers emit one paragraph per cue. The cue's timestamp range is stored in `loc.path` in the form `start --> end`. SRT comma milliseconds and VTT decimal milliseconds are recognized. Cue identifiers are skipped; cue text is retained with line breaks. VTT `NOTE`, `STYLE`, and `REGION` blocks are ignored. This is not a full subtitle markup parser.
