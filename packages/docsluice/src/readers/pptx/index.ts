import type { Reader } from '../../core/reader.js';
import { openZip } from '../../zip/index.js';
import { OoxmlParts, readProperties, scanFeatures } from '../../ooxml/index.js';
import { createStructuralXmlBudget, parseSlides } from './slides.js';

const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const pptxReader: Reader = {
  id: 'pptx',
  mimeTypes: [MIME],
  async read(ctx) {
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const xmlContext = {
      budget: createStructuralXmlBudget(ctx.budget),
      warnings: ctx.warnings,
      path: ctx.path,
    };
    const parts = new OoxmlParts(archive, xmlContext);
    const features = await scanFeatures(parts, archive, xmlContext);
    if (features.hasMacros) ctx.out.setFeature('hasMacros');
    if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
    if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
    if (features.hasJavaScript) ctx.out.setFeature('hasJavaScript');
    const metadata = await readProperties(parts, xmlContext, ctx.options.metadata !== false);
    ctx.out.setMetadata(metadata);
    await parseSlides(parts, ctx);
  },
};
