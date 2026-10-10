# WebVTT (VTT)

The WebVTT reader (`docsluice/vtt`) shares the [SubRip](srt.md) cue logic: one paragraph per cue with the time range (`hh:mm:ss.mmm-hh:mm:ss.mmm`) as `loc.path`.

- Times may leave out the hours (`00:01.000`). Cue identifiers and cue settings (`align:start line:0`) are not text.
- The `WEBVTT` header block and `NOTE`, `STYLE` and `REGION` blocks have no timing line and are not content (no warning).
- Voice (`<v Ada>`), class (`<c.x>`), language, ruby, formatting and timestamp (`<00:00:07.000>`) tags are removed; entities are decoded as in SubRip.

Detection: content starting with `WEBVTT` followed by a space, tab or line end. `hostile/vtt` holds tag soup (`<` and `&` floods), read in linear time.
