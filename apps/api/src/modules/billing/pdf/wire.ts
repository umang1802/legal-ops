import type { DocBlock, DocModel as GenericDocModel, WireDocModel, WireImage } from '@legalops/types';
import type { ImageRef } from './layout.js';

const wire = (img: ImageRef | null): WireImage | null =>
  img ? { src: `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}` } : null;

/** The same document model with images as data URIs, so the browser can draw it (print page, format preview). */
export function toWireModel(model: GenericDocModel<ImageRef>): WireDocModel {
  const blocks = model.blocks.map((b): DocBlock<WireImage> => {
    switch (b.kind) {
      case 'header':
        return { ...b, logo: wire(b.logo) };
      case 'letterhead':
        return { ...b, logo: wire(b.logo) };
      case 'signature':
        return { ...b, image: wire(b.image) };
      default:
        return b as DocBlock<WireImage>;
    }
  });
  const wm = model.watermark;
  return {
    title: model.title,
    blocks,
    ...(model.theme ? { theme: model.theme } : {}),
    ...(model.footer ? { footer: model.footer } : {}),
    ...(wm
      ? {
          watermark:
            wm.kind === 'image'
              ? ((): WireDocModel['watermark'] => {
                  const image = wire(wm.image);
                  return image ? { ...wm, image } : undefined;
                })()
              : wm,
        }
      : {}),
  };
}
