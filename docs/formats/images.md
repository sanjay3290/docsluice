# Images

The format readers are registered lazily in the document extraction pipeline.
The public `imageGps` option defaults to `false` and can be enabled per call.

Image readers report an `image` block with dimensions when the container header
contains them, plus `metadata.custom` pairs named `image.width` and
`image.height` when metadata is enabled. They do not decode pixels or return text. PNG dimensions come
from IHDR, JPEG dimensions from a supported SOF marker, GIF dimensions from the
logical screen descriptor, TIFF dimensions from IFD0, and WebP dimensions from
VP8, VP8L, or VP8X headers.

When metadata is enabled, supported Exif values are read from JPEG APP1, TIFF,
and WebP EXIF chunks: DateTimeOriginal becomes `metadata.created` in a local
timestamp form without an invented timezone; Orientation, Make, and Model are
stored as `metadata.custom` pairs named `image.orientation`, `image.make`, and
`image.model`. Metadata is skipped when `metadata: false`. GPS values are
omitted unless the proposed `imageGps: true` option is enabled; when enabled,
latitude and longitude are reported as DMS strings in `image.gps.latitude` and
`image.gps.longitude` custom pairs.

TIFF IFD walks are iterative, track visited offsets, and validate directory
counts and external value ranges before reading. Malformed image structures
produce an `UNREADABLE_PART` warning with no source bytes or metadata values in
the warning. The reader never allocates from image dimensions.

The parser tests use CC0 synthetic fixtures in `corpus/images/`. The tiny PNG
and GIF are complete images. The TIFF files carry metadata directories without
pixel strips, the JPEG sample ends after APP1 and SOF, and the WebP samples omit
complete compressed bitstreams. Those files are structural parser inputs, not
complete decodable photos.

The image reader implementation is shared across PNG, JPEG, GIF, TIFF, and
WebP registrations. Formats with no registered reader (such as BMP and ICO)
continue to produce empty documents through the core's existing fallback.
