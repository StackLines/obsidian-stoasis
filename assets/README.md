# Visual assets

`stoasis-hero.png` and `stoasis-social-preview.png` combine an original
painted background with reproducible vector typography and a restrained
glassy title treatment. The
background was generated on 2026-10-14 with OpenAI's built-in image generation
tool from an original text prompt. No source image or third-party artwork was
provided to the generator or incorporated into the result.

The overlays and final raster images are built by `build-visuals.sh` with
ImageMagick 7 and the DejaVu Sans and DejaVu Sans Mono system fonts. Run it
from any directory:

```sh
assets/build-visuals.sh
```

The script uses the committed `stoasis-scene.jpg` as its source and writes the
two SVG overlays plus the two final PNG images in this directory. It expects
the DejaVu Sans and DejaVu Sans Mono font families to be available through the
system font configuration.

The artwork, composition and overlays are original work released under this
repository's MIT licence. Third-party tools used in their production were
OpenAI's built-in image generation tool and ImageMagick 7; DejaVu fonts are
used under their own permissive licence and are not redistributed here.
