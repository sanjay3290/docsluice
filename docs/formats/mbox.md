# MBOX

The MBOX reader splits envelope-delimited messages and removes one leading `>` from mboxrd-escaped `From ` body lines. Each message is passed as an `.eml` child to the shared extraction pipeline in source order, preserving the parent's budget and path.

This is a best-effort reader for the common mboxrd representation. It does not parse PST or Outlook MSG files, repair damaged envelopes, or guess message boundaries from unescaped body lines.
