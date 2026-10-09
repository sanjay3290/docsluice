# DOCX support

The DOCX reader extracts Word paragraphs in document order, including paragraphs inside tables, content controls, and text boxes. Built-in heading styles (`Heading 1` through `Heading 6`, plus `Title`), localized heading names, and custom styles with inherited outline levels become heading blocks. Hyperlinks retain their relationship target; bookmark links retain visible text. Set `runs: true` to retain bold, italic, and hyperlink details in paragraph runs.

The body is read from the `word/document.xml` part with the shared SAX XML scanner. Markup compatibility `AlternateContent` emits one branch: a supported `Choice` or its `Fallback`. Textbox paragraphs appear at their anchor position; surrounding anchor text is kept in ordered paragraph segments. Field instruction text is never returned. Lists, table block construction, images, revisions, notes, and other ancillary parts are handled by separate reader work.

XML depth and staged output are governed by the shared `Budget`. A caller's abort signal, strict warning policy, output-character limit, and XML depth limit therefore apply while scanning the DOCX body.
